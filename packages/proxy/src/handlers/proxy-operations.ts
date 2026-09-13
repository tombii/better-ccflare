import { createHash } from "node:crypto";
import {
	type AccountUsageSnapshot,
	getModelFamily,
	getModelList,
	getOverloadRetryConfig,
	getServerErrorRetryEnabled,
	isUsageExhausted,
	logError,
	ProviderError,
	TIME_CONSTANTS,
} from "@better-ccflare/core";
import { withSanitizedProxyHeaders } from "@better-ccflare/http-common";
import { Logger } from "@better-ccflare/logger";
import { stripCacheControlFromOpenAIRequest } from "@better-ccflare/openai-formats";
import {
	type AnyUsageData,
	applyXaiConvIdHeader,
	getProvider,
	isAnthropicExtraUsageExhausted,
	isAnthropicOrgPermissionDenied,
	isAnthropicOutOfCredits,
	recoverCodexMessagesContinuation,
	usageCache,
} from "@better-ccflare/providers";
import type {
	Account,
	RateLimitReason,
	RequestMeta,
} from "@better-ccflare/types";
import { cacheBodyStore } from "../cache-body-store";
import { ensureCodexModelDefaults } from "../codex-model-catalog";
import { RequestBodyContext } from "../request-body-context";
import { forwardToClient } from "../response-handler";
import { isModelRewrite } from "../worker-messages";
import { applyAccountRequestTransformer } from "./account-request-transformer";
import { getXaiConvId } from "./account-selector";
import { markFamilyExhausted } from "./model-capacity";
import { forwardObservedUpstream } from "./observed-upstream";
import {
	ERROR_MESSAGES,
	isInternalProbe,
	isTrustedNativeResponses,
	type ProxyContext,
} from "./proxy-types";
import { applyRateLimitCooldown } from "./rate-limit-cooldown";
import { makeProxyRequest, validateProviderPath } from "./request-handler";
import { handleProxyError, processProxyResponse } from "./response-processor";
import { isRetryable429 } from "./retryable-429";
import { getValidAccessToken } from "./token-manager";
import { collectWindows } from "./usage-throttling";
import { peekSseForZai1305 } from "./zai-1305";

const log = new Logger("ProxyOperations");

import { cancelDiscardedResponseBody } from "./discard-body-cancel";

const SYNTHETIC_RESPONSE_HEADER = "x-better-ccflare-synthetic-response";
const SYNTHETIC_STATUS_HEADER = "x-better-ccflare-synthetic-status";
const SYNTHETIC_RESPONSE_URL_PREFIX = "https://better-ccflare.local/";

/**
 * Diagnose-only lookup of the family's current weekly_scoped utilization
 * percent from cached usage telemetry, used purely to log what the last
 * poll knew when a reactive out_of_credits mark is recorded — never a gate.
 */
function currentScopedPercentForFamily(
	usageData: AnyUsageData | null,
	family: string,
): number | null {
	for (const window of collectWindows(usageData)) {
		if (window.scoped && window.modelFamily === family) {
			return window.utilization;
		}
	}
	return null;
}

/**
 * Determines the absolute epoch timestamp (ms since epoch) until which an account
 * should be marked rate-limited after model exhaustion. Priority:
 *   1. retry-after / x-ratelimit-reset response header (actual upstream backoff)
 *   2. getRateLimitedUntil — usage-window reset time if known
 *   3. probe-cooldown default (TIME_CONSTANTS.DEFAULT_RATE_LIMIT_NO_RESET_COOLDOWN_MS,
 *      60s by default, overridable via CCFLARE_DEFAULT_COOLDOWN_NO_RESET_MS) as
 *      last resort. Was a 1-hour ban prior to v3.5.x — that locked accounts
 *      out unnecessarily when upstream returned a transient 429 without a
 *      reset hint, draining small pools to zero routable accounts on a
 *      single burst. Aligns with the same default used in
 *      response-processor.ts when 429s arrive without a reset header.
 *
 * The result is always clamped to at least 60 seconds in the future to avoid a
 * zero or negative value when a parsed timestamp is already in the past.
 *
 * NOTE: getRateLimitedUntil is injected rather than called directly on usageCache
 * so that callers in production pass usageCache.getRateLimitedUntil.bind(usageCache)
 * and tests pass a plain stub — avoiding module-mock symlink issues with Bun.
 */
export function extractCooldownUntil(
	response: Response,
	accountId: string,
	getRateLimitedUntil: (accountId: string) => number | null,
): number {
	const MIN_COOLDOWN_MS = 60 * 1000; // 60 seconds floor
	// Use `||` (not `??`) so empty-string and non-numeric env values
	// (Number("") === 0, Number("abc") === NaN) fall through to the
	// default — `??` would coalesce the empty string to 0 and silently
	// disable the cooldown entirely.
	const DEFAULT_COOLDOWN_MS =
		Number(process.env.CCFLARE_DEFAULT_COOLDOWN_NO_RESET_MS) ||
		TIME_CONSTANTS.DEFAULT_RATE_LIMIT_NO_RESET_COOLDOWN_MS;
	const now = Date.now();

	// 1. Check retry-after / x-ratelimit-reset headers
	const retryAfter =
		response.headers.get("retry-after") ??
		response.headers.get("x-ratelimit-reset");
	if (retryAfter) {
		const parsed = Number(retryAfter);
		if (!Number.isNaN(parsed) && parsed > 0) {
			// Unix timestamp (seconds) if value looks like an epoch (> 1 billion)
			const isUnixTimestamp = parsed > 1_000_000_000;
			const epochMs = isUnixTimestamp ? parsed * 1000 : now + parsed * 1000;
			if (epochMs > now) {
				return Math.max(epochMs, now + MIN_COOLDOWN_MS);
			}
			// epochMs <= now: stale/already-past timestamp — fall through to next priority
		} else {
			// Try HTTP-date format (RFC 7231), e.g. "Wed, 21 Oct 2026 07:28:00 GMT"
			const dateMs = new Date(retryAfter).getTime();
			if (!Number.isNaN(dateMs) && dateMs > now) {
				return Math.max(dateMs, now + MIN_COOLDOWN_MS);
			}
			// Invalid or past date — fall through to next priority
		}
	}

	// 2. Fall back to usage-window reset time if available
	const rateLimitedUntil = getRateLimitedUntil(accountId);
	if (rateLimitedUntil !== null && rateLimitedUntil > now) {
		return Math.max(rateLimitedUntil, now + MIN_COOLDOWN_MS);
	}

	// 3. Last resort: 1 hour
	return now + DEFAULT_COOLDOWN_MS;
}

/**
 * HTTP statuses treated as a transient upstream server error: the upstream (or
 * the organization behind the account) failed to serve the request, and a
 * different account may well succeed. 529 is deliberately absent — Anthropic's
 * overload has its own retry loop, cooldown and audit reason.
 */
const TRANSIENT_SERVER_ERROR_STATUSES = new Set([500, 502, 503, 504]);

function isTransientServerErrorStatus(status: number): boolean {
	return TRANSIENT_SERVER_ERROR_STATUSES.has(status);
}

/**
 * Answered by an upstream-error classification handler that has nothing to say
 * about the response it was given, so the caller keeps going.
 *
 * A sentinel rather than a `{ handled: boolean }` wrapper because BOTH other
 * outcomes are meaningful values the caller returns verbatim: `null` means
 * "already benched/recorded, fail over to the next account" and a `Response`
 * means "hand this to the client". Wrapping them would force every extracted
 * handler body to be rewritten around a new return shape; with the sentinel the
 * bodies are the code they replaced, character for character — including the
 * `cancelDiscardedResponseBody(rawResponse); return null;` pairs that the issue
 * #273 static call-site check in `bun-leak-273-regression.test.ts` greps for.
 */
const NOT_CLASSIFIED: unique symbol = Symbol("upstream-error-not-classified");

/**
 * What a handler in the upstream-error classification chain answers: a response
 * to return to the client, `null` to fail over, or {@link NOT_CLASSIFIED}.
 */
type UpstreamErrorClassification = Response | null | typeof NOT_CLASSIFIED;

/**
 * Absolute epoch (ms) a `Retry-After` header asks us to wait until, for both
 * RFC 7231 forms (delta-seconds and HTTP-date). Returns null when the header is
 * absent, unparseable, or already in the past — a stale value must not shorten
 * the caller's own cooldown to nothing.
 */
function parseRetryAfterUntil(
	response: Response,
	nowMs: number,
): number | null {
	const raw = response.headers.get("retry-after");
	if (!raw) return null;
	const seconds = Number(raw);
	if (Number.isFinite(seconds)) {
		if (seconds <= 0) return null;
		return nowMs + seconds * 1000;
	}
	const dateMs = new Date(raw).getTime();
	if (Number.isFinite(dateMs) && dateMs > nowMs) return dateMs;
	return null;
}

/**
 * Some providers return a synthetic Request containing the provider response
 * payload (instead of a real URL to fetch). Detect and unwrap those requests so
 * we don't try to fetch fake hosts. Bedrock's historical x-bedrock-response
 * marker is kept for compatibility; newer providers use the generic marker.
 */
function isSyntheticProviderResponse(request: Request): boolean {
	return (
		(request.headers.get("x-bedrock-response") === "true" &&
			request.url.startsWith("https://bedrock.aws/response")) ||
		(request.headers.get(SYNTHETIC_RESPONSE_HEADER) === "true" &&
			request.url.startsWith(SYNTHETIC_RESPONSE_URL_PREFIX))
	);
}

function parseSyntheticStatus(request: Request): number {
	const status = Number.parseInt(
		request.headers.get(SYNTHETIC_STATUS_HEADER) ?? "200",
		10,
	);
	return Number.isInteger(status) && status >= 200 && status <= 599
		? status
		: 200;
}

function materializeSyntheticResponse(request: Request): Response {
	const headers = new Headers();
	const contentType = request.headers.get("content-type");
	const cacheControl = request.headers.get("cache-control");
	if (contentType) headers.set("content-type", contentType);
	if (cacheControl) headers.set("cache-control", cacheControl);
	if (request.headers.get(SYNTHETIC_RESPONSE_HEADER) === "true") {
		headers.set(SYNTHETIC_RESPONSE_HEADER, "true");
	}

	return new Response(request.body, {
		status: parseSyntheticStatus(request),
		headers,
	});
}

/**
 * Filters thinking blocks from request body
 * Used when Claude rejects thinking blocks with invalid signatures from other providers
 * @param requestBodyBuffer - The original request body buffer
 * @returns New buffer with thinking blocks filtered out, or null if filtering fails
 */
function filterThinkingBlocks(
	requestBody: ArrayBuffer | RequestBodyContext | null,
): ArrayBuffer | null {
	const bodyContext =
		requestBody instanceof RequestBodyContext
			? requestBody
			: new RequestBodyContext(requestBody);
	const requestBodyBuffer = bodyContext.getBuffer();
	if (!requestBodyBuffer) return null;

	try {
		const body = bodyContext.getParsedJson();
		if (!body) return null;

		// Only process if there are messages
		if (!body.messages || !Array.isArray(body.messages)) {
			return requestBodyBuffer;
		}

		let hasChanges = false;

		// Filter out thinking blocks from message content and track which messages were modified
		const processedMessages = body.messages.map(
			(
				msg: {
					role: string;
					content: string | Array<{ type: string; [key: string]: unknown }>;
				},
				index: number,
			) => {
				// Only process assistant messages with array content
				if (msg.role !== "assistant" || !Array.isArray(msg.content)) {
					return { msg, isEmpty: false, hadThinking: false, index };
				}

				// Check if this message has thinking blocks
				const hadThinkingBlock = msg.content.some(
					(block: { type: string }) => block.type === "thinking",
				);

				// Filter out thinking blocks
				const filteredContent = msg.content.filter(
					(block: { type: string; [key: string]: unknown }) => {
						if (block.type === "thinking") {
							hasChanges = true;
							return false;
						}
						return true;
					},
				);

				// Check if message is now effectively empty
				const isEmpty =
					filteredContent.length === 0 ||
					(filteredContent.length === 1 &&
						filteredContent[0].type === "text" &&
						(!filteredContent[0].text || filteredContent[0].text === ""));

				return {
					msg: {
						...msg,
						content: filteredContent.length > 0 ? filteredContent : msg.content,
					},
					isEmpty,
					hadThinking: hadThinkingBlock,
					index,
				};
			},
		);

		// Just filter out thinking blocks and keep all messages
		const filteredMessages = processedMessages
			.filter(
				(item: {
					msg: {
						role: string;
						content: string | Array<{ type: string; [key: string]: unknown }>;
					};
					isEmpty: boolean;
					hadThinking: boolean;
					index: number;
				}) => {
					// Remove empty messages
					if (item.isEmpty) return false;
					return true;
				},
			)
			.map(
				(item: {
					msg: {
						role: string;
						content: string | Array<{ type: string; [key: string]: unknown }>;
					};
					isEmpty: boolean;
					hadThinking: boolean;
					index: number;
				}) => item.msg,
			);

		// Only create new buffer if we made changes
		if (hasChanges) {
			const warningMessage =
				"Disabled thinking mode due to incompatible thinking blocks from previous provider. Conversation context preserved.";
			log.info(warningMessage);

			const filteredBody = {
				...body,
				messages: filteredMessages,
				// Disable thinking mode since we removed thinking blocks
				// This prevents Claude from requiring the final message to start with thinking
				thinking: undefined,
			};
			return RequestBodyContext.fromParsed(
				requestBodyBuffer,
				filteredBody,
			).getBuffer();
		}

		return requestBodyBuffer;
	} catch (error) {
		log.warn("Failed to filter thinking blocks:", error);
		return null;
	}
}

/**
 * Checks if a response error is due to invalid thinking block signatures or thinking-related errors
 * @param response - The response to check
 * @returns True if the error is about invalid thinking blocks
 */
async function isInvalidThinkingSignatureError(
	response: Response,
): Promise<boolean> {
	if (response.status !== 400) return false;

	try {
		const contentType = response.headers.get("content-type");

		if (!contentType?.includes("application/json")) return false;

		// Cloned only here, after the content-type gate. Cloning before it teed
		// the body and then returned early for every non-JSON body, stranding
		// that copy unread — the tee keeps buffering for whoever consumes the
		// original. Reachable in normal operation: providers such as Qwen do
		// return non-JSON error bodies. See issue #356.
		const json = await response.clone().json();

		// Check for Claude's thinking-related errors
		if (json.error?.message && typeof json.error.message === "string") {
			const message = json.error.message;
			// Check for invalid signature error
			if (message.includes("Invalid `signature` in `thinking` block")) {
				return true;
			}
			// Check for final message must start with thinking block error
			if (
				message.includes(
					"final `assistant` message must start with a thinking block",
				)
			) {
				return true;
			}
		}
	} catch {
		// Ignore parse errors
	}

	return false;
}

/**
 * In-memory set of (accountId, model) pairs known to reject cache_control.
 * Populated on first 400 rejection; cleared on server restart (fast re-learn).
 */
const cacheControlRejectors = new Set<string>();

function cacheControlRejectorKey(accountId: string, model: string): string {
	return `${accountId}:${model}`;
}

/**
 * Checks if a 400 response is caused by an upstream provider rejecting the
 * cache_control field (e.g. GLM-5.1 strict OpenAI-compatible validation).
 */
async function isCacheControlRejectionError(
	response: Response,
): Promise<boolean> {
	if (response.status !== 400) return false;

	try {
		const contentType = response.headers.get("content-type");
		if (!contentType?.includes("application/json")) return false;

		// Cloned only here, after the content-type gate. Cloning before it teed
		// the body and then returned early for every non-JSON body, stranding
		// that copy unread — the tee keeps buffering for whoever consumes the
		// original. Reachable in normal operation: providers such as Qwen do
		// return non-JSON error bodies. See issue #356.
		const json = await response.clone().json();
		const message: string = json.error?.message ?? json.message ?? "";
		return (
			typeof message === "string" &&
			message.includes("cache_control") &&
			(message.includes("Extra inputs are not permitted") ||
				message.includes("unknown field"))
		);
	} catch {
		return false;
	}
}

/**
 * Checks if a response error indicates the requested model is unavailable.
 * Covers Anthropic (not_found_error), OpenAI-compat (model_not_found),
 * generic messages, and Bedrock (ResourceNotFoundException).
 */
export async function isModelUnavailableError(
	response: Response,
): Promise<boolean> {
	if (
		response.status !== 404 &&
		response.status !== 400 &&
		response.status !== 429
	)
		return false;

	// 429s always trigger slot failover regardless of content-type.
	// Providers like Qwen return 429 without application/json bodies, and
	// the content-type guard below would otherwise short-circuit before reaching
	// this check, causing the 429 to be forwarded to the client instead of
	// failing over to the next combo slot.
	if (response.status === 429) {
		return true;
	}

	try {
		const contentType = response.headers.get("content-type");
		if (!contentType?.includes("application/json")) return false;

		// Cloned only here, after the content-type gate. Cloning before it teed
		// the body and then returned early for every non-JSON body, stranding
		// that copy unread — the tee keeps buffering for whoever consumes the
		// original. Reachable in normal operation: providers such as Qwen do
		// return non-JSON error bodies. See issue #356.
		const json = await response.clone().json();

		// Anthropic native format
		if (json.error?.type === "not_found_error") return true;

		// OpenAI-compat format
		if (json.error?.code === "model_not_found") return true;

		// Generic: message contains "model not found" or "does not exist"
		if (
			json.error?.message &&
			typeof json.error.message === "string" &&
			(json.error.message.toLowerCase().includes("model not found") ||
				json.error.message.toLowerCase().includes("does not exist"))
		) {
			return true;
		}

		// Bedrock: ResourceNotFoundException
		if (
			json.error?.message &&
			typeof json.error.message === "string" &&
			json.error.message.includes("ResourceNotFoundException")
		) {
			return true;
		}

		// Codex/ChatGPT-backend format: message sits on a top-level "detail"
		// field rather than under "error". See issue #393 — e.g.
		// {"detail": "The 'gpt-5.3-codex' model is not supported when using
		// Codex with a ChatGPT account."}
		if (
			typeof json.detail === "string" &&
			json.detail.toLowerCase().includes("model") &&
			(json.detail.toLowerCase().includes("not supported") ||
				json.detail.toLowerCase().includes("not found") ||
				json.detail.toLowerCase().includes("does not exist"))
		) {
			return true;
		}
	} catch {
		// Ignore parse errors
	}

	return false;
}

/**
 * Detects ZAI error 1305 ("service overloaded") inside an SSE stream.
 * ZAI returns HTTP 200 with content-type: text/event-stream, but the SSE body
 * contains an error event with code 1305. This function:
 *   1. Peeks at the leading bytes of the SSE stream (via clone, original preserved)
 *   2. If 1305 + "overloaded" found - retries the request with backoff (up to 2 attempts)
 *   3. If retries also return 1305 - converts to a synthetic 429 so isModelUnavailableError
 *      triggers model fallback (e.g. glm-5.2 -> glm-4.7)
 *   4. If no 1305 - returns the original response unchanged
 */
async function checkZai1305(
	response: Response,
	account: Account,
	requestClone: Request,
	log: Logger,
): Promise<Response> {
	if (
		response.status !== 200 ||
		account.provider !== "zai" ||
		!response.headers.get("content-type")?.includes("text/event-stream")
	) {
		return response;
	}

	const has1305 = await peekSseForZai1305(response);

	if (!has1305) {
		return response;
	}

	log.warn(
		`Account ${account.name}: detected 1305 overloaded in SSE stream, retrying`,
	);

	// The 1305 detection above only consumed a clone; drain the original
	// now that we've decided not to forward it, so its native backing
	// buffer is released instead of leaking (issue #382/#437).
	cancelDiscardedResponseBody(response);

	// Retry with backoff (same config as 529 retry)
	const retryCfg = getOverloadRetryConfig();
	if (retryCfg.enabled && retryCfg.maxAttempts > 1) {
		for (let attempt = 1; attempt < retryCfg.maxAttempts; attempt++) {
			const cap = Math.min(retryCfg.baseMs * 2 ** attempt, retryCfg.maxMs);
			const delayMs = Math.random() * cap;
			await new Promise<void>((resolve) => setTimeout(resolve, delayMs));

			log.info(
				`Account ${account.name}: 1305 retry ${attempt}/${retryCfg.maxAttempts - 1} after ${Math.round(delayMs)}ms`,
			);

			const retryRaw = await makeProxyRequest(requestClone.clone());
			const retryHeaders = new Headers(retryRaw.headers);
			retryHeaders.set(
				"x-better-ccflare-request-id",
				response.headers.get("x-better-ccflare-request-id") || "",
			);

			const retryResponse = new Response(retryRaw.body, {
				status: retryRaw.status,
				statusText: retryRaw.statusText,
				headers: retryHeaders,
			});

			// Check if retry succeeded (no 1305 in stream)
			if (!retryResponse.body) {
				return retryResponse;
			}
			if (!(await peekSseForZai1305(retryResponse))) {
				log.info(`Account ${account.name}: 1305 resolved on retry ${attempt}`);
				return retryResponse;
			}
			// Still 1305 — this retry response won't be forwarded (the loop
			// either retries again or falls through to the synthetic 429
			// below), so drain it now rather than abandoning it unread.
			cancelDiscardedResponseBody(retryResponse);
		}
	}

	log.warn(
		`Account ${account.name}: all 1305 retries exhausted, converting to 429 for model fallback`,
	);

	// Convert to synthetic 429 so isModelUnavailableError triggers model cycling
	return new Response(
		JSON.stringify({
			error: { type: "overloaded", message: "ZAI service overloaded (1305)" },
		}),
		{
			status: 429,
			statusText: "Too Many Requests",
			headers: { "content-type": "application/json" },
		},
	);
}

/**
 * Handles proxy request without authentication
 * @param req - The incoming request
 * @param url - The parsed URL
 * @param requestMeta - Request metadata
 * @param requestBodyBuffer - Buffered request body
 * @param createBodyStream - Function to create body stream
 * @param ctx - The proxy context
 * @returns Promise resolving to the response
 * @throws {ProviderError} If the unauthenticated request fails
 */
export async function proxyUnauthenticated(
	req: Request,
	url: URL,
	requestMeta: RequestMeta,
	requestBodyBuffer: ArrayBuffer | null,
	createBodyStream: () => ReadableStream<Uint8Array> | undefined,
	ctx: ProxyContext,
	apiKeyId?: string | null,
	apiKeyName?: string | null,
): Promise<Response> {
	log.warn(ERROR_MESSAGES.NO_ACCOUNTS);

	const targetUrl = ctx.provider.buildUrl(url.pathname, url.search);
	const headers = ctx.provider.prepareHeaders(
		req.headers,
		undefined,
		undefined,
	);

	try {
		// Dedicated controller so a stuck-upstream drain deadline (see
		// anthropic-terminal-recovery.ts) can abort this specific fetch's
		// connection after the fact — a signal not part of `init.signal` at
		// fetch-creation time cannot retroactively attach to it.
		const drainAbortController = new AbortController();
		const signal = AbortSignal.any([req.signal, drainAbortController.signal]);
		// The opt-in empty-pool passthrough is still a real dispatch. Its
		// missing account must be visible rather than silently skipping capture.
		const wire = new Request(targetUrl, {
			method: req.method,
			headers,
			body: requestBodyBuffer ? new Uint8Array(requestBodyBuffer) : undefined,
			signal,
		});
		const response = await forwardObservedUpstream(
			ctx.provider,
			wire,
			{
				requestId: requestMeta.id,
				account: null,
				sourceBody: requestBodyBuffer,
				sourceHeaders: req.headers,
				nativeResponses: isTrustedNativeResponses(requestMeta),
				signal,
			},
			() =>
				makeProxyRequest(
					targetUrl,
					req.method,
					headers,
					createBodyStream,
					!!req.body,
					signal,
				),
		);

		return forwardToClient(
			{
				requestId: requestMeta.id,
				method: req.method,
				path: url.pathname,
				account: null,
				requestHeaders: req.headers,
				requestBody: requestBodyBuffer,
				project: requestMeta.project,
				clientSessionId: requestMeta.clientSessionId ?? null,
				query: url.search || null,
				projectAttributionSource: requestMeta.projectAttributionSource ?? null,
				response,
				timestamp: requestMeta.timestamp,
				retryAttempt: 0,
				failoverAttempts: 0,
				agentUsed: requestMeta.agentUsed,
				originalModel: requestMeta.originalModel,
				appliedModel: requestMeta.appliedModel,
				agentAttributionSource: requestMeta.agentAttributionSource ?? null,
				comboName: requestMeta.comboName,
				apiKeyId,
				apiKeyName,
				drainAbort: drainAbortController,
			},
			ctx,
		);
	} catch (error) {
		logError(error, log);
		throw new ProviderError(
			ERROR_MESSAGES.UNAUTHENTICATED_FAILED,
			ctx.provider.name,
			502,
			{
				originalError: error instanceof Error ? error.message : String(error),
			},
		);
	}
}

/**
 * Attempts to proxy a request with a specific account
 * @param req - The incoming request
 * @param url - The parsed URL
 * @param account - The account to use
 * @param requestMeta - Request metadata
 * @param requestBodyBuffer - Buffered request body
 * @param createBodyStream - Function to create body stream (buffered earlier)
 * @param failoverAttempts - Number of failover attempts
 * @param ctx - The proxy context
 * @returns Promise resolving to response or null if failed
 */
export async function proxyWithAccount(
	req: Request,
	url: URL,
	account: Account,
	requestMeta: RequestMeta,
	requestBodyBuffer: ArrayBuffer | null,
	_createBodyStream: () => ReadableStream<Uint8Array> | undefined,
	failoverAttempts: number,
	ctx: ProxyContext,
	modelOverride?: string | null,
	apiKeyId?: string | null,
	apiKeyName?: string | null,
	requestBodyContext?: RequestBodyContext | null,
	returnRateLimitedResponseOnExhaustion = false,
): Promise<Response | null> {
	try {
		// Dedicated controller so a stuck-upstream drain deadline (see
		// anthropic-terminal-recovery.ts) can abort this request's fetch
		// connection after the fact — a signal not part of `init.signal` at
		// fetch-creation time cannot retroactively attach to it.
		const drainAbortController = new AbortController();

		// Every upstream call stays tied to the client connection: when the client
		// disconnects, the upstream fetch must be aborted instead of running on.
		// The signal is passed explicitly instead of relying on the Request object
		// to carry it, because provider body transforms rebuild the Request from
		// its URL and drop the signal (see providers/src/utils/model-mapping.ts and
		// the openai/codex providers). One guarantee at the call site beats an
		// invariant that every provider has to remember. Merged with
		// drainAbortController so the terminal-recovery drain deadline can also
		// abort this same fetch later.
		const forwardUpstream = (target: Request) => {
			const signal = AbortSignal.any([req.signal, drainAbortController.signal]);
			return forwardObservedUpstream(
				provider,
				target,
				{
					requestId: requestMeta.id,
					account,
					sourceBody: effectiveBodyBuffer,
					sourceHeaders: req.headers,
					nativeResponses: isTrustedNativeResponses(requestMeta),
					signal,
				},
				(wire) =>
					makeProxyRequest(
						wire,
						undefined,
						undefined,
						undefined,
						undefined,
						signal,
					),
			);
		};
		if (
			process.env.DEBUG?.includes("proxy") ||
			process.env.DEBUG === "true" ||
			process.env.NODE_ENV === "development"
		) {
			log.info(
				`Attempting request with account: ${account.name} (provider: ${account.provider})`,
			);
		}

		// Apply model override from combo slot (per D-04, REQ-12)
		const baseBodyContext =
			requestBodyContext ?? new RequestBodyContext(requestBodyBuffer);
		let effectiveBodyContext = baseBodyContext;
		let effectiveBodyBuffer = baseBodyContext.getBuffer();
		if (modelOverride && effectiveBodyBuffer) {
			const overriddenContext = baseBodyContext.withPatchedModel(modelOverride);
			if (overriddenContext) {
				effectiveBodyContext = overriddenContext;
				effectiveBodyBuffer = overriddenContext.getBuffer();

				if (
					process.env.DEBUG?.includes("proxy") ||
					process.env.DEBUG === "true" ||
					process.env.NODE_ENV === "development"
				) {
					log.info(
						`Combo model override: applying model "${modelOverride}" for account ${account.name}`,
					);
				}
			} else {
				log.warn(
					"Failed to patch request body with model override, using original body",
				);
				effectiveBodyBuffer = baseBodyContext.getBuffer();
			}
		}

		// Stage the original request body + headers for cache keepalive replay.
		// Uses the pre-transform body (effectiveBodyBuffer may have a model override
		// patched in, so use the original requestBodyBuffer for a faithful replay).
		// Headers are stored because Anthropic's prepareHeaders() copies incoming
		// client headers (anthropic-version, anthropic-beta, x-stainless-*, etc.)
		// and augments them — providers that build headers from scratch ignore them.
		// Skip staging for internal synthetic requests:
		//   - keepalive replays — prevent infinite loop
		//   - auto-refresh probes — same loop-prevention concern, plus these
		//     hit known-cooled accounts and shouldn't pollute the staged-body cache
		//     (issue #199, bug 2).
		const isSyntheticInternal = isInternalProbe(req.headers, ctx);
		if (!isSyntheticInternal) {
			cacheBodyStore.stageRequest(
				requestMeta.id,
				account.id,
				baseBodyContext.getBuffer(),
				req.headers,
				url.pathname,
			);
		}

		// Get the provider for this account
		const provider = getProvider(account.provider) || ctx.provider;
		const transformRequestForAccount = async (
			request: Request,
		): Promise<Request> => {
			const providerRequest = provider.transformRequestBody
				? await provider.transformRequestBody(request, account)
				: request;
			return applyAccountRequestTransformer(providerRequest, account);
		};

		// Validate that the account-specific provider can handle this path
		validateProviderPath(provider, url.pathname);

		const isSyntheticCodexCountTokens =
			provider.name === "codex" && url.pathname === "/v1/messages/count_tokens";

		// Synthetic Codex count_tokens never calls upstream, so it should not require
		// or refresh OAuth credentials just to return an advisory local estimate.
		const accessToken = isSyntheticCodexCountTokens
			? ""
			: await getValidAccessToken(account, ctx);

		// Pre-process request if provider supports it (e.g., to extract model for URL)
		if (provider.prepareRequest) {
			provider.prepareRequest(req, effectiveBodyBuffer, account);
		}

		// Prepare request using account-specific provider
		const headers = provider.prepareHeaders(
			req.headers,
			accessToken,
			account.api_key || undefined,
		);
		// Codex continuation is prepared while transformRequestBody still has the
		// native input. Make the proxy-owned correlation ID available at that seam;
		// the provider consumes and strips it before the request leaves ccflare.
		// Never trust or reuse a caller-supplied copy.
		if (provider.name === "codex") {
			headers.set("x-better-ccflare-request-id", requestMeta.id);
			// This identity comes from front-door authentication, never a client header.
			const caller = apiKeyId;
			headers.delete("x-better-ccflare-authenticated-caller");
			if (caller)
				headers.set(
					"x-better-ccflare-authenticated-caller",
					createHash("sha256")
						.update("better-ccflare:caller-api-key:v1\0")
						.update(caller)
						.digest("hex"),
				);
			if (isTrustedNativeResponses(requestMeta)) {
				headers.set("x-better-ccflare-native-responses", "true");
			}
		}
		// Synthetic-response markers are internal provider-to-proxy signals. Strip
		// client-supplied copies before providers transform the outbound request.
		headers.delete(SYNTHETIC_RESPONSE_HEADER);
		headers.delete(SYNTHETIC_STATUS_HEADER);

		// xAI cache-native conversation identity (issue #319 minimal slice).
		// Applied here rather than via Provider.prepareHeaders: that hook only
		// receives (headers, accessToken, apiKey) — no account or RequestMeta —
		// so the conv id derived in proxy.ts isn't reachable there without
		// widening the shared Provider interface for one provider's feature.
		// A no-op for every non-xai request and whenever the feature is
		// disabled (getXaiConvId returns null — see account-selector.ts).
		applyXaiConvIdHeader(
			headers,
			provider.name,
			account,
			getXaiConvId(requestMeta),
		);
		const targetUrl = provider.buildUrl(url.pathname, url.search, account);

		const requestInit: RequestInit & { duplex?: "half" } = {
			method: req.method,
			headers,
			// Tie the upstream fetch to the client connection. When the client goes
			// away mid-stream (idle-watchdog abort, Ctrl-C, network drop) the
			// upstream request must be aborted too, instead of streaming on
			// unattended and holding the connection open.
			signal: req.signal,
		};
		if (effectiveBodyBuffer) {
			requestInit.body = new Uint8Array(effectiveBodyBuffer);
			requestInit.duplex = "half";
		}

		const providerRequest = new Request(targetUrl, requestInit);

		// The provider is about to translate the Claude family into one of its
		// own models, and only this account's listing knows which. Loading it
		// here costs one await on the account's first request in this process;
		// after that it is memory. Codex only: an openai-compatible account's
		// derived defaults are never consumed for family mapping (each endpoint
		// is arbitrary, so guessing sonnet/haiku from list position is not a
		// call this proxy makes), so warming them here would only add latency.
		await ensureCodexModelDefaults(account, ctx);

		const initialTransformedRequest =
			await transformRequestForAccount(providerRequest);

		// Pre-strip cache_control for (account, model) pairs known to reject it.
		// Also doubles as the buffered body for in-place 529 retries below —
		// cloning the Request for retries tees the body into a branch nothing
		// reads on the no-retry path, retaining its native buffer per request
		// (#382).
		const transformedBodyText = await initialTransformedRequest.clone().text();
		let transformedBodyJson: Record<string, unknown> | null = null;
		try {
			transformedBodyJson = JSON.parse(transformedBodyText);
		} catch {
			// ignore
		}
		const transformedModel =
			(transformedBodyJson?.model as string | undefined) ?? "";

		/**
		 * The single source of truth for "the request currently in flight on this
		 * account": what an in-place 529/5xx retry replays, what downstream
		 * replays (checkZai1305) re-issue, and which model the response is
		 * attributed to.
		 *
		 * It exists because three recovery paths change the request in flight and
		 * each used to update a different subset of the three variables this
		 * replaces (`transformedRequest`, `retryBodyText`, `responseModelFallback`).
		 * The model-fallback loop recorded only the model, the cache-control
		 * recovery only the Request, the thinking-signature recovery neither — so a
		 * retry after any of them re-sent a request the upstream had just rejected.
		 * One descriptor with one setter is what keeps them from drifting again.
		 */
		const outgoing: {
			request: Request;
			bodyText: string | undefined;
			model: string;
		} = {
			request: initialTransformedRequest,
			bodyText: transformedBodyText,
			model: transformedModel,
		};

		/**
		 * Adopts a rebuilt request as the one in flight. `bodyText` is what a
		 * replay re-sends and must be this request's own body — never the previous
		 * one. `model` is only passed when the recovery changed which model the
		 * upstream is being asked for.
		 */
		const adoptOutgoingRequest = (
			request: Request,
			bodyText: string | undefined,
			model?: string,
		): void => {
			outgoing.request = request;
			outgoing.bodyText = bodyText;
			if (model !== undefined) outgoing.model = model;
		};

		if (
			transformedModel &&
			cacheControlRejectors.has(
				cacheControlRejectorKey(account.id, transformedModel),
			) &&
			transformedBodyJson
		) {
			stripCacheControlFromOpenAIRequest(
				transformedBodyJson as unknown as Parameters<
					typeof stripCacheControlFromOpenAIRequest
				>[0],
			);
			const preStrippedBodyText = JSON.stringify(transformedBodyJson);
			adoptOutgoingRequest(
				new Request(outgoing.request.url, {
					method: outgoing.request.method,
					headers: outgoing.request.headers,
					body: preStrippedBodyText,
					// A URL-based rebuild drops the signal — carry it over.
					signal: req.signal,
				}),
				preStrippedBodyText,
			);
			log.debug(
				`Pre-stripped cache_control for known rejector: account=${account.name} model=${transformedModel}`,
			);
		}

		// Make the request (or unwrap a synthetic provider response)
		let rawResponse = isSyntheticProviderResponse(outgoing.request)
			? materializeSyntheticResponse(outgoing.request)
			: await forwardUpstream(outgoing.request);

		if (provider.name === "codex" && [400, 404].includes(rawResponse.status)) {
			const recovered = await recoverCodexMessagesContinuation(
				provider,
				rawResponse,
				new Request(targetUrl, requestInit),
				account,
			);
			if (recovered) {
				// Exactly one retry on the same provider/account/model. Refresh the
				// buffered body too so a later 529 retry cannot resend the old suffix.
				const accountTransformedRecovery = await applyAccountRequestTransformer(
					recovered,
					account,
				);
				const recoveredBodyText = await accountTransformedRecovery.text();
				adoptOutgoingRequest(
					new Request(accountTransformedRecovery.url, {
						method: accountTransformedRecovery.method,
						headers: accountTransformedRecovery.headers,
						body: recoveredBodyText,
						signal: req.signal,
					}),
					recoveredBodyText,
				);
				cancelDiscardedResponseBody(rawResponse);
				rawResponse = await forwardUpstream(outgoing.request);
			}
		}

		// Check if this is a Claude provider and we got an invalid thinking signature error
		const isClaudeProvider =
			provider.name === "anthropic" || account.provider === "claude-oauth";
		if (
			isClaudeProvider &&
			(await isInvalidThinkingSignatureError(rawResponse))
		) {
			log.info(
				`Detected invalid thinking block signature error for account ${account.name}, retrying with thinking blocks filtered`,
			);

			// Filter thinking blocks from the request body
			const filteredBodyBuffer = filterThinkingBlocks(effectiveBodyContext);

			if (filteredBodyBuffer && filteredBodyBuffer !== effectiveBodyBuffer) {
				// Retry the request with filtered body
				const retryRequestInit: RequestInit & { duplex?: "half" } = {
					method: req.method,
					headers,
					body: new Uint8Array(filteredBodyBuffer),
					duplex: "half",
					signal: req.signal,
				};

				const retryProviderRequest = new Request(targetUrl, retryRequestInit);

				const retryTransformedRequest =
					await transformRequestForAccount(retryProviderRequest);

				// Adopt before sending: a later in-place retry must replay THIS
				// request. Re-sending the unfiltered body would hand the upstream
				// back the thinking signature it just rejected.
				let retryTransformedBodyText: string | undefined;
				try {
					retryTransformedBodyText = await retryTransformedRequest
						.clone()
						.text();
				} catch (err) {
					// Unreachable for a Request built from a byte buffer; if it ever
					// happens, keeping the previous descriptor is the pre-existing
					// behaviour and strictly safer than pairing this request's URL and
					// headers with the previous request's body.
					log.warn("Failed to buffer the thinking-filtered retry body:", err);
				}
				if (retryTransformedBodyText !== undefined) {
					adoptOutgoingRequest(
						retryTransformedRequest,
						retryTransformedBodyText,
					);
				}

				// Make the retry request (or unwrap a synthetic provider response)
				cancelDiscardedResponseBody(rawResponse);
				rawResponse = isSyntheticProviderResponse(retryTransformedRequest)
					? materializeSyntheticResponse(retryTransformedRequest)
					: await forwardUpstream(retryTransformedRequest);
			} else {
				log.warn(
					"Failed to filter thinking blocks or no changes made, proceeding with original error response",
				);
			}
		}

		// Retry without cache_control if provider rejected it (e.g. GLM-5.1 strict validation).
		// Mark (accountId, model) so subsequent requests skip cache_control immediately.
		if (await isCacheControlRejectionError(rawResponse)) {
			const rejectorKey = cacheControlRejectorKey(account.id, transformedModel);
			if (!cacheControlRejectors.has(rejectorKey)) {
				// Mark before retry so subsequent requests pre-strip without a round-trip.
				// The current caller still receives the retried response (or the original
				// 400 if the retry also fails).
				cacheControlRejectors.add(rejectorKey);
				log.info(
					`Provider rejected cache_control for account=${account.name} model=${transformedModel}, retrying without it`,
				);
			}

			try {
				const retryBodyJson = JSON.parse(transformedBodyText);
				stripCacheControlFromOpenAIRequest(retryBodyJson);
				const strippedBodyText = JSON.stringify(retryBodyJson);
				const retryRequest = new Request(outgoing.request.url, {
					method: outgoing.request.method,
					headers: outgoing.request.headers,
					body: strippedBodyText,
					// A URL-based rebuild drops the signal — carry it over.
					signal: req.signal,
				});
				cancelDiscardedResponseBody(rawResponse);
				rawResponse = isSyntheticProviderResponse(retryRequest)
					? materializeSyntheticResponse(retryRequest)
					: await forwardUpstream(retryRequest);
				// rawResponse now belongs to retryRequest (cache_control stripped),
				// not to the request that was rejected — anything downstream that
				// replays (checkZai1305, the in-place 529/5xx retries) must re-issue
				// this request, BODY INCLUDED. Adopting only the Request, as this
				// line used to, left the buffered body still carrying the rejected
				// field for every replay. Kept after the await on purpose: a
				// throwing re-issue is swallowed below and leaves the original
				// response in hand, so the descriptor must stay with it.
				adoptOutgoingRequest(retryRequest, strippedBodyText);
			} catch (err) {
				log.warn("Failed to retry without cache_control:", err);
			}
		}

		// ── Upstream-error classification ───────────────────────────────────
		// Each handler below was inline on the first-response path and is now a
		// named closure so the in-place 529/5xx retry loops can put the response a
		// RETRY produced through exactly the same classification. A retry can
		// answer 403 `permission_error` or 429 `out_of_credits` just as the first
		// attempt can, and before this extraction those answers were handed to the
		// client unclassified, with the account left unbenched and still at the
		// front of the priority order.
		//
		// The bodies are the code they replaced, unchanged. The only edits: the
		// response to classify arrives as a parameter instead of being read from
		// the enclosing `rawResponse`, and each handler ends in NOT_CLASSIFIED
		// instead of falling out of an `if`. The parameter keeps the name
		// `rawResponse` so the bodies stay byte-identical; inside a handler that
		// name always means the argument, never the outer first-response variable.

		/** 400 `invalid_request_error` for depleted Anthropic extra-usage credit. */
		const classifyExtraUsageExhausted = async (
			rawResponse: Response,
		): Promise<UpstreamErrorClassification> => {
			// ── extra_usage_exhausted: billing-policy rejection, NOT a rate limit (issue #293) ──
			// Anthropic returns 400 invalid_request_error when a Claude OAuth account's
			// "extra usage" credit balance is depleted for third-party-app traffic (e.g.
			// OpenCode). This is a billing rejection, not account exhaustion — we do NOT
			// bench the account and we do NOT change what's returned to the client; the
			// 400 is passed through unchanged. We only log/record it for dashboard visibility.
			// Checked before isModelUnavailableError since this 400 shape (invalid_request_error
			// mentioning "extra usage") is not a "model unavailable" condition and would
			// otherwise never be reached — isModelUnavailableError only matches not_found_error,
			// model_not_found, "model not found"/"does not exist", or ResourceNotFoundException.
			// Gated to Anthropic/Claude-OAuth accounts only — the body-shape match
			// (invalid_request_error + "extra usage") is specific enough for Anthropic's
			// API but could otherwise coincidentally match an arbitrary OpenAI-compatible
			// provider's error text and mislabel its billing state.
			if (
				isClaudeProvider &&
				rawResponse.status === 400 &&
				(await isAnthropicExtraUsageExhausted(rawResponse.clone()))
			) {
				let requestedModel: string | null = null;
				if (effectiveBodyBuffer)
					requestedModel = effectiveBodyContext.getModel();

				const reason: RateLimitReason = "extra_usage_exhausted";
				log.warn(
					`Account ${account.name} extra_usage_exhausted (400${requestedModel ? `, model=${requestedModel}` : ""}) — ` +
						`Anthropic extra-usage credits depleted for this OAuth account; NOT benching, response passed through to client`,
				);
				const responseTime = Date.now() - requestMeta.timestamp;
				const modelRewrite = isModelRewrite(
					requestMeta.originalModel,
					requestMeta.appliedModel,
				);
				ctx.asyncWriter.enqueue(() =>
					ctx.dbOps.saveRequest(
						crypto.randomUUID(),
						req.method,
						url.pathname,
						account.id,
						400,
						false,
						reason,
						responseTime,
						failoverAttempts,
						requestedModel ? { model: requestedModel } : undefined,
						requestMeta.agentUsed ?? undefined,
						apiKeyId ?? undefined,
						apiKeyName ?? undefined,
						requestMeta.project ?? null,
						undefined,
						requestMeta.comboName ?? null,
						modelRewrite ? (requestMeta.originalModel ?? null) : null,
						modelRewrite ? (requestMeta.appliedModel ?? null) : null,
						requestMeta.projectAttributionSource ?? null,
						requestMeta.agentAttributionSource ?? null,
						null,
						requestMeta.clientSessionId ?? null,
					),
				);
				// Do not bench the account or fail over — pass Anthropic's real error
				// through to the client unchanged, same as any other 400 today.
				return withSanitizedProxyHeaders(rawResponse);
			}
			return NOT_CLASSIFIED;
		};

		/** 403 `permission_error`: the account's organization forbids this access. */
		const classifyOrgPermissionDenied = async (
			rawResponse: Response,
		): Promise<UpstreamErrorClassification> => {
			// ── org_permission_denied: the ORGANIZATION forbids this account ──
			// Anthropic answers 403 `permission_error` when an account's org has
			// OAuth — or Claude Code specifically — turned off by an admin. Measured
			// on a live pool: three accounts of one organization returned it 25 times
			// within the hour, every one carrying `x-should-retry: false`, while the
			// usage poller had independently racked up 49 consecutive failures per
			// account. That signal existed in-process the whole time and never
			// reached the router.
			//
			// Before this branch, a 403 matched none of the failover guards (401 /
			// 429 / 529 / model-unavailable) and fell through to forwardToClient, so
			// the client saw the error even with healthy accounts still in the pool.
			// Worse, `processProxyResponse` classifies any non-429 as "not rate
			// limited" and unconditionally clears `rate_limited_until`, so the
			// offending account also lost any existing bench and stayed pinned at the
			// front of the priority order for every following request. Returning null
			// here short-circuits both halves of that.
			//
			// The account is benched exactly like an exhausted quota window: it
			// cannot serve anything at all, so it must leave the rotation, and the
			// exponential ramp plus the single-flight recovery probe (see
			// rate-limit-cooldown.ts) means at most one request per cooldown expiry
			// is spent rediscovering a block only an admin can lift.
			//
			// POOL-WIDE DRAIN CAVEAT: if every account in the pool belongs to the
			// same org and that org has disabled access, every account benches in
			// turn and the pool goes fully dark — bench, cooldown expiry,
			// single-flight probe, re-bench, repeat — until an admin changes the
			// org setting. There is no pool-wide/provider-wide circuit here, only
			// this per-account exponential cooldown, so nothing short-circuits
			// that loop early. The warn log below fires on every account as it
			// benches, so an "all accounts benched with org_permission_denied"
			// pattern across the pool in a short window is the signal to look for
			// when debugging a fully-dark pool.
			if (
				isClaudeProvider &&
				rawResponse.status === 403 &&
				// Passed un-cloned on purpose: the predicate clones internally and
				// never consumes its argument, so wrapping it in another clone here
				// would strand a tee branch for every non-matching 403 (issue #356).
				(await isAnthropicOrgPermissionDenied(rawResponse))
			) {
				let requestedModel: string | null = null;
				if (effectiveBodyBuffer)
					requestedModel = effectiveBodyContext.getModel();

				const reason: RateLimitReason = "org_permission_denied";
				log.warn(
					`Account ${account.name} org_permission_denied (403${requestedModel ? `, model=${requestedModel}` : ""}) — ` +
						`organization forbids OAuth/Claude Code access for this account; ` +
						`benching account and failing over to next account`,
				);

				// Benched even for synthetic probes. Unlike a 429 — where a keepalive
				// burst can trip Anthropic's per-IP limit and produce a cooldown no
				// real user earned — a 403 from the organization is authoritative
				// regardless of who asked, so learning it from a probe is genuine
				// information and throwing it away would only delay the bench until a
				// real request pays for it.
				applyRateLimitCooldown(account, { reason }, ctx);

				// The audit row, however, stays real-traffic-only: a synthetic probe's
				// rejection was never a client-visible request, and recording it would
				// just be history noise. Same rationale as the out_of_credits path.
				if (!isSyntheticInternal) {
					const responseTime = Date.now() - requestMeta.timestamp;
					const modelRewrite = isModelRewrite(
						requestMeta.originalModel,
						requestMeta.appliedModel,
					);
					ctx.asyncWriter.enqueue(() =>
						ctx.dbOps.saveRequest(
							crypto.randomUUID(),
							req.method,
							url.pathname,
							account.id,
							403,
							false,
							reason,
							responseTime,
							failoverAttempts,
							requestedModel ? { model: requestedModel } : undefined,
							requestMeta.agentUsed ?? undefined,
							apiKeyId ?? undefined,
							apiKeyName ?? undefined,
							requestMeta.project ?? null,
							undefined,
							requestMeta.comboName ?? null,
							modelRewrite ? (requestMeta.originalModel ?? null) : null,
							modelRewrite ? (requestMeta.appliedModel ?? null) : null,
							requestMeta.projectAttributionSource ?? null,
							requestMeta.agentAttributionSource ?? null,
							null,
							requestMeta.clientSessionId ?? null,
						),
					);
				}
				cancelDiscardedResponseBody(rawResponse);
				return null;
			}
			return NOT_CLASSIFIED;
		};

		/** 429 carrying `overage-disabled-reason: out_of_credits`. */
		const classifyOutOfCredits429 = async (
			rawResponse: Response,
			requestedModel: string | null,
		): Promise<UpstreamErrorClassification> => {
			// ── out_of_credits: model/beta-scoped depletion, NOT account-wide (issue #261) ──
			// Anthropic returns 429 + `overage-disabled-reason: out_of_credits` with no reset
			// header. This is scoped to a specific model/beta (e.g. context-1m), not the
			// account — opus/haiku/plain-sonnet still succeed on the same account. So we do
			// NOT bench the account (no applyRateLimitCooldown, no consecutive increment):
			// fail over per-request and leave the account in rotation for other models.
			if (rawResponse.status === 429 && isAnthropicOutOfCredits(rawResponse)) {
				// Feed the model-scoped capacity negative cache (model-capacity.ts):
				// this account is confirmed exhausted for the requested model's
				// family right now, even before usageCache's next poll would reflect
				// it — regardless of whether this is a real client request or a
				// keepalive probe, the observed 429 is an equally real signal. The
				// mark always uses the fixed default TTL (no resetAt seeding — see
				// model-capacity.ts) and is recorded with "recent_upstream_rejection"
				// provenance since it is never corroborated by telemetry here.
				if (requestedModel) {
					const family = getModelFamily(requestedModel);
					if (family) {
						// Diagnose-only: log the family's last-known scoped percent from
						// cached telemetry to correlate this reactive mark against the
						// most recent poll — purely for attribution, not a gate. Lives
						// here (not in model-capacity.ts) so that module never depends
						// on the usageCache singleton.
						const scopedPercent = currentScopedPercentForFamily(
							usageCache.get(account.id),
							family,
						);
						log.debug(
							`Marking ${account.name} exhausted for model family "${family}" via out_of_credits ` +
								`(last known weekly_scoped percent: ${scopedPercent ?? "unknown"})`,
						);
						markFamilyExhausted(
							account.id,
							family,
							undefined,
							undefined,
							"recent_upstream_rejection",
						);
					}
				}

				const isKeepalive = isInternalProbe(req.headers, ctx, "keepalive");
				if (isKeepalive) {
					cancelDiscardedResponseBody(rawResponse);
					return null;
				}
				const reason: RateLimitReason = "out_of_credits";
				log.warn(
					`Account ${account.name} out_of_credits (429${requestedModel ? `, model=${requestedModel}` : ""}) — ` +
						`model/beta-scoped, NOT benching account; failing over to next account`,
				);
				const responseTime = Date.now() - requestMeta.timestamp;
				const modelRewrite = isModelRewrite(
					requestMeta.originalModel,
					requestMeta.appliedModel,
				);
				ctx.asyncWriter.enqueue(() =>
					ctx.dbOps.saveRequest(
						crypto.randomUUID(),
						req.method,
						url.pathname,
						account.id,
						429,
						false,
						reason,
						responseTime,
						failoverAttempts,
						requestedModel ? { model: requestedModel } : undefined,
						requestMeta.agentUsed ?? undefined,
						apiKeyId ?? undefined,
						apiKeyName ?? undefined,
						requestMeta.project ?? null,
						undefined,
						requestMeta.comboName ?? null,
						modelRewrite ? (requestMeta.originalModel ?? null) : null,
						modelRewrite ? (requestMeta.appliedModel ?? null) : null,
						requestMeta.projectAttributionSource ?? null,
						requestMeta.agentAttributionSource ?? null,
						null,
						requestMeta.clientSessionId ?? null,
					),
				);
				cancelDiscardedResponseBody(rawResponse);
				return null;
			}
			return NOT_CLASSIFIED;
		};

		/**
		 * The 429 branch taken when this account has no fallback model to cycle
		 * to: keepalive burst, windowless (request-scoped) 429, or a genuine
		 * window that benches the account. Answers NOT_CLASSIFIED for any other
		 * status so the caller can fall through to its model-not-found handling.
		 */
		const classifyNoFallback429 = async (
			rawResponse: Response,
			requestedModel: string | null,
		): Promise<UpstreamErrorClassification> => {
			if (rawResponse.status === 429) {
				// Skip cooldown on synthetic cache-keepalive replays. The
				// keepalive scheduler fires parallel requests to every
				// cached account; a burst of 4+ simultaneous requests
				// trips Anthropic's per-IP burst limit and 429s every
				// account at the same instant. Applying real cooldowns
				// here drains the pool to zero routable accounts even
				// though no real user-facing rate limit was hit.
				const isKeepalive = isInternalProbe(req.headers, ctx, "keepalive");
				if (isKeepalive) {
					log.warn(
						`Keepalive replay for ${account.name} got 429 — skipping cooldown (synthetic burst, not a real per-account rate limit)`,
					);
					cancelDiscardedResponseBody(rawResponse);
					return null;
				}

				// ── windowless 429: request-scoped, NOT account-wide (issue #301) ──
				// Anthropic 429s some requests with `x-should-retry: true` and no
				// rate-limit metadata whatsoever — no `retry-after`, not one
				// `anthropic-ratelimit-*` / `x-ratelimit-*` header. Live measurement
				// on a production install showed this to be scoped to the REQUEST,
				// not the account: the same account served 200s two seconds before
				// and 38 seconds after on the same model, three in-place retries
				// spanning 11.2s returned three identical bare 429s (never once a
				// success), and the NEXT account rejected the same client request
				// the same way. The rejected requests are session-initialising ones
				// with no project attribution; ordinary conversation turns on the
				// same account succeed throughout.
				//
				// So benching is simply the wrong response: it drains the pool one
				// account per attempt until the operator has to force-reset every
				// account before ordinary traffic works again. Treat it exactly like
				// out_of_credits above (issue #261) — fail over per request with NO
				// cooldown and NO consecutive-429 increment, leaving the account in
				// rotation. Placed after the keepalive check so a synthetic probe
				// still records nothing at all.
				//
				// The predicate is `isRetryable429` (header-only, synchronous,
				// fail-closed: `x-should-retry: true`, no `retry-after`, and no
				// header under either rate-limit prefix). Its name is now a slight
				// misnomer — nothing is retried any more — but it is exactly the
				// right discriminator and its module is reviewed and tested, so it
				// keeps its name.
				if (isRetryable429(rawResponse, isClaudeProvider)) {
					const reason: RateLimitReason = "windowless_429";
					log.warn(
						`Account ${account.name} returned a windowless 429 (${
							requestedModel ? `model=${requestedModel}, ` : ""
						}x-should-retry with no rate-limit window) — request-scoped, ` +
							`NOT benching account; failing over to next account`,
					);
					const responseTime = Date.now() - requestMeta.timestamp;
					const modelRewrite = isModelRewrite(
						requestMeta.originalModel,
						requestMeta.appliedModel,
					);
					ctx.asyncWriter.enqueue(() =>
						ctx.dbOps.saveRequest(
							crypto.randomUUID(),
							req.method,
							url.pathname,
							account.id,
							429,
							false,
							reason,
							responseTime,
							failoverAttempts,
							requestedModel ? { model: requestedModel } : undefined,
							requestMeta.agentUsed ?? undefined,
							apiKeyId ?? undefined,
							apiKeyName ?? undefined,
							requestMeta.project ?? null,
							undefined,
							requestMeta.comboName ?? null,
							modelRewrite ? (requestMeta.originalModel ?? null) : null,
							modelRewrite ? (requestMeta.appliedModel ?? null) : null,
							requestMeta.projectAttributionSource ?? null,
							requestMeta.agentAttributionSource ?? null,
							null,
							requestMeta.clientSessionId ?? null,
						),
					);
					cancelDiscardedResponseBody(rawResponse);
					return null;
				}

				log.warn(
					`Account ${account.name} rate-limited (429), no model fallbacks — failing over to next account`,
				);
				const cooldownUntil = extractCooldownUntil(
					rawResponse,
					account.id,
					usageCache.getRateLimitedUntil.bind(usageCache),
				);
				const reason: RateLimitReason = "model_fallback_429";
				applyRateLimitCooldown(
					account,
					{ resetTime: cooldownUntil, reason },
					ctx,
				);
				const responseTime = Date.now() - requestMeta.timestamp;
				const modelRewrite = isModelRewrite(
					requestMeta.originalModel,
					requestMeta.appliedModel,
				);
				ctx.asyncWriter.enqueue(() =>
					ctx.dbOps.saveRequest(
						crypto.randomUUID(),
						req.method,
						url.pathname,
						account.id,
						429,
						false,
						reason,
						responseTime,
						failoverAttempts,
						requestedModel ? { model: requestedModel } : undefined,
						requestMeta.agentUsed ?? undefined,
						apiKeyId ?? undefined,
						apiKeyName ?? undefined,
						requestMeta.project ?? null,
						undefined,
						requestMeta.comboName ?? null,
						modelRewrite ? (requestMeta.originalModel ?? null) : null,
						modelRewrite ? (requestMeta.appliedModel ?? null) : null,
						requestMeta.projectAttributionSource ?? null,
						requestMeta.agentAttributionSource ?? null,
						null,
						requestMeta.clientSessionId ?? null,
					),
				);
				cancelDiscardedResponseBody(rawResponse);
				return null;
			}
			return NOT_CLASSIFIED;
		};

		/**
		 * The classification chain as a retry response has to see it: every
		 * handler above, in the first-response order, minus the model-cycling
		 * fallback loop.
		 *
		 * The fallback loop is excluded on purpose. It exists to answer "the model
		 * this account was asked for is unavailable"; a model that the upstream
		 * accepted on the first attempt has not become unavailable because a
		 * retry was needed, and re-entering the loop here would re-issue the
		 * request against a second model on an account we are about to leave. For
		 * the same reason, when the account DOES have fallback models configured
		 * (`modelList.length > 1`) a retried 429 is left to the downstream
		 * handling it gets today rather than benched by `classifyNoFallback429`.
		 *
		 * `checkZai1305` is likewise not re-run: it is a body peek that rewrites a
		 * 200 into a synthetic 429, not a classification of an error the upstream
		 * reported, and the retry loops never fed it before.
		 */
		const classifyRetriedUpstreamResponse = async (
			retried: Response,
		): Promise<UpstreamErrorClassification> => {
			const extraUsage = await classifyExtraUsageExhausted(retried);
			if (extraUsage !== NOT_CLASSIFIED) return extraUsage;

			const orgDenied = await classifyOrgPermissionDenied(retried);
			if (orgDenied !== NOT_CLASSIFIED) return orgDenied;

			// Everything below lived under `isModelUnavailableError`, which is
			// unconditionally true for a 429 and only reachable for 404/400
			// otherwise — and 404/400 is the fallback loop's business, not ours.
			if (retried.status !== 429) return NOT_CLASSIFIED;

			let requestedModel: string | null = null;
			if (effectiveBodyBuffer) requestedModel = effectiveBodyContext.getModel();

			const outOfCredits = await classifyOutOfCredits429(
				retried,
				requestedModel,
			);
			if (outOfCredits !== NOT_CLASSIFIED) return outOfCredits;

			if (!requestedModel) return NOT_CLASSIFIED;
			const modelList = getModelList(requestedModel, account);
			if (modelList && modelList.length > 1) return NOT_CLASSIFIED;
			return classifyNoFallback429(retried, requestedModel);
		};

		const extraUsageOutcome = await classifyExtraUsageExhausted(rawResponse);
		if (extraUsageOutcome !== NOT_CLASSIFIED) return extraUsageOutcome;

		// Check for ZAI 1305 overloaded error in SSE stream and retry/fallback
		rawResponse = await checkZai1305(
			rawResponse,
			account,
			outgoing.request,
			log,
		);

		const orgPermissionOutcome = await classifyOrgPermissionDenied(rawResponse);
		if (orgPermissionOutcome !== NOT_CLASSIFIED) return orgPermissionOutcome;

		// On model unavailable / rate-limited: cycle through the model list for
		// this account. getModelList returns [primary, ...fallbacks] merged from
		// model_mappings arrays and legacy model_fallbacks. We already tried index 0
		// (the primary), so start at index 1.
		let zai1305AlreadyChecked = false;
		if (await isModelUnavailableError(rawResponse)) {
			// Log 429 response headers for debugging upstream rate-limit info
			if (rawResponse.status === 429) {
				const rlHeaders: Record<string, string> = {};
				rawResponse.headers.forEach((v, k) => {
					const lk = k.toLowerCase();
					if (
						lk.includes("rate") ||
						lk.includes("retry") ||
						lk.includes("limit") ||
						lk.includes("reset") ||
						lk.includes("x-") ||
						lk.includes("quota")
					) {
						rlHeaders[k] = v;
					}
				});
				log.debug(
					`Account ${account.name} received 429 — headers: ${JSON.stringify(rlHeaders)}`,
				);
			}
			let requestedModel: string | null = null;
			if (effectiveBodyBuffer) requestedModel = effectiveBodyContext.getModel();

			const outOfCreditsOutcome = await classifyOutOfCredits429(
				rawResponse,
				requestedModel,
			);
			if (outOfCreditsOutcome !== NOT_CLASSIFIED) return outOfCreditsOutcome;

			if (requestedModel) {
				const modelList = getModelList(requestedModel, account);
				if (!modelList || modelList.length <= 1) {
					// No fallback models configured — fail over to the next account.
					// 429s should never be forwarded to the client when other
					// accounts are available; only genuine model-not-found
					// errors (404/400) warrant returning the upstream response.
					const noFallback429Outcome = await classifyNoFallback429(
						rawResponse,
						requestedModel,
					);
					if (noFallback429Outcome !== NOT_CLASSIFIED)
						return noFallback429Outcome;
					// Model-not-found (404/400) is forwarded to the client so it can
					// surface the real error. Strip content-encoding/content-length
					// first: Bun's fetch already decompressed the body, so leaving the
					// upstream `content-encoding: gzip` header makes the client try to
					// gunzip plaintext → "Decompression error: ZlibError".
					return withSanitizedProxyHeaders(rawResponse);
				}

				for (let i = 1; i < modelList.length; i++) {
					const nextModel = modelList[i];
					log.info(
						`Model '${modelList[i - 1]}' unavailable/rate-limited on account ${account.name}, ` +
							`retrying with: ${nextModel} (${i}/${modelList.length - 1})`,
					);

					// Patch the original request body with the next model name, then let
					// transformRequestBody handle format conversion (e.g. Anthropic→OpenAI).
					// After that, re-patch the model name because transformRequestBody calls
					// mapModelName internally which remaps non-Claude names back to the primary
					// model (no family match → sonnet fallback). We always want nextModel to
					// reach the upstream provider verbatim.
					const patchedContext =
						effectiveBodyContext.withPatchedModel(nextModel);
					const patchedBody = patchedContext?.getBuffer() ?? null;
					if (!patchedBody) {
						log.warn("Failed to patch request body for model retry");
						break;
					}

					const retryRequestInit: RequestInit & { duplex?: "half" } = {
						method: req.method,
						headers,
						body: new Uint8Array(patchedBody),
						duplex: "half",
						signal: req.signal,
					};

					const retryProviderRequest = new Request(targetUrl, retryRequestInit);
					let retryTransformedRequest =
						await transformRequestForAccount(retryProviderRequest);

					// Re-patch model after transformRequestBody — the provider's conversion
					// (e.g. convertAnthropicRequestToOpenAI) calls mapModelName which can
					// remap nextModel back to the primary model if it has no Claude family
					// pattern. Force nextModel into the final request body.
					//
					// The body text is kept because it is what an in-place retry has to
					// replay: before this, the loop recorded only `nextModel` and a
					// following 5xx/529 retry re-sent the model the upstream had just
					// declared unavailable.
					let retryTransformedBodyText: string | undefined;
					try {
						retryTransformedBodyText = await retryTransformedRequest
							.clone()
							.text();
					} catch (err) {
						log.warn("Failed to buffer the model-fallback retry body:", err);
					}
					if (retryTransformedBodyText !== undefined) {
						try {
							const transformedBody = JSON.parse(retryTransformedBodyText);
							if (transformedBody.model !== nextModel) {
								transformedBody.model = nextModel;
								const repatchedBodyText = JSON.stringify(transformedBody);
								const repatchedHeaders = new Headers(
									retryTransformedRequest.headers,
								);
								retryTransformedRequest = new Request(
									retryTransformedRequest.url,
									{
										method: retryTransformedRequest.method,
										headers: repatchedHeaders,
										body: repatchedBodyText,
										// A URL-based rebuild drops the signal — carry it over.
										signal: req.signal,
									},
								);
								retryTransformedBodyText = repatchedBodyText;
							}
						} catch {
							// If re-patching fails, proceed with the transformed request as-is
						}
					}

					cancelDiscardedResponseBody(rawResponse);
					rawResponse = isSyntheticProviderResponse(retryTransformedRequest)
						? materializeSyntheticResponse(retryTransformedRequest)
						: await forwardUpstream(retryTransformedRequest);
					if (retryTransformedBodyText === undefined) {
						// Body unreadable — unreachable for a buffer-backed Request.
						// Record the model and leave the replay on the previous request
						// rather than pairing this URL and headers with a body we do not
						// have.
						adoptOutgoingRequest(
							outgoing.request,
							outgoing.bodyText,
							nextModel,
						);
					} else {
						adoptOutgoingRequest(
							retryTransformedRequest,
							retryTransformedBodyText,
							nextModel,
						);
					}

					rawResponse = await checkZai1305(
						rawResponse,
						account,
						retryTransformedRequest,
						log,
					);
					zai1305AlreadyChecked = true;
					if (!(await isModelUnavailableError(rawResponse.clone()))) {
						break; // Success — stop cycling
					}
				}
			}

			// If still unavailable/rate-limited after exhausting the model list,
			// failover to the next account. OpenAI-compatible providers never set
			// isRateLimited:true in parseRateLimit, so we must handle it here.
			// Skip the peek if the model-cycling loop above already classified
			// this exact rawResponse via its own checkZai1305 call — re-peeking
			// would add up to another SSE_PEEK_TIMEOUT_MS of latency and drain
			// an already-drained clone for nothing.
			if (!zai1305AlreadyChecked) {
				rawResponse = await checkZai1305(
					rawResponse,
					account,
					outgoing.request,
					log,
				);
			}
			if (await isModelUnavailableError(rawResponse)) {
				log.warn(
					`All models exhausted on account ${account.name}, failing over to next account`,
				);
				// Mark account rate-limited for 1 hour so that isAccountAvailable()
				// excludes it from future requests until the cooldown expires.
				// Without this write the DB state stays stale (rate_limited_until = null)
				// and the same account is retried on every subsequent request.
				// Only fire for genuine rate-limit responses (429); model-not-found
				// (404/400) is a configuration issue, not account exhaustion.
				if (rawResponse.status === 429) {
					// Same keepalive-skip as the no-fallback path above: synthetic
					// keepalive bursts can trip Anthropic's per-IP limit even when
					// individual accounts are healthy.
					const isKeepalive = isInternalProbe(req.headers, ctx, "keepalive");
					if (isKeepalive) {
						log.warn(
							`Keepalive replay for ${account.name} got 429 (post-model-list) — skipping cooldown`,
						);
					} else {
						const cooldownUntil = extractCooldownUntil(
							rawResponse,
							account.id,
							usageCache.getRateLimitedUntil.bind(usageCache),
						);
						const reason: RateLimitReason = "all_models_exhausted_429";
						applyRateLimitCooldown(
							account,
							{ resetTime: cooldownUntil, reason },
							ctx,
						);
						const responseTime = Date.now() - requestMeta.timestamp;
						const modelRewrite = isModelRewrite(
							requestMeta.originalModel,
							requestMeta.appliedModel,
						);
						ctx.asyncWriter.enqueue(() =>
							ctx.dbOps.saveRequest(
								crypto.randomUUID(),
								req.method,
								url.pathname,
								account.id,
								429,
								false,
								reason,
								responseTime,
								failoverAttempts,
								requestedModel ? { model: requestedModel } : undefined,
								requestMeta.agentUsed ?? undefined,
								apiKeyId ?? undefined,
								apiKeyName ?? undefined,
								requestMeta.project ?? null,
								undefined,
								requestMeta.comboName ?? null,
								modelRewrite ? (requestMeta.originalModel ?? null) : null,
								modelRewrite ? (requestMeta.appliedModel ?? null) : null,
								requestMeta.projectAttributionSource ?? null,
								requestMeta.agentAttributionSource ?? null,
								null,
								requestMeta.clientSessionId ?? null,
							),
						);
					}
				}
				cancelDiscardedResponseBody(rawResponse);
				return null;
			}
		}

		// Inject request metadata into response headers so providers can read
		// stream intent and request ID without needing the original request object.
		const responseHeaders = new Headers(rawResponse.headers);
		responseHeaders.set("x-better-ccflare-request-id", requestMeta.id);
		const internalRequestStream = outgoing.request.headers.get(
			"x-better-ccflare-request-stream",
		);
		if (internalRequestStream === "true" || internalRequestStream === "false") {
			responseHeaders.set(
				"x-better-ccflare-request-stream",
				internalRequestStream,
			);
		}
		const internalCustomTools = outgoing.request.headers.get(
			"x-better-ccflare-codex-custom-tools",
		);
		if (internalCustomTools === "true" || internalCustomTools === "false") {
			responseHeaders.set(
				"x-better-ccflare-codex-custom-tools",
				internalCustomTools,
			);
		}
		const internalNativeResponses = outgoing.request.headers.get(
			"x-better-ccflare-native-responses",
		);
		if (
			internalNativeResponses === "true" ||
			internalNativeResponses === "false"
		) {
			responseHeaders.set(
				"x-better-ccflare-native-responses",
				internalNativeResponses,
			);
		}
		// Inject the original request path so providers can identify the
		// response type (e.g. /v1/models vs /v1/messages) in processResponse
		// without needing the original request object.
		responseHeaders.set("x-better-ccflare-request-path", requestMeta.path);
		const taggedRawResponse = new Response(rawResponse.body, {
			status: rawResponse.status,
			statusText: rawResponse.statusText,
			headers: responseHeaders,
		});

		// Process response (transform format, sanitize headers, etc.) using account-specific provider
		let response = await provider.processResponse(
			taggedRawResponse,
			account,
			req.headers,
			drainAbortController,
			{ requestModel: outgoing.model || null },
		);

		// Failover to next account on upstream 401 — credentials are invalid/expired
		if (response.status === 401) {
			log.warn(
				`Authentication failed (401) for account ${account.name}, failing over to next account`,
			);
			cancelDiscardedResponseBody(response);
			return null;
		}

		// Re-issues this request on the same account, once. Shared by the 529
		// overload retry loop and the transient-5xx retry loop below so the two
		// cannot drift apart — every metadata detail here was a bug fixed once
		// already and must not be re-derived per call site.
		const reissueRequestInPlace = async (): Promise<Response> => {
			// Rebuild from the buffered body text instead of a pre-cloned
			// Request — an unread clone branch retains its native buffer (#382).
			const retryRequest = new Request(outgoing.request.url, {
				method: outgoing.request.method,
				headers: outgoing.request.headers,
				body: outgoing.bodyText || undefined,
				signal: req.signal,
			});
			const retryRaw = isSyntheticProviderResponse(retryRequest)
				? materializeSyntheticResponse(retryRequest)
				: await forwardUpstream(retryRequest);

			// Mirror the first response's metadata tagging: providers read
			// stream intent / custom-tool state from these headers, and the
			// map fallback behind them has a 30s TTL a long backoff can
			// outlive — the request ID alone is not enough.
			const retryTaggedHeaders = new Headers(retryRaw.headers);
			retryTaggedHeaders.set("x-better-ccflare-request-id", requestMeta.id);
			for (const forwarded of [
				"x-better-ccflare-request-stream",
				"x-better-ccflare-codex-custom-tools",
				"x-better-ccflare-native-responses",
			]) {
				const value = outgoing.request.headers.get(forwarded);
				if (value === "true" || value === "false") {
					retryTaggedHeaders.set(forwarded, value);
				}
			}
			retryTaggedHeaders.set("x-better-ccflare-request-path", requestMeta.path);
			const retryTaggedRaw = new Response(retryRaw.body, {
				status: retryRaw.status,
				statusText: retryRaw.statusText,
				headers: retryTaggedHeaders,
			});
			return provider.processResponse(
				retryTaggedRaw,
				account,
				req.headers,
				drainAbortController,
				{ requestModel: outgoing.model || null },
			);
		};

		// True once either in-place retry loop has replaced `response` with the
		// response a retry produced. The upstream-error classification chain ran
		// on the FIRST response only, so a retry that answers 403/429 still has to
		// be put through it — see the reclassification after the loops.
		let retriedInPlace = false;

		// In-place retry for reset-less 529 (overloaded_error) — bounded attempts with
		// full-jitter exponential backoff before applying account cooldown. This prevents
		// all accounts cooling simultaneously under concurrency spikes. Skipped for
		// synthetic (keepalive / auto-refresh) requests to avoid loop amplification.
		if (response.status === 529 && !isSyntheticInternal) {
			// No clone: parseRateLimit is synchronous (providers/types.ts) and
			// reads only headers and status, so it cannot touch the body. Cloning
			// here teed the body into a second stream that nothing ever read or
			// disposed of — one orphan per 529, plus one per in-place retry
			// below. See issue #354.
			const rlInfo = provider.parseRateLimit(response);
			// Do NOT gate on rlInfo.isRateLimited: ZaiProvider.parseRateLimit
			// returns isRateLimited only for 429, so on a 529 it always answers
			// false and this whole branch was dead for zai accounts — the very
			// overload case it exists for. We are already inside `status === 529`;
			// resetTime alone decides in-place retry vs. cooldown.
			if (!rlInfo.resetTime) {
				const retryCfg = getOverloadRetryConfig();
				if (retryCfg.enabled && retryCfg.maxAttempts > 1) {
					for (let attempt = 1; attempt < retryCfg.maxAttempts; attempt++) {
						// Full-jitter backoff: sleep in [0, min(base * 2^attempt, max)]
						const cap = Math.min(
							retryCfg.baseMs * 2 ** attempt,
							retryCfg.maxMs,
						);
						const delayMs = Math.random() * cap;
						await new Promise<void>((resolve) => setTimeout(resolve, delayMs));

						log.info(
							`Account ${account.name}: in-place retry ${attempt}/${retryCfg.maxAttempts - 1} after ${Math.round(delayMs)}ms for 529 overloaded_error`,
						);

						// Drain BEFORE re-issuing, not after: the decision to retry
						// has already made this body dead, and a re-issue that
						// rejects (connection reset on the second call is the
						// common one) unwinds straight to the outer catch, which
						// fails over without ever reaching a drain placed after
						// the await. That left the whole 529 body holding its
						// off-heap backing store until GC — issue #273.
						cancelDiscardedResponseBody(response);
						const retryResponse = await reissueRequestInPlace();
						response = retryResponse;
						retriedInPlace = true;

						// If credentials expired mid-retry, break out and let the 401
						// failover guard below handle it (return null → try next account).
						if (retryResponse.status === 401) {
							break;
						}

						if (retryResponse.status !== 529) {
							log.info(
								`Account ${account.name}: 529 resolved on retry ${attempt} (status ${retryResponse.status})`,
							);
							break;
						}

						// Header-only read, see the note on the first parseRateLimit
						// call above — the retry response must not be teed either.
						const retryRlInfo = provider.parseRateLimit(retryResponse);
						// Same reason as the entry guard above: isRateLimited is
						// always false here for zai, so this broke out after a
						// single retry and silently capped the budget at 1.
						// Status is known to be 529 here — only a reset hint stops us.
						if (retryRlInfo.resetTime) {
							// Got a reset hint on retry — stop; let processProxyResponse apply cooldown
							break;
						}
					}
					if (response.status === 529) {
						log.warn(
							`Account ${account.name}: all ${retryCfg.maxAttempts - 1} in-place 529 retries exhausted, applying cooldown and failing over`,
						);
					}
				}
			}
		}

		// Transient upstream server error (500/502/503/504) — retry once in place,
		// then bench the account briefly and fail over. Production (2026-09-13):
		// Anthropic returned 500 for one organization after 36-60s of processing,
		// four times in 20 minutes, while a sibling account served the same
		// traffic normally. Every one was forwarded straight to the client with
		// failover_attempts=0, and because the session strategy pins a session to
		// one account, every session of that operator kept landing on the broken
		// org until they paused the account by hand.
		//
		// Status precedes the body, so nothing has reached the client yet: this
		// is safe for streaming and non-streaming requests alike. Skipped for
		// synthetic (keepalive / auto-refresh) requests, like the 529 path — a
		// probe must not amplify an upstream outage into extra traffic, and its
		// failure is not a client-visible request.
		//
		// BUDGET STACKING WITH THE 529 BLOCK ABOVE — the two loops have separate
		// budgets, not a shared counter, and only one order stacks:
		//
		//   529 → retry → 500: the 529 loop breaks on `status !== 529`, then this
		//     block enters with a full, fresh budget. At the defaults that is up
		//     to three upstream calls on one account (original + one 529 retry +
		//     one 5xx retry) before the bench and the failover.
		//   500 → retry → 529: this loop stops (529 is deliberately not a
		//     transient-5xx status), no 5xx bench is applied, and the 529 block
		//     cannot run again because it already did. The overload cooldown is
		//     applied downstream by processProxyResponse instead. Two calls, one
		//     budget.
		//
		// With N = CCFLARE_OVERLOAD_RETRY_MAX_ATTEMPTS the worst case in the first
		// order is 1 + (N-1) + (N-1) = 2N-1 upstream calls on one account, so
		// raising N grows that count linearly with a factor of two, and each
		// call can take as long as the slow 5xx that triggered it.
		// True once the block below has benched this account for a transient 5xx
		// AND fallen through instead of failing over (terminal candidate
		// account). Consumed by processProxyResponse, which must not re-classify
		// an already-classified server error as a quota rate limit.
		let terminalServerErrorBenched = false;
		if (
			isTransientServerErrorStatus(response.status) &&
			!isSyntheticInternal &&
			getServerErrorRetryEnabled()
		) {
			const retryCfg = getOverloadRetryConfig();
			let attemptsMade = 1;

			if (retryCfg.enabled && retryCfg.maxAttempts > 1) {
				for (let attempt = 1; attempt < retryCfg.maxAttempts; attempt++) {
					// `x-should-retry: false` is the upstream telling us the
					// response in hand is deterministic for this request.
					// Anthropic sends it on the 500s that a replay cannot fix;
					// re-issuing then just burns another 36-60s of upstream
					// processing before the same answer comes back.
					//
					// Re-read at the top of every iteration, not once before the
					// loop: with a budget above 2 (CCFLARE_OVERLOAD_RETRY_MAX_
					// ATTEMPTS >= 3) a retry response carrying the header has to
					// stop the loop too, not just the original response.
					if (response.headers.get("x-should-retry") === "false") break;

					// Full-jitter backoff, identical to the 529 loop: sleep in
					// [0, min(base * 2^attempt, max)].
					const cap = Math.min(retryCfg.baseMs * 2 ** attempt, retryCfg.maxMs);
					const delayMs = Math.random() * cap;
					await new Promise<void>((resolve) => setTimeout(resolve, delayMs));

					log.info(
						`Account ${account.name}: in-place retry ${attempt}/${retryCfg.maxAttempts - 1} after ${Math.round(delayMs)}ms for upstream ${response.status}`,
					);

					// Drain before the re-issue, for the reason spelled out in the
					// 529 loop above: a rejecting re-issue must not strand this
					// body. Only the body is consumed — the `x-should-retry`
					// header read at the top of the next iteration still works.
					cancelDiscardedResponseBody(response);
					const retryResponse = await reissueRequestInPlace();
					response = retryResponse;
					retriedInPlace = true;
					attemptsMade++;

					// A 401 mid-retry means the credentials died, not the upstream:
					// let the 401 guard below fail over without a server-error bench.
					if (retryResponse.status === 401) break;

					if (!isTransientServerErrorStatus(retryResponse.status)) {
						log.info(
							`Account ${account.name}: upstream server error resolved on retry ${attempt} (status ${retryResponse.status})`,
						);
						break;
					}
				}
			}

			if (isTransientServerErrorStatus(response.status)) {
				// A Retry-After shorter than the fixed bench is honored literally;
				// applyRateLimitCooldown clamps anything longer to the cooldown.
				const retryAfterUntil = parseRetryAfterUntil(response, Date.now());
				const reason: RateLimitReason = "upstream_5xx_server_error";
				applyRateLimitCooldown(
					account,
					retryAfterUntil != null
						? { reason, resetTime: retryAfterUntil }
						: { reason },
					ctx,
				);
				// Report the bench that was actually applied — the forward guard
				// in applyRateLimitCooldown keeps a longer active cooldown instead
				// of this one, and the log should say what is true.
				const benchMs = Math.max(
					0,
					(account.rate_limited_until ?? Date.now()) - Date.now(),
				);
				// On the last candidate account, fall through instead of failing
				// over: the account loop has nowhere left to go, and the client
				// learns more from the real upstream status than from a synthetic
				// pool_exhausted. Mirrors the terminal-529 handling below — the
				// bench still applies, and response-processor.ts deliberately does
				// not clear it on a 5xx.
				const isTerminalAttempt = returnRateLimitedResponseOnExhaustion;
				log.warn(
					`Account ${account.name}: upstream ${response.status} after ${attemptsMade} attempt(s), benching for ${benchMs} ms and ${
						isTerminalAttempt
							? "forwarding the upstream response (last candidate account)"
							: "failing over"
					}`,
				);

				if (!isTerminalAttempt) {
					// Audit row for the attempt that failed here. The whole block
					// already runs only for real traffic (`!isSyntheticInternal`
					// gates it above), so no second synthetic check is needed —
					// unlike the org_permission_denied branch, which benches
					// probes too and therefore guards its own row.
					//
					// Without this row the attempt disappears: the account that
					// picks the request up next writes the only history entry, and
					// it carries neither the 5xx status nor the seconds burned
					// here. That is exactly the data the 2026-09-13 incident was
					// diagnosed from.
					let requestedModel: string | null = null;
					if (effectiveBodyBuffer)
						requestedModel = effectiveBodyContext.getModel();
					const responseTime = Date.now() - requestMeta.timestamp;
					const modelRewrite = isModelRewrite(
						requestMeta.originalModel,
						requestMeta.appliedModel,
					);
					const failedStatus = response.status;
					ctx.asyncWriter.enqueue(() =>
						ctx.dbOps.saveRequest(
							crypto.randomUUID(),
							req.method,
							url.pathname,
							account.id,
							failedStatus,
							false,
							reason,
							responseTime,
							failoverAttempts,
							requestedModel ? { model: requestedModel } : undefined,
							requestMeta.agentUsed ?? undefined,
							apiKeyId ?? undefined,
							apiKeyName ?? undefined,
							requestMeta.project ?? null,
							undefined,
							requestMeta.comboName ?? null,
							modelRewrite ? (requestMeta.originalModel ?? null) : null,
							modelRewrite ? (requestMeta.appliedModel ?? null) : null,
							requestMeta.projectAttributionSource ?? null,
							requestMeta.agentAttributionSource ?? null,
							null,
							requestMeta.clientSessionId ?? null,
						),
					);
					cancelDiscardedResponseBody(response);
					return null;
				}
				terminalServerErrorBenched = true;
			}
		}

		// Re-check 401 after an in-place retry — credentials might have been revoked
		// between the initial 529/5xx and a retry response. The guard above only
		// covered the initial response; a retry 401 would have updated `response` and
		// broken out of the loop, so we need to catch it here before forwarding to
		// the client.
		if (response.status === 401) {
			log.warn(
				`Authentication failed (401) on in-place retry for account ${account.name}, failing over to next account`,
			);
			cancelDiscardedResponseBody(response);
			return null;
		}

		// A retry can answer something the first attempt did not, and every
		// upstream-error classification in this function ran before the loops.
		// Without this, `500 → 403 permission_error` handed the client the 403
		// with the account unbenched and still first in the priority order,
		// while the identical 403 on the first attempt benched and failed over;
		// `500 → 429 out_of_credits` took a generic quota bench with a streak
		// bump instead of the model-scoped, bench-free handling it has earned.
		//
		// Statuses the loops themselves own are excluded by construction: a 5xx
		// or a 529 in hand here is a response the loop already gave up on, and
		// its own bench/cooldown is the classification. Nothing below can start
		// another retry loop either — every handler in the chain returns.
		if (
			retriedInPlace &&
			!isTransientServerErrorStatus(response.status) &&
			response.status !== 529
		) {
			const retryOutcome = await classifyRetriedUpstreamResponse(response);
			if (retryOutcome !== NOT_CLASSIFIED) return retryOutcome;
		}

		// Check for rate limit using account-specific provider.
		//
		// The clone exists only for the terminal-529 path, where `response`
		// itself still has to reach the client afterwards. It cannot be dropped
		// like the header-only parseRateLimit calls above, because
		// processProxyResponse may read the body (updateAccountMetadata's usage
		// extraction). Whatever it does not read stays an open tee branch that
		// keeps buffering for the client-facing twin, so it is disposed of via
		// drainBody right after — not body.cancel(), which is a measured no-op
		// leak on Bun (see discard-body-cancel.ts). See issue #354.
		const needsRateLimitCheckClone =
			returnRateLimitedResponseOnExhaustion && response.status === 529;
		const responseForRateLimitCheck = needsRateLimitCheckClone
			? response.clone()
			: response;
		const isRateLimited = await processProxyResponse(
			responseForRateLimitCheck,
			account,
			{
				...ctx,
				provider,
			},
			requestMeta.id,
			requestMeta,
			// Terminal transient 5xx: the bench above is this response's
			// classification, and processProxyResponse must not replace it with
			// a quota cooldown just because the provider found a rate-limit
			// header on it. Reporting "not rate-limited" also routes the
			// response into the ordinary forwardToClient below, so the client
			// sees the real upstream status and body — which is why the
			// terminal-529 branch (and its clone) needs no counterpart here:
			// that branch exists to forward a response processProxyResponse
			// classified as rate-limited, and this one never is.
			{ serverErrorBenchApplied: terminalServerErrorBenched },
		);
		if (needsRateLimitCheckClone) {
			cancelDiscardedResponseBody(responseForRateLimitCheck);
		}
		if (isRateLimited) {
			if (returnRateLimitedResponseOnExhaustion && response.status === 529) {
				log.warn(
					`Account ${account.name} returned final 529 overload response — forwarding upstream response instead of pool_exhausted`,
				);
				return forwardToClient(
					{
						requestId: requestMeta.id,
						method: req.method,
						path: url.pathname,
						account,
						requestHeaders: req.headers,
						requestBody: effectiveBodyBuffer,
						project: requestMeta.project,
						clientSessionId: requestMeta.clientSessionId ?? null,
						query: url.search || null,
						projectAttributionSource:
							requestMeta.projectAttributionSource ?? null,
						response,
						timestamp: requestMeta.timestamp,
						retryAttempt: 0,
						failoverAttempts,
						agentUsed: requestMeta.agentUsed,
						originalModel: requestMeta.originalModel,
						appliedModel: requestMeta.appliedModel,
						agentAttributionSource: requestMeta.agentAttributionSource ?? null,
						comboName: requestMeta.comboName,
						apiKeyId,
						apiKeyName,
						drainAbort: drainAbortController,
					},
					{ ...ctx, provider },
				);
			}
			cancelDiscardedResponseBody(response);
			return null; // Signal to try next account
		}

		// Forward response to client
		return forwardToClient(
			{
				requestId: requestMeta.id,
				method: req.method,
				path: url.pathname,
				account,
				requestHeaders: req.headers,
				requestBody: effectiveBodyBuffer,
				project: requestMeta.project,
				clientSessionId: requestMeta.clientSessionId ?? null,
				query: url.search || null,
				projectAttributionSource: requestMeta.projectAttributionSource ?? null,
				response,
				timestamp: requestMeta.timestamp,
				retryAttempt: 0,
				failoverAttempts,
				agentUsed: requestMeta.agentUsed,
				originalModel: requestMeta.originalModel,
				appliedModel: requestMeta.appliedModel,
				agentAttributionSource: requestMeta.agentAttributionSource ?? null,
				comboName: requestMeta.comboName,
				apiKeyId,
				apiKeyName,
				drainAbort: drainAbortController,
			},
			{ ...ctx, provider },
		);
	} catch (err) {
		// A client disconnect now aborts the upstream fetch by design. That is
		// not an account failure: returning null would send the proxy through
		// every remaining account and every fallback route for a request nobody
		// is listening to, and report "all accounts failed" at the end.
		// `req.signal` is the discriminator — the header-phase timeout aborts
		// only the internal controller and never touches it, so genuine timeouts
		// still fail over. 499 mirrors nginx's "Client Closed Request"; the
		// socket is gone, so the status matters only for the log and the record.
		if (req.signal.aborted) {
			log.info(
				`Client disconnected during request to ${account.name} — ending instead of failing over`,
			);
			return new Response(null, { status: 499 });
		}
		handleProxyError(err, account, log);
		return null;
	}
}

/**
 * Floor for `Retry-After` when no recovery time is known (cooldown cleared and
 * usage reset unknown). Tuned to the UsageCache TTL (10 minutes — see
 * providers/src/usage-fetcher.ts:1065) so a client that respects this header
 * is guaranteed to see fresh usage telemetry on retry. Pre-fix this was the
 * optimistic 60s that triggered CLAUDE_CODE_MAX_RETRIES=5 clients to die in
 * 300s during an approximately two-hour outage (production trace).
 */
export const POOL_EXHAUSTED_UNKNOWN_RESET_RETRY_AFTER_SECONDS = 600;

/** Upper bound on Retry-After so clients don't sleep through a recovery. */
export const POOL_EXHAUSTED_MAX_RETRY_AFTER_SECONDS = 3600;

/**
 * Top-level error.type values produced by createPoolExhaustedResponse.
 *
 * `pool_exhausted` means "every account is genuinely exhausted (rate-limited,
 * usage-capped, paused, requires reauth, or otherwise filtered out)".
 * `circuit_open` means "the circuit breaker is refusing this account". The
 * wire shape stays identical — only `error.type` and `accounts[].reason`
 * differ — so SDK clients keep treating the response as a 503 transient.
 * Downstream consumers that need to differentiate (e.g. the AO fleet reaper)
 * read the JSON body.
 */
export type PoolExhaustionKind = "pool_exhausted" | "circuit_open";

/**
 * Per-account reason values emitted in `accounts[].reason`.
 *
 * `circuit_open` is distinct from the other values: it means the breaker
 * refused this account, NOT that the account's cooldown is expired. Reporting
 * a circuit-open account as `rate_limited` would mislead the reaper into
 * pausing session spawns for the wrong reason.
 */
export type PoolExhaustionAccountReason =
	| "requires_reauth"
	| "paused"
	| "usage_exhausted"
	| "rate_limited"
	| "circuit_open"
	| "unavailable";

/**
 * Default Retry-After (seconds) for the `circuit_open` response. Matches the
 * breaker's `OPEN_COOLDOWN_MS` so a polite client that respects Retry-After
 * will retry exactly when the breaker is most likely to admit a half-open
 * probe. Only used as a floor when no usage/cooldown recovery time is known
 * or is sooner than this — see `retryAfterSeconds` below.
 */
const CIRCUIT_OPEN_RETRY_AFTER_SECONDS = 30;

/**
 * Create a 503 Service Unavailable response when the account pool is exhausted.
 * All accounts are paused, rate-limited, usage-exhausted, circuit-open, or
 * filtered out.
 *
 * Usage-aware: `usageSnapshots` (keyed by account.id) lets the function surface
 * a `usage_exhausted` reason for accounts with no `rate_limited_until` cooldown
 * — otherwise those would fall through to the `unavailable` bucket and the
 * client would receive an optimistic `Retry-After: 60`, never reaching the
 * upstream reset. The caller is responsible for sourcing snapshots from
 * `usageCache` (or its own snapshot provider); the function itself stays pure
 * and testable without touching I/O.
 *
 * `kind: "circuit_open"` overrides every per-account reason to `circuit_open`
 * — the account's own state (paused, rate-limited, usage-exhausted) is
 * irrelevant when the breaker itself is the gate refusing the request. The
 * Retry-After is still the longer of the breaker's cooldown and any known
 * usage/rate-limit recovery time: a 30s breaker hint on an account that is
 * also usage-capped for hours would otherwise lie to the client about when
 * capacity actually returns.
 *
 * @param accounts - All accounts that were considered but are unavailable
 * @param usageSnapshots - Per-account usage telemetry (id → snapshot), used
 *   to identify usage_exhausted accounts and to derive `next_available_at` /
 *   `Retry-After` when an upstream reset time is known.
 * @param kind - Which top-level cause to report. Defaults to `"pool_exhausted"`.
 * @returns 503 response with the pool-exhausted JSON shape and Retry-After header
 */
export function createPoolExhaustedResponse(
	accounts: Account[],
	usageSnapshots?: ReadonlyMap<string, AccountUsageSnapshot>,
	kind: PoolExhaustionKind = "pool_exhausted",
): Response {
	const now = Date.now();
	const isCircuitOpen = kind === "circuit_open";

	// Build account info list — usage-exhausted outranks cooldown because the
	// client needs the longer reset horizon (weekly vs minutes-long cooldowns)
	// to avoid retrying an account upstream will reject immediately.
	// `circuit_open` outranks everything else: the breaker was the gate, so
	// the account's own state is irrelevant to why this request was refused.
	const accountInfos = accounts.map((account) => {
		const usage = usageSnapshots?.get(account.id);
		const usageExhausted =
			usage !== undefined &&
			isUsageExhausted(usage.utilization, usage.resetMs, now);

		const reason: PoolExhaustionAccountReason = isCircuitOpen
			? "circuit_open"
			: account.requires_reauth
				? "requires_reauth"
				: account.paused
					? "paused"
					: usageExhausted
						? "usage_exhausted"
						: account.rate_limited_until && account.rate_limited_until > now
							? "rate_limited"
							: "unavailable";

		let availableAt: string | null = null;
		if (!isCircuitOpen) {
			if (usageExhausted && usage?.resetMs && usage.resetMs > now) {
				availableAt = new Date(usage.resetMs).toISOString();
			} else if (
				account.rate_limited_until &&
				account.rate_limited_until > now
			) {
				availableAt = new Date(account.rate_limited_until).toISOString();
			}
		}

		return {
			name: account.name,
			reason,
			available_at: availableAt,
		};
	});

	// next_available_at / Retry-After = earliest of (active cooldown) and
	// (future usage reset). Both signals have to be considered — a
	// usage-capped account with `rate_limited_until = null` would otherwise be
	// ignored and leak an optimistic Retry-After to the client. For
	// circuit_open, the breaker's own cooldown floors the wait — but if the
	// account is ALSO usage-capped or rate-limited past that, the longer,
	// more honest wait wins (a 30s breaker hint must never undercut an hours-long
	// usage cap).
	const recoveryCandidates: number[] = [];
	for (const account of accounts) {
		if (account.rate_limited_until && account.rate_limited_until > now) {
			recoveryCandidates.push(account.rate_limited_until);
		}
		const usage = usageSnapshots?.get(account.id);
		if (
			usage &&
			isUsageExhausted(usage.utilization, usage.resetMs, now) &&
			usage.resetMs &&
			usage.resetMs > now
		) {
			recoveryCandidates.push(usage.resetMs);
		}
	}
	const earliestRecoveryMs =
		recoveryCandidates.length > 0 ? Math.min(...recoveryCandidates) : null;

	const nextAvailableAt =
		!isCircuitOpen && earliestRecoveryMs !== null
			? new Date(earliestRecoveryMs).toISOString()
			: null;

	// Retry-After: clamped to [1, MAX], with a defensible floor when no
	// recovery time is known. Mirrors model-capacity.ts's clamp semantics; the
	// floor (600s = UsageCache TTL) ensures a client retry can observe fresh
	// telemetry rather than retrying blindly against a stale snapshot.
	const usageAwareRetryAfterSeconds =
		earliestRecoveryMs !== null
			? Math.max(
					1,
					Math.min(
						POOL_EXHAUSTED_MAX_RETRY_AFTER_SECONDS,
						Math.ceil((earliestRecoveryMs - now) / 1000),
					),
				)
			: POOL_EXHAUSTED_UNKNOWN_RESET_RETRY_AFTER_SECONDS;

	// For circuit_open, take the longer of the breaker's own cooldown and any
	// KNOWN usage/rate-limit recovery — "the longer, more honest wait wins".
	// The 600s POOL_EXHAUSTED_UNKNOWN_RESET_RETRY_AFTER_SECONDS floor is a
	// pool_exhausted-specific fallback for "no telemetry at all"; it must not
	// leak into circuit_open's own 30s floor when no other recovery signal
	// is known (earliestRecoveryMs === null).
	const retryAfterSeconds = isCircuitOpen
		? earliestRecoveryMs !== null
			? Math.max(CIRCUIT_OPEN_RETRY_AFTER_SECONDS, usageAwareRetryAfterSeconds)
			: CIRCUIT_OPEN_RETRY_AFTER_SECONDS
		: usageAwareRetryAfterSeconds;

	return new Response(
		JSON.stringify({
			type: "error",
			error: {
				type: kind,
				message: ERROR_MESSAGES.POOL_EXHAUSTED,
				next_available_at: nextAvailableAt,
				accounts: accountInfos,
			},
		}),
		{
			status: 503,
			headers: {
				"Content-Type": "application/json",
				"Retry-After": String(retryAfterSeconds),
				// Wire shape stays identical regardless of kind — the cause lives
				// in `error.type`. Downstream consumers that need to differentiate
				// (fleet reaper, capacity-state consumers) read the JSON body.
				"x-better-ccflare-pool-status": "exhausted",
			},
		},
	);
}
