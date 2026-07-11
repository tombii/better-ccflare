import { requestEvents, TIME_CONSTANTS } from "@better-ccflare/core";
import {
	sanitizeRequestHeaders,
	withSanitizedProxyHeaders,
} from "@better-ccflare/http-common";
import { Logger } from "@better-ccflare/logger";
import type {
	Account,
	AgentAttributionSource,
	ProjectAttributionSource,
	RateLimitReason,
} from "@better-ccflare/types";
import type { ProxyContext } from "./handlers";
import { applyRateLimitCooldown } from "./handlers/rate-limit-cooldown";
import { createSseRateLimitSniffer } from "./handlers/sse-rate-limit-sniffer";
import { ingestModelsListing } from "./model-catalog";
import { combineChunks, teeStream } from "./stream-tee";
import { getUsageCollector } from "./usage-collector";
import {
	type EndMessage,
	isModelRewrite,
	type StartMessage,
} from "./worker-messages";

const log = new Logger("ResponseHandler");

function fireAndForgetEnd(msg: EndMessage): void {
	getUsageCollector()
		.handleEnd(msg)
		.catch((err: unknown) => {
			log.error(`handleEnd failed for request ${msg.requestId}`, err);
		});
}

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

// Must match MAX_REQUEST_BODY_BYTES in usage-collector.ts.
// Cap applied before passing to collector to avoid multi-MB copies.
// 4MB so afterburn can see full conversation history for friction analysis.
const MAX_REQUEST_BODY_BYTES = 4 * 1024 * 1024;

const MODEL_REWRITE_HEADER = "x-better-ccflare-model-rewrite";

/**
 * Builds a Headers copy with the model-rewrite header set when an
 * agent-preference rewrite actually swapped the model (originalModel and
 * appliedModel both present and different). No-op copy otherwise.
 */
function withModelRewriteHeader(
	headers: Headers,
	originalModel?: string | null,
	appliedModel?: string | null,
): Headers {
	const result = new Headers(headers);
	if (isModelRewrite(originalModel, appliedModel)) {
		result.set(MODEL_REWRITE_HEADER, `${originalModel}->${appliedModel}`);
	}
	return result;
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
	/** Raw URL query string (e.g. `?after_id=...`), used for passive model-catalog capture. */
	query?: string | null;
	projectAttributionSource?: ProjectAttributionSource | null;
	response: Response;
	timestamp: number;
	retryAttempt: number;
	failoverAttempts: number;
	agentUsed?: string | null;
	agentAttributionSource?: AgentAttributionSource | null;
	apiKeyId?: string | null;
	apiKeyName?: string | null;
	comboName?: string | null;
	originalModel?: string | null;
	appliedModel?: string | null;
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
		query,
		projectAttributionSource,
		response: responseRaw,
		timestamp,
		retryAttempt, // Always 0 in new flow, but kept for message compatibility
		failoverAttempts,
		agentUsed,
		agentAttributionSource,
		apiKeyId,
		apiKeyName,
		comboName,
		originalModel,
		appliedModel,
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
	//   - count_tokens requests on providers that synthesize or proxy advisory
	//     token counts; these aren't billable user traffic.
	//   - synthetic auto-refresh probes (issue #199, bug 2). Logging these
	//     pollutes the user-visible 503/200 metrics on the dashboard with
	//     internal scheduler activity. Header set by AutoRefreshScheduler
	//     mirrors the existing keepalive pattern.
	const isAutoRefreshProbe =
		requestHeaders.get("x-better-ccflare-auto-refresh") === "true";
	const isSyntheticCountTokens =
		path === "/v1/messages/count_tokens" &&
		(ctx.provider.name === "openai-compatible" ||
			ctx.provider.name === "codex");
	const shouldProcessRequest = !isSyntheticCountTokens && !isAutoRefreshProbe;

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
			projectAttributionSource: projectAttributionSource ?? "none",
			agentAttributionSource: agentAttributionSource ?? "none",
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
			// Persist the pair only for an actual swap — an agent-detected but
			// unmodified request would otherwise record two equal values that
			// downstream cannot distinguish from a real rewrite.
			originalModel: isModelRewrite(originalModel, appliedModel)
				? (originalModel as string)
				: null,
			appliedModel: isModelRewrite(originalModel, appliedModel)
				? (appliedModel as string)
				: null,
			comboName: comboName || null,
			apiKeyId: apiKeyId || null,
			apiKeyName: apiKeyName || null,
			retryAttempt,
			failoverAttempts,
		};
		getUsageCollector().handleStart(startMessage);
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
			agentAttributionSource: agentAttributionSource ?? "none",
		});
	}

	/*********************************************************************
	 *  STREAMING RESPONSES — wrap body with teeStream for inline analytics
	 *********************************************************************/
	if (isStream && response.body) {
		// Mid-stream rate-limit detection for issue #114 Fix 1.2. Only
		// create a sniffer when we know which account to mark — anonymous
		// or unauthenticated requests can't be failed over.
		const rateLimitSniffer = account
			? createSseRateLimitSniffer({ provider: account.provider })
			: null;

		const onChunk = (value: Uint8Array): void => {
			if (shouldProcessRequest) {
				getUsageCollector().handleChunk(requestId, value);
			}

			// Mid-stream rate-limit detection. The sniffer
			// fires exactly once; after that feed() is a no-op.
			if (account && rateLimitSniffer?.feed(value)) {
				// Map firedReason to the correct RateLimitReason:
				//   "overloaded_error" → upstream_529_overloaded_with_reset
				//   "rate_limit_error" → upstream_429_with_reset
				const midStreamReason: RateLimitReason =
					rateLimitSniffer.firedReason === "overloaded_error"
						? "upstream_529_overloaded_with_reset"
						: "upstream_429_with_reset";
				applyRateLimitCooldown(
					account,
					{
						resetTime: Date.now() + getMidStreamRateLimitCooldownMs(),
						reason: midStreamReason,
					},
					ctx,
				);
			}
		};

		const onClose = (_buffered: Uint8Array[]): void => {
			if (shouldProcessRequest) {
				const endMsg: EndMessage = {
					type: "end",
					requestId,
					success: isExpectedResponse(path, response),
				};
				// Fire-and-forget: handleEnd is async for DB writes but we don't block streaming
				fireAndForgetEnd(endMsg);
			}
		};

		const onError = (err: Error): void => {
			if (shouldProcessRequest) {
				const endMsg: EndMessage = {
					type: "end",
					requestId,
					success: false,
					error: err.message,
				};
				fireAndForgetEnd(endMsg);
			}
		};

		const passthroughBody = teeStream(response.body, {
			onChunk,
			onClose,
			onError,
		});

		return new Response(passthroughBody, {
			status: response.status,
			statusText: response.statusText,
			headers: withModelRewriteHeader(
				response.headers,
				originalModel,
				appliedModel,
			),
		});
	}

	/*********************************************************************
	 *  NON-STREAMING RESPONSES — read body in background, send END once
	 *********************************************************************/
	if (!response.body) {
		if (shouldProcessRequest) {
			fireAndForgetEnd({
				type: "end",
				requestId,
				responseBody: null,
				success: isExpectedResponse(path, response),
			});
		}

		if (isModelRewrite(originalModel, appliedModel)) {
			return new Response(null, {
				status: response.status,
				statusText: response.statusText,
				headers: withModelRewriteHeader(
					response.headers,
					originalModel,
					appliedModel,
				),
			});
		}

		return response;
	}

	const MAX_NON_STREAM_BODY_BYTES = 256 * 1024; // 256KB cap for stored body

	const passthroughBody = teeStream(response.body, {
		maxBytes: MAX_NON_STREAM_BODY_BYTES,
		onClose(buffered) {
			// Hoisted above the shouldProcessRequest filter: passive model-catalog
			// capture is independent of the analytics/logging filter above (it's
			// not analytics, and must still run e.g. for a filtered synthetic
			// request that nonetheless carries a real GET /v1/models response).
			const cappedBuf = combineChunks(buffered);

			if (
				method === "GET" &&
				path === "/v1/models" &&
				response.status === 200 &&
				account
			) {
				void ingestModelsListing(cappedBuf.toString("utf-8"), account, query);
			}

			if (!shouldProcessRequest) return;
			fireAndForgetEnd({
				type: "end",
				requestId,
				responseBody:
					cappedBuf.byteLength > 0 ? cappedBuf.toString("base64") : null,
				success: isExpectedResponse(path, response),
			});
		},
		onError(err) {
			if (!shouldProcessRequest) return;
			fireAndForgetEnd({
				type: "end",
				requestId,
				success: false,
				error: err.message,
			});
		},
	});

	return new Response(passthroughBody, {
		status: response.status,
		statusText: response.statusText,
		headers: withModelRewriteHeader(
			response.headers,
			originalModel,
			appliedModel,
		),
	});
}
