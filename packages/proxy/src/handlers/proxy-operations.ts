import {
	getModelList,
	logError,
	ProviderError,
	TIME_CONSTANTS,
} from "@better-ccflare/core";
import { Logger } from "@better-ccflare/logger";
import { stripCacheControlFromOpenAIRequest } from "@better-ccflare/openai-formats";
import { getProvider, usageCache } from "@better-ccflare/providers";
import type {
	Account,
	RateLimitReason,
	RequestMeta,
} from "@better-ccflare/types";
import { cacheBodyStore } from "../cache-body-store";
import { RequestBodyContext } from "../request-body-context";
import { forwardToClient } from "../response-handler";
import { ERROR_MESSAGES, type ProxyContext } from "./proxy-types";
import { applyRateLimitCooldown } from "./rate-limit-cooldown";
import { makeProxyRequest, validateProviderPath } from "./request-handler";
import { handleProxyError, processProxyResponse } from "./response-processor";
import { getValidAccessToken } from "./token-manager";

const log = new Logger("ProxyOperations");

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
 * Bedrock provider currently returns a synthetic Request containing the
 * provider response payload (instead of a real URL to fetch).
 * Detect and unwrap that request so we don't try to fetch a fake host.
 */
function isSyntheticProviderResponse(request: Request): boolean {
	return (
		request.headers.get("x-bedrock-response") === "true" &&
		request.url.startsWith("https://bedrock.aws/response")
	);
}

function materializeSyntheticResponse(request: Request): Response {
	const headers = new Headers(request.headers);
	headers.delete("x-bedrock-response");

	return new Response(request.body, {
		status: 200,
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
		const clone = response.clone();
		const contentType = response.headers.get("content-type");

		if (!contentType?.includes("application/json")) return false;

		const json = await clone.json();

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
		const clone = response.clone();
		const contentType = response.headers.get("content-type");
		if (!contentType?.includes("application/json")) return false;

		const json = await clone.json();
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
async function isModelUnavailableError(response: Response): Promise<boolean> {
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
		const clone = response.clone();
		const contentType = response.headers.get("content-type");
		if (!contentType?.includes("application/json")) return false;

		const json = await clone.json();

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
				response,
				timestamp: requestMeta.timestamp,
				retryAttempt: 0,
				failoverAttempts: 0,
				agentUsed: requestMeta.agentUsed,
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
): Promise<Response | null> {
	try {
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
		// Both checks are truthy (not strict-equality) to preserve the original
		// keepalive guard's behaviour: any non-empty header value triggers the
		// skip, matching what `!req.headers.get(...)` returned before.
		const isSyntheticInternal =
			!!req.headers.get("x-better-ccflare-keepalive") ||
			!!req.headers.get("x-better-ccflare-auto-refresh");
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

		// Get valid access token
		const accessToken = await getValidAccessToken(account, ctx);

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
		const targetUrl = provider.buildUrl(url.pathname, url.search, account);

		const requestInit: RequestInit & { duplex?: "half" } = {
			method: req.method,
			headers,
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
			});
			log.debug(
				`Pre-stripped cache_control for known rejector: account=${account.name} model=${transformedModel}`,
			);
		}

		// Make the request (or unwrap a synthetic provider response)
		let rawResponse = isSyntheticProviderResponse(transformedRequest)
			? materializeSyntheticResponse(transformedRequest)
			: await makeProxyRequest(transformedRequest);

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
				};

				const retryProviderRequest = new Request(targetUrl, retryRequestInit);

				const retryTransformedRequest = provider.transformRequestBody
					? await provider.transformRequestBody(retryProviderRequest, account)
					: retryProviderRequest;

				// Make the retry request (or unwrap a synthetic provider response)
				rawResponse = isSyntheticProviderResponse(retryTransformedRequest)
					? materializeSyntheticResponse(retryTransformedRequest)
					: await makeProxyRequest(retryTransformedRequest);
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
				});
				rawResponse = isSyntheticProviderResponse(retryRequest)
					? materializeSyntheticResponse(retryRequest)
					: await makeProxyRequest(retryRequest);
			} catch (err) {
				log.warn("Failed to retry without cache_control:", err);
			}
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
						const isKeepalive =
							req.headers.get("x-better-ccflare-keepalive") === "true";
						if (isKeepalive) {
							log.warn(
								`Keepalive replay for ${account.name} got 429 — skipping cooldown (synthetic burst, not a real per-account rate limit)`,
							);
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
						// Route through shared helper so the consecutive_rate_limits
						// counter and exponential backoff are applied uniformly across
						// all 429 paths. Pass cooldownUntil as resetTime — the helper
						// caps via min(resetTime, now + backoff). The audit reason is
						// preserved so saveRequest + DB rate_limited_reason both record
						// the failure-mode-specific tag.
						applyRateLimitCooldown(
							account,
							{ resetTime: cooldownUntil, reason },
							ctx,
						);
						const responseTime = Date.now() - requestMeta.timestamp;
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
								undefined,
								requestMeta.agentUsed ?? undefined,
								apiKeyId ?? undefined,
								apiKeyName ?? undefined,
								requestMeta.project ?? null,
								undefined,
								requestMeta.comboName ?? null,
							),
						);
						return null;
					}
					return rawResponse;
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
								},
							);
						}
					} catch {
						// If re-patching fails, proceed with the transformed request as-is
					}

					rawResponse = isSyntheticProviderResponse(retryTransformedRequest)
						? materializeSyntheticResponse(retryTransformedRequest)
						: await makeProxyRequest(retryTransformedRequest);

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
				// Mark account rate-limited so that isAccountAvailable() excludes it
				// from future requests until the cooldown expires. The shared
				// applyRateLimitCooldown helper computes a capped exponential-backoff
				// cooldown and writes it to the DB; without it the same account would
				// be retried on every subsequent request.
				// Only fire for genuine rate-limit responses (429); model-not-found
				// (404/400) is a configuration issue, not account exhaustion.
				if (rawResponse.status === 429) {
					// Same keepalive-skip as the no-fallback path above: synthetic
					// keepalive bursts can trip Anthropic's per-IP limit even when
					// individual accounts are healthy.
					const isKeepalive =
						req.headers.get("x-better-ccflare-keepalive") === "true";
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
						// Route through shared helper so the consecutive_rate_limits
						// counter and exponential backoff are applied uniformly across
						// all 429 paths. Pass cooldownUntil as resetTime — the helper
						// caps via min(resetTime, now + backoff). The audit reason is
						// preserved so saveRequest + DB rate_limited_reason both record
						// the failure-mode-specific tag.
						applyRateLimitCooldown(
							account,
							{ resetTime: cooldownUntil, reason },
							ctx,
						);
						const responseTime = Date.now() - requestMeta.timestamp;
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
								undefined,
								requestMeta.agentUsed ?? undefined,
								apiKeyId ?? undefined,
								apiKeyName ?? undefined,
								requestMeta.project ?? null,
								undefined,
								requestMeta.comboName ?? null,
							),
						);
					}
				}
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
		const response = await provider.processResponse(
			taggedRawResponse,
			account,
			req.headers,
		);

		// Failover to next account on upstream 401 — credentials are invalid/expired
		if (response.status === 401) {
			log.warn(
				`Authentication failed (401) for account ${account.name}, failing over to next account`,
			);
			return null;
		}

		// Check for rate limit using account-specific provider
		const isRateLimited = await processProxyResponse(
			response,
			account,
			{
				...ctx,
				provider,
			},
			requestMeta.id,
			requestMeta,
		);
		if (isRateLimited) {
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
				response,
				timestamp: requestMeta.timestamp,
				retryAttempt: 0,
				failoverAttempts,
				agentUsed: requestMeta.agentUsed,
				comboName: requestMeta.comboName,
				apiKeyId,
				apiKeyName,
			},
			{ ...ctx, provider },
		);
	} catch (err) {
		handleProxyError(err, account, log);
		return null;
	}
}

/**
 * Create a 503 Service Unavailable response when the account pool is exhausted.
 * All accounts are paused, rate-limited, or filtered out.
 * @param accounts - All accounts that were considered but are unavailable
 * @returns 503 response with pool_exhausted error and Retry-After header
 */
export function createPoolExhaustedResponse(accounts: Account[]): Response {
	const now = Date.now();

	// Build account info list
	const accountInfos = accounts.map((account) => {
		const reason = account.paused
			? "paused"
			: account.rate_limited_until && account.rate_limited_until > now
				? "rate_limited"
				: "unavailable";

		const availableAt =
			account.rate_limited_until && account.rate_limited_until > now
				? new Date(account.rate_limited_until).toISOString()
				: null;

		return {
			name: account.name,
			reason,
			available_at: availableAt,
		};
	});

	// Calculate next_available_at from earliest rate_limited_until
	const rateLimitedAccounts = accounts.filter(
		(account) => account.rate_limited_until && account.rate_limited_until > now,
	);
	const nextAvailableAt =
		rateLimitedAccounts.length > 0
			? new Date(
					Math.min(
						...rateLimitedAccounts.map(
							(account) => account.rate_limited_until!,
						),
					),
				).toISOString()
			: null;

	// Calculate Retry-After header (seconds) directly from numeric min
	const retryAfterSeconds =
		rateLimitedAccounts.length > 0
			? Math.max(
					1,
					Math.round(
						(Math.min(
							...rateLimitedAccounts.map(
								(account) => account.rate_limited_until!,
							),
						) -
							now) /
							1000,
					),
				)
			: 60; // Default 60s if no cooldown info

	return new Response(
		JSON.stringify({
			type: "error",
			error: {
				type: "pool_exhausted",
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
				"x-better-ccflare-pool-status": "exhausted",
			},
		},
	);
}
