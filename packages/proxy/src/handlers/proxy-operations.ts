import {
	type AccountUsageSnapshot,
	getModelFamily,
	getModelList,
	getOverloadRetryConfig,
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
	getProvider,
	isAnthropicExtraUsageExhausted,
	isAnthropicOutOfCredits,
	usageCache,
} from "@better-ccflare/providers";
import type {
	Account,
	RateLimitReason,
	RequestMeta,
} from "@better-ccflare/types";
import { cacheBodyStore } from "../cache-body-store";
import { RequestBodyContext } from "../request-body-context";
import { forwardToClient } from "../response-handler";
import { isModelRewrite } from "../worker-messages";
import { markFamilyExhausted } from "./model-capacity";
import {
	ERROR_MESSAGES,
	isInternalProbe,
	type ProxyContext,
} from "./proxy-types";
import { applyRateLimitCooldown } from "./rate-limit-cooldown";
import { makeProxyRequest, validateProviderPath } from "./request-handler";
import { handleProxyError, processProxyResponse } from "./response-processor";
import { getValidAccessToken } from "./token-manager";
import { collectWindows } from "./usage-throttling";

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
	} catch {
		// Ignore parse errors
	}

	return false;
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
		const response = await makeProxyRequest(
			targetUrl,
			req.method,
			headers,
			createBodyStream,
			!!req.body,
			// Abort upstream when the client disconnects; this path builds no
			// Request object, so the signal has to be passed explicitly.
			req.signal,
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
		// Every upstream call stays tied to the client connection: when the client
		// disconnects, the upstream fetch must be aborted instead of running on.
		// The signal is passed explicitly instead of relying on the Request object
		// to carry it, because provider body transforms rebuild the Request from
		// its URL and drop the signal (see providers/src/utils/model-mapping.ts and
		// the openai/codex providers). One guarantee at the call site beats an
		// invariant that every provider has to remember.
		const forwardUpstream = (target: Request) =>
			makeProxyRequest(
				target,
				undefined,
				undefined,
				undefined,
				undefined,
				req.signal,
			);
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
		// Synthetic-response markers are internal provider-to-proxy signals. Strip
		// client-supplied copies before providers transform the outbound request.
		headers.delete(SYNTHETIC_RESPONSE_HEADER);
		headers.delete(SYNTHETIC_STATUS_HEADER);
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

		let transformedRequest = provider.transformRequestBody
			? await provider.transformRequestBody(providerRequest, account)
			: providerRequest;

		// Pre-strip cache_control for (account, model) pairs known to reject it
		const transformedBodyText = await transformedRequest.clone().text();
		let transformedBodyJson: Record<string, unknown> | null = null;
		try {
			transformedBodyJson = JSON.parse(transformedBodyText);
		} catch {
			// ignore
		}
		const transformedModel =
			(transformedBodyJson?.model as string | undefined) ?? "";
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
			transformedRequest = new Request(transformedRequest.url, {
				method: transformedRequest.method,
				headers: transformedRequest.headers,
				body: JSON.stringify(transformedBodyJson),
				// A URL-based rebuild drops the signal — carry it over.
				signal: req.signal,
			});
			log.debug(
				`Pre-stripped cache_control for known rejector: account=${account.name} model=${transformedModel}`,
			);
		}

		// Capture a clone for in-place 529 retries before the body is consumed.
		const transformedRequestForRetry = transformedRequest.clone();

		// Make the request (or unwrap a synthetic provider response)
		let rawResponse = isSyntheticProviderResponse(transformedRequest)
			? materializeSyntheticResponse(transformedRequest)
			: await forwardUpstream(transformedRequest);

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

				const retryTransformedRequest = provider.transformRequestBody
					? await provider.transformRequestBody(retryProviderRequest, account)
					: retryProviderRequest;

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
				const retryRequest = new Request(transformedRequest.url, {
					method: transformedRequest.method,
					headers: transformedRequest.headers,
					body: JSON.stringify(retryBodyJson),
					// A URL-based rebuild drops the signal — carry it over.
					signal: req.signal,
				});
				cancelDiscardedResponseBody(rawResponse);
				rawResponse = isSyntheticProviderResponse(retryRequest)
					? materializeSyntheticResponse(retryRequest)
					: await forwardUpstream(retryRequest);
			} catch (err) {
				log.warn("Failed to retry without cache_control:", err);
			}
		}

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
			if (effectiveBodyBuffer) requestedModel = effectiveBodyContext.getModel();

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
				),
			);
			// Do not bench the account or fail over — pass Anthropic's real error
			// through to the client unchanged, same as any other 400 today.
			return withSanitizedProxyHeaders(rawResponse);
		}

		// On model unavailable / rate-limited: cycle through the model list for
		// this account. getModelList returns [primary, ...fallbacks] merged from
		// model_mappings arrays and legacy model_fallbacks. We already tried index 0
		// (the primary), so start at index 1.
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
					),
				);
				cancelDiscardedResponseBody(rawResponse);
				return null;
			}

			if (requestedModel) {
				const modelList = getModelList(requestedModel, account);
				if (!modelList || modelList.length <= 1) {
					// No fallback models configured — fail over to the next account.
					// 429s should never be forwarded to the client when other
					// accounts are available; only genuine model-not-found
					// errors (404/400) warrant returning the upstream response.
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
							),
						);
						cancelDiscardedResponseBody(rawResponse);
						return null;
					}
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
					let retryTransformedRequest = provider.transformRequestBody
						? await provider.transformRequestBody(retryProviderRequest, account)
						: retryProviderRequest;

					// Re-patch model after transformRequestBody — the provider's conversion
					// (e.g. convertAnthropicRequestToOpenAI) calls mapModelName which can
					// remap nextModel back to the primary model if it has no Claude family
					// pattern. Force nextModel into the final request body.
					try {
						const transformedText = await retryTransformedRequest
							.clone()
							.text();
						const transformedBody = JSON.parse(transformedText);
						if (transformedBody.model !== nextModel) {
							transformedBody.model = nextModel;
							const repatchedHeaders = new Headers(
								retryTransformedRequest.headers,
							);
							retryTransformedRequest = new Request(
								retryTransformedRequest.url,
								{
									method: retryTransformedRequest.method,
									headers: repatchedHeaders,
									body: JSON.stringify(transformedBody),
									// A URL-based rebuild drops the signal — carry it over.
									signal: req.signal,
								},
							);
						}
					} catch {
						// If re-patching fails, proceed with the transformed request as-is
					}

					cancelDiscardedResponseBody(rawResponse);
					rawResponse = isSyntheticProviderResponse(retryTransformedRequest)
						? materializeSyntheticResponse(retryTransformedRequest)
						: await forwardUpstream(retryTransformedRequest);

					if (!(await isModelUnavailableError(rawResponse.clone()))) {
						break; // Success — stop cycling
					}
				}
			}

			// If still unavailable/rate-limited after exhausting the model list,
			// failover to the next account. OpenAI-compatible providers never set
			// isRateLimited:true in parseRateLimit, so we must handle it here.
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
		const internalRequestStream = transformedRequest.headers.get(
			"x-better-ccflare-request-stream",
		);
		if (internalRequestStream === "true" || internalRequestStream === "false") {
			responseHeaders.set(
				"x-better-ccflare-request-stream",
				internalRequestStream,
			);
		}
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
		);

		// Failover to next account on upstream 401 — credentials are invalid/expired
		if (response.status === 401) {
			log.warn(
				`Authentication failed (401) for account ${account.name}, failing over to next account`,
			);
			cancelDiscardedResponseBody(response);
			return null;
		}

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
			if (rlInfo.isRateLimited && !rlInfo.resetTime) {
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

						const retryRaw = isSyntheticProviderResponse(
							transformedRequestForRetry,
						)
							? materializeSyntheticResponse(transformedRequestForRetry.clone())
							: await forwardUpstream(transformedRequestForRetry.clone());

						const retryTaggedHeaders = new Headers(retryRaw.headers);
						retryTaggedHeaders.set(
							"x-better-ccflare-request-id",
							requestMeta.id,
						);
						const retryTaggedRaw = new Response(retryRaw.body, {
							status: retryRaw.status,
							statusText: retryRaw.statusText,
							headers: retryTaggedHeaders,
						});
						const retryResponse = await provider.processResponse(
							retryTaggedRaw,
							account,
							req.headers,
						);

						cancelDiscardedResponseBody(response);
						response = retryResponse;

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
						if (!retryRlInfo.isRateLimited || retryRlInfo.resetTime) {
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

		// Re-check 401 after in-place retry — credentials might have been revoked
		// between the initial 529 and a retry response. The guard above only covered
		// the initial response; a retry 401 would have updated `response` and broken
		// out of the loop, so we need to catch it here before forwarding to the client.
		if (response.status === 401) {
			log.warn(
				`Authentication failed (401) on 529 retry for account ${account.name}, failing over to next account`,
			);
			cancelDiscardedResponseBody(response);
			return null;
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
 * 300s during a 116-minute ccproxy2 outage (production trace 2026-07-30).
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
