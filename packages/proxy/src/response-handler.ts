import { requestEvents } from "@better-ccflare/core";
import {
	sanitizeRequestHeaders,
	withSanitizedProxyHeaders,
} from "@better-ccflare/http-common";
import type { Account } from "@better-ccflare/types";
import type { ProxyContext } from "./handlers";
import type { ChunkMessage, EndMessage, StartMessage } from "./worker-messages";

/**
 * Safely post a message to the worker, handling terminated workers
 */
function safePostMessage(
	worker: Worker,
	message: StartMessage | ChunkMessage | EndMessage,
): void {
	try {
		worker.postMessage(message);
	} catch (_error) {
		// Worker has been terminated, silently ignore
		// The error will be logged by the worker error handler in proxy.ts
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
	response: Response;
	timestamp: number;
	retryAttempt: number;
	failoverAttempts: number;
	agentUsed?: string | null;
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
		response: responseRaw,
		timestamp,
		retryAttempt, // Always 0 in new flow, but kept for message compatibility
		failoverAttempts,
		agentUsed,
	} = options;

	// Always strip compression headers *before* we do anything else
	const response = withSanitizedProxyHeaders(responseRaw);

	// Prepare objects once for serialisation - sanitize headers before storing
	const sanitizedReq = sanitizeRequestHeaders(requestHeaders);
	const requestHeadersObj = Object.fromEntries(sanitizedReq.entries());

	const responseHeadersObj = Object.fromEntries(response.headers.entries());

	const isStream = ctx.provider.isStreamingResponse?.(response) ?? false;

	// Filter out count_tokens requests for OpenAI-compatible providers from request logs and worker
	const shouldProcessRequest = !(
		ctx.provider.name === "openai-compatible" &&
		path === "/v1/messages/count_tokens"
	);

	// Send START message immediately if not filtered
	if (shouldProcessRequest) {
		const startMessage: StartMessage = {
			type: "start",
			requestId,
			accountId: account?.id || null,
			method,
			path,
			timestamp,
			requestHeaders: requestHeadersObj,
			requestBody: requestBody
				? Buffer.from(requestBody).toString("base64")
				: null,
			responseStatus: response.status,
			responseHeaders: responseHeadersObj,
			isStream,
			providerName: ctx.provider.name,
			agentUsed: agentUsed || null,
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
	 *  STREAMING RESPONSES — tee with Response.clone() and send chunks
	 *********************************************************************/
	if (isStream && response.body) {
		// For OpenAI providers, use pre-teed analytics stream if available
		// Otherwise clone the response
		const preTeedStream = (response as any).__analyticsStream;
		const analyticsClone = preTeedStream && preTeedStream instanceof ReadableStream
			? new Response(preTeedStream, {
					status: response.status,
					statusText: response.statusText,
					headers: response.headers,
				})
			: response.clone();

		(async () => {
			const STREAM_TIMEOUT_MS = 300000; // 5 minutes max stream duration
			const CHUNK_TIMEOUT_MS = 30000; // 30 seconds between chunks

			try {
				const reader = analyticsClone.body?.getReader();
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
							const chunkMsg: ChunkMessage = {
								type: "chunk",
								requestId,
								data: value,
							};
							safePostMessage(ctx.usageWorker, chunkMsg);
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
				const endMsg: EndMessage = {
					type: "end",
					requestId,
					success: isExpectedResponse(path, analyticsClone),
				};
				safePostMessage(ctx.usageWorker, endMsg);
			} catch (err) {
				const endMsg: EndMessage = {
					type: "end",
					requestId,
					success: false,
					error: (err as Error).message,
				};
				safePostMessage(ctx.usageWorker, endMsg);
			}
		})();

		// Return the sanitized response
		return response;
	}

	/*********************************************************************
	 *  NON-STREAMING RESPONSES — read body in background, send END once
	 *********************************************************************/
	(async () => {
		try {
			const clone = response.clone();
			const bodyBuf = await clone.arrayBuffer();
			const endMsg: EndMessage = {
				type: "end",
				requestId,
				responseBody:
					bodyBuf.byteLength > 0
						? Buffer.from(bodyBuf).toString("base64")
						: null,
				success: isExpectedResponse(path, clone),
			};
			safePostMessage(ctx.usageWorker, endMsg);
		} catch (err) {
			const endMsg: EndMessage = {
				type: "end",
				requestId,
				success: false,
				error: (err as Error).message,
			};
			safePostMessage(ctx.usageWorker, endMsg);
		}
	})();

	// Return the sanitized response
	return response;
}
