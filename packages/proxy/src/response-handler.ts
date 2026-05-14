import { requestEvents, TIME_CONSTANTS } from "@better-ccflare/core";
import {
	sanitizeRequestHeaders,
	withSanitizedProxyHeaders,
} from "@better-ccflare/http-common";
import { ANALYTICS_STREAM_SYMBOL } from "@better-ccflare/http-common/symbols";
import type { Account } from "@better-ccflare/types";
import type { ProxyContext } from "./handlers";
import { applyRateLimitCooldown } from "./handlers/rate-limit-cooldown";
import { createSseRateLimitSniffer } from "./handlers/sse-rate-limit-sniffer";
import type { UsageWorkerController } from "./usage-worker-controller";
import type { ChunkMessage, EndMessage, StartMessage } from "./worker-messages";

type ResponseWithAnalyticsStream = Response & {
	[ANALYTICS_STREAM_SYMBOL]?: ReadableStream<Uint8Array>;
};

// Default cooldown for rate-limit errors detected mid-stream. SSE error
// frames don't carry reset headers (HTTP headers were sent before the
// error occurred), so we fall back to the same probe-friendly default
// that response-processor.ts uses for headerless 429 responses.
//
// Read on every call (not module load) so a runtime change to the env
// var is picked up without a server restart. Use `||` (not `??`) so an
// empty-string env value (Number("") === 0) falls through to the default
// instead of silently disabling the cooldown.
function getMidStreamRateLimitCooldownMs(): number {
	return (
		Number(process.env.CCFLARE_DEFAULT_COOLDOWN_NO_RESET_MS) ||
		TIME_CONSTANTS.DEFAULT_RATE_LIMIT_NO_RESET_COOLDOWN_MS
	);
}

// Must match MAX_REQUEST_BODY_BYTES in post-processor.worker.ts.
// Cap applied before postMessage to avoid multi-MB structured clones.
// 4MB so afterburn can see full conversation history for friction analysis.
const MAX_REQUEST_BODY_BYTES = 4 * 1024 * 1024;

function safePostMessage(
	worker: UsageWorkerController,
	message: StartMessage | ChunkMessage | EndMessage,
): void {
	try {
		worker.postMessage(message);
	} catch (_error) {
		// Worker not ready or terminated — silently ignore
	}
}

/**
 * Check if a response should be considered successful/expected
 * Treats certain well-known paths that return 404 as expected
 */
function isExpectedResponse(path: string, response: Response): boolean {
	// Any .well-known path returning 404 is expected
	if (path.startsWith("/.well-known/") && response.status === 404) {
		return true;
	}

	// Otherwise use standard HTTP success logic
	return response.ok;
}

export interface ResponseHandlerOptions {
	requestId: string;
	method: string;
	path: string;
	account: Account | null;
	requestHeaders: Headers;
	requestBody: ArrayBuffer | null;
	project?: string | null;
	response: Response;
	timestamp: number;
	retryAttempt: number;
	failoverAttempts: number;
	agentUsed?: string | null;
	apiKeyId?: string | null;
	apiKeyName?: string | null;
	comboName?: string | null;
}

/**
 * Unified response handler that immediately streams responses
 * while forwarding data to worker for async processing
 */
// Forward response to client while streaming analytics to worker
export async function forwardToClient(
	options: ResponseHandlerOptions,
	ctx: ProxyContext,
): Promise<Response> {
	const {
		requestId,
		method,
		path,
		account,
		requestHeaders,
		requestBody,
		project,
		response: responseRaw,
		timestamp,
		retryAttempt, // Always 0 in new flow, but kept for message compatibility
		failoverAttempts,
		agentUsed,
		apiKeyId,
		apiKeyName,
		comboName,
	} = options;

	// Always strip compression headers *before* we do anything else
	const response = withSanitizedProxyHeaders(responseRaw);

	// Prepare objects once for serialisation - sanitize headers before storing
	const sanitizedReq = sanitizeRequestHeaders(requestHeaders);
	const requestHeadersObj = Object.fromEntries(sanitizedReq.entries());

	const responseHeadersObj = Object.fromEntries(response.headers.entries());

	const isStream = ctx.provider.isStreamingResponse?.(response) ?? false;
	const shouldStorePayloads = ctx.config.getStorePayloads?.() ?? true;

	// Filter out:
	//   - count_tokens requests on OpenAI-compatible providers (existing
	//     filter — these aren't billable user traffic).
	//   - synthetic auto-refresh probes (issue #199, bug 2). Logging these
	//     pollutes the user-visible 503/200 metrics on the dashboard with
	//     internal scheduler activity. Header set by AutoRefreshScheduler
	//     mirrors the existing keepalive pattern.
	const isAutoRefreshProbe =
		requestHeaders.get("x-better-ccflare-auto-refresh") === "true";
	const shouldProcessRequest =
		!(
			ctx.provider.name === "openai-compatible" &&
			path === "/v1/messages/count_tokens"
		) && !isAutoRefreshProbe;

	// Send START message immediately if not filtered
	if (shouldProcessRequest) {
		const startMessage: StartMessage = {
			type: "start",
			messageId: crypto.randomUUID(),
			requestId,
			accountId: account?.id || null,
			method,
			path,
			timestamp,
			requestHeaders: requestHeadersObj,
			requestBody:
				shouldStorePayloads && requestBody
					? Buffer.from(
							new Uint8Array(requestBody).subarray(
								0,
								Math.min(requestBody.byteLength, MAX_REQUEST_BODY_BYTES),
							),
						).toString("base64")
					: null,
			project: project ?? null,
			responseStatus: response.status,
			responseHeaders: responseHeadersObj,
			isStream,
			providerName: ctx.provider.name,
			accountBillingType: account?.billing_type ?? null,
			accountAutoPauseOnOverageEnabled: account?.auto_pause_on_overage_enabled
				? 1
				: 0,
			accountName: account?.name ?? null,
			agentUsed: agentUsed || null,
			comboName: comboName || null,
			apiKeyId: apiKeyId || null,
			apiKeyName: apiKeyName || null,
			retryAttempt,
			failoverAttempts,
		};
		safePostMessage(ctx.usageWorker, startMessage);
	}

	// Emit request start event for real-time dashboard
	if (shouldProcessRequest) {
		requestEvents.emit("event", {
			type: "start",
			id: requestId,
			timestamp,
			method,
			path,
			accountId: account?.id || null,
			statusCode: response.status,
			agentUsed: agentUsed || null,
		});
	}

	/*********************************************************************
	 *  STREAMING RESPONSES — tee the body and send analytics chunks
	 *********************************************************************/
	if (isStream && response.body) {
		let clientResponse = response;

		// For OpenAI providers, use pre-teed analytics stream if available.
		// Otherwise tee the sanitized response body to avoid Response.clone().
		const preTeedStream = (response as ResponseWithAnalyticsStream)[
			ANALYTICS_STREAM_SYMBOL
		];
		let analyticsStream: ReadableStream<Uint8Array>;
		if (preTeedStream && preTeedStream instanceof ReadableStream) {
			analyticsStream = preTeedStream;
		} else {
			const [clientStream, analyticsBranch] = response.body.tee();
			clientResponse = new Response(clientStream, {
				status: response.status,
				statusText: response.statusText,
				headers: response.headers,
			});
			analyticsStream = analyticsBranch;
		}
		const analyticsResponse = new Response(analyticsStream, {
			status: response.status,
			statusText: response.statusText,
			headers: response.headers,
		});

		// Mid-stream rate-limit detection for issue #114 Fix 1.2. Only
		// create a sniffer when we know which account to mark — anonymous
		// or unauthenticated requests can't be failed over.
		const rateLimitSniffer = account ? createSseRateLimitSniffer() : null;

		(async () => {
			// Configurable via env vars to support long agentic workloads where
			// nested sub-calls (e.g. recursive claude-code-sdk sessions) can leave
			// the outer stream silent for extended periods (issue #84).
			const STREAM_TIMEOUT_MS = Number(
				process.env.CF_STREAM_TOTAL_TIMEOUT_MS ??
					TIME_CONSTANTS.STREAM_FORWARD_TOTAL_TIMEOUT_MS,
			);
			const CHUNK_TIMEOUT_MS = Number(
				process.env.CF_STREAM_CHUNK_TIMEOUT_MS ??
					TIME_CONSTANTS.STREAM_FORWARD_CHUNK_TIMEOUT_MS,
			);

			try {
				const reader = analyticsResponse.body?.getReader();
				if (!reader) return; // Safety check

				const startTime = Date.now();
				let lastChunkTime = Date.now();

				// eslint-disable-next-line no-constant-condition
				while (true) {
					// Check for overall stream timeout
					if (Date.now() - startTime > STREAM_TIMEOUT_MS) {
						await reader.cancel();
						throw new Error(
							`Stream timeout: exceeded ${STREAM_TIMEOUT_MS}ms total duration`,
						);
					}

					// Check for chunk timeout (no data received)
					if (Date.now() - lastChunkTime > CHUNK_TIMEOUT_MS) {
						await reader.cancel();
						throw new Error(
							`Stream timeout: no data received for ${CHUNK_TIMEOUT_MS}ms`,
						);
					}

					// Read with a timeout wrapper that properly cleans up
					const readPromise = reader.read();
					let timeoutId: Timer | null = null;
					const timeoutPromise = new Promise<{
						value?: Uint8Array;
						done: boolean;
					}>((_, reject) => {
						timeoutId = setTimeout(
							() => reject(new Error("Read operation timeout")),
							CHUNK_TIMEOUT_MS,
						);
					});

					try {
						const { value, done } = await Promise.race([
							readPromise,
							timeoutPromise,
						]);

						// Clear timeout if race completed successfully
						if (timeoutId) {
							clearTimeout(timeoutId);
							timeoutId = null;
						}

						if (done) break;

						if (value) {
							lastChunkTime = Date.now();
							if (shouldProcessRequest) {
								const chunkMsg: ChunkMessage = {
									type: "chunk",
									requestId,
									data: value,
								};
								safePostMessage(ctx.usageWorker, chunkMsg);
							}

							// Mid-stream rate-limit detection. The sniffer
							// fires exactly once; after that feed() is a no-op.
							if (account && rateLimitSniffer?.feed(value)) {
								applyRateLimitCooldown(
									account,
									{
										resetTime: Date.now() + getMidStreamRateLimitCooldownMs(),
									},
									ctx,
								);
							}
						}
					} catch (error) {
						// Ensure timeout is cleared on error
						if (timeoutId) {
							clearTimeout(timeoutId);
							timeoutId = null;
						}
						throw error;
					}
				}
				// Finished without errors
				if (shouldProcessRequest) {
					const endMsg: EndMessage = {
						type: "end",
						requestId,
						success: isExpectedResponse(path, analyticsResponse),
					};
					safePostMessage(ctx.usageWorker, endMsg);
				}
			} catch (err) {
				if (shouldProcessRequest) {
					const endMsg: EndMessage = {
						type: "end",
						requestId,
						success: false,
						error: (err as Error).message,
					};
					safePostMessage(ctx.usageWorker, endMsg);
				}
			}
		})();

		// Return the sanitized response backed by the client stream branch.
		return clientResponse;
	}

	/*********************************************************************
	 *  NON-STREAMING RESPONSES — read body in background, send END once
	 *********************************************************************/
	if (!response.body) {
		if (shouldProcessRequest) {
			const endMsg: EndMessage = {
				type: "end",
				requestId,
				responseBody: null,
				success: isExpectedResponse(path, response),
			};
			safePostMessage(ctx.usageWorker, endMsg);
		}

		return response;
	}

	const [clientStream, analyticsStream] = response.body.tee();
	const clientResponse = new Response(clientStream, {
		status: response.status,
		statusText: response.statusText,
		headers: response.headers,
	});
	const analyticsResponse = new Response(analyticsStream, {
		status: response.status,
		statusText: response.statusText,
		headers: response.headers,
	});

	(async () => {
		const MAX_NON_STREAM_BODY_BYTES = 256 * 1024; // 256KB cap for stored body
		try {
			// Read body via stream, stopping once the cap is reached to avoid
			// loading an unbounded response into memory before truncation.
			const reader = analyticsResponse.body?.getReader();
			let cappedBuf: Buffer;
			if (!reader) {
				cappedBuf = Buffer.alloc(0);
			} else {
				const chunks: Uint8Array[] = [];
				let bytesRead = 0;
				while (bytesRead < MAX_NON_STREAM_BODY_BYTES) {
					const { value, done } = await reader.read();
					if (done) break;
					const remaining = MAX_NON_STREAM_BODY_BYTES - bytesRead;
					if (value.length <= remaining) {
						chunks.push(value);
						bytesRead += value.length;
					} else {
						chunks.push(value.slice(0, remaining));
						bytesRead += remaining;
						await reader.cancel();
						break;
					}
				}
				cappedBuf = Buffer.concat(chunks);
			}
			if (shouldProcessRequest) {
				const endMsg: EndMessage = {
					type: "end",
					requestId,
					responseBody:
						cappedBuf.byteLength > 0 ? cappedBuf.toString("base64") : null,
					success: isExpectedResponse(path, analyticsResponse),
				};
				safePostMessage(ctx.usageWorker, endMsg);
			}
		} catch (err) {
			if (shouldProcessRequest) {
				const endMsg: EndMessage = {
					type: "end",
					requestId,
					success: false,
					error: (err as Error).message,
				};
				safePostMessage(ctx.usageWorker, endMsg);
			}
		}
	})();

	// Return the sanitized response
	return clientResponse;
}
