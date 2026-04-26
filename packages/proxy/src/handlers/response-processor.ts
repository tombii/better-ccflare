import { logError, RateLimitError } from "@better-ccflare/core";
import { Logger } from "@better-ccflare/logger";
import {
	type Provider,
	parseCodexUsageHeaders,
	usageCache,
} from "@better-ccflare/providers";
import type { Account } from "@better-ccflare/types";
import type { ProxyContext } from "./proxy-types";

const log = new Logger("ResponseProcessor");

/**
 * Handles rate limit response for an account
 * @param account - The rate-limited account
 * @param rateLimitInfo - Parsed rate limit information
 * @param ctx - The proxy context
 */
export function handleRateLimitResponse(
	account: Account,
	rateLimitInfo: ReturnType<Provider["parseRateLimit"]>,
	ctx: ProxyContext,
): void {
	if (!rateLimitInfo.resetTime) return;

	log.warn(
		`Account ${account.name} rate-limited until ${new Date(
			rateLimitInfo.resetTime,
		).toISOString()}`,
	);

	const resetTime = rateLimitInfo.resetTime;
	ctx.asyncWriter.enqueue(() =>
		ctx.dbOps.markAccountRateLimited(account.id, resetTime),
	);

	const rateLimitError = new RateLimitError(
		account.id,
		rateLimitInfo.resetTime,
		rateLimitInfo.remaining,
	);
	logError(rateLimitError, log);
}

/**
 * Updates account metadata in the background
 * @param account - The account to update
 * @param response - The response to extract metadata from
 * @param ctx - The proxy context
 * @param requestId - The request ID for usage tracking
 * @param bypassSession - Whether to bypass session tracking (for auto-refresh)
 */
export function updateAccountMetadata(
	account: Account,
	response: Response,
	ctx: ProxyContext,
	requestId?: string,
	bypassSession = false,
): void {
	// Update basic usage (with optional bypass)
	if (bypassSession) {
		// Increment request count without updating session tracking
		ctx.asyncWriter.enqueue(async () => {
			// Manually increment request count and total requests without touching session
			const db = ctx.dbOps.getAdapter();
			const now = Date.now();
			await db.run(
				`UPDATE accounts
				 SET last_used = ?, request_count = request_count + 1, total_requests = total_requests + 1
				 WHERE id = ?`,
				[now, account.id],
			);
		});
	} else {
		ctx.asyncWriter.enqueue(() => ctx.dbOps.updateAccountUsage(account.id));
	}
	// Extract and update rate limit info for every response
	const rateLimitInfo = ctx.provider.parseRateLimit(response);
	// Only update rate limit metadata when we have actual rate limit headers
	if (rateLimitInfo.statusHeader) {
		const status = rateLimitInfo.statusHeader;
		ctx.asyncWriter.enqueue(() =>
			ctx.dbOps.updateAccountRateLimitMeta(
				account.id,
				status,
				rateLimitInfo.resetTime ?? null,
				rateLimitInfo.remaining,
			),
		);
	}
	// Note: rate_limited_until is cleared unconditionally in processProxyResponse on any
	// successful response. No need to duplicate that logic here.

	if (account.provider === "codex") {
		const codexUsage = parseCodexUsageHeaders(response.headers, {
			defaultUtilization: response.status === 429 ? 100 : 0,
		});
		if (codexUsage) {
			const prevUsage = usageCache.get(account.id);
			const prevResetAt = (
				prevUsage as { five_hour?: { resets_at: string | null } } | null
			)?.five_hour?.resets_at;
			const newResetAt = codexUsage.five_hour?.resets_at;
			const windowRolledOver =
				prevResetAt != null &&
				newResetAt != null &&
				newResetAt !== prevResetAt &&
				new Date(newResetAt).getTime() > new Date(prevResetAt).getTime();

			usageCache.set(account.id, codexUsage);
			log.debug(
				`Updated Codex usage cache for ${account.name}: 5h=${codexUsage.five_hour.utilization}%, 7d=${codexUsage.seven_day.utilization}%`,
			);

			// Update rate_limit_reset from usage headers so auto-refresh can track windows
			const resetTimes = [
				codexUsage.five_hour?.resets_at,
				codexUsage.seven_day?.resets_at,
			]
				.filter((t): t is string => t != null)
				.map((t) => new Date(t).getTime());
			if (resetTimes.length > 0) {
				const earliestReset = Math.min(...resetTimes);
				ctx.asyncWriter.enqueue(() =>
					ctx.dbOps
						.getAdapter()
						.run("UPDATE accounts SET rate_limit_reset = ? WHERE id = ?", [
							earliestReset,
							account.id,
						]),
				);
			}

			if (windowRolledOver) {
				log.info(
					`Codex window rolled over for ${account.name}: ${prevResetAt} → ${newResetAt}, resetting session`,
				);
				ctx.dbOps
					.resetAccountSession(account.id, Date.now())
					.catch((err) =>
						log.warn(
							`Failed to reset Codex session for ${account.name} on window reset: ${err}`,
						),
					);
			}
		}
	}

	// Extract usage info if supported
	if (requestId) {
		// For streaming responses, prefer parseUsage (handles SSE final events)
		// For non-streaming, use extractUsageInfo (handles JSON responses)
		const isStream = ctx.provider.isStreamingResponse?.(response) ?? false;

		if (isStream && ctx.provider.parseUsage) {
			const parseUsage = ctx.provider.parseUsage.bind(ctx.provider);
			(async () => {
				try {
					const usageInfo = await parseUsage(response.clone() as Response);
					if (usageInfo) {
						log.debug(
							`Extracted streaming usage for account ${account.name}: ${JSON.stringify(usageInfo)}`,
						);
						// Store usage info in database
						try {
							await ctx.asyncWriter.enqueue(() =>
								ctx.dbOps.updateRequestUsage(requestId, usageInfo),
							);
						} catch (error) {
							log.warn(`Failed to save usage for request ${requestId}:`, error);
						}
					}
				} catch (error) {
					log.warn(
						`Failed to extract streaming usage for account ${account.name}:`,
						error,
					);
				}
			})();
		} else if (ctx.provider.extractUsageInfo) {
			const extractUsageInfo = ctx.provider.extractUsageInfo.bind(ctx.provider);
			(async () => {
				try {
					const usageInfo = await extractUsageInfo(
						response.clone() as Response,
					);
					if (usageInfo) {
						log.debug(
							`Extracted usage info for account ${account.name}: ${JSON.stringify(usageInfo)}`,
						);
						// Store usage info in database
						try {
							await ctx.asyncWriter.enqueue(() =>
								ctx.dbOps.updateRequestUsage(requestId, usageInfo),
							);
						} catch (error) {
							log.warn(`Failed to save usage for request ${requestId}:`, error);
						}
					}
				} catch (error) {
					log.warn(
						`Failed to extract usage info for account ${account.name}:`,
						error,
					);
				}
			})();
		}
	}
}

/**
 * Processes a successful proxy response
 * @param response - The provider response
 * @param account - The account used
 * @param ctx - The proxy context
 * @param requestId - The request ID for usage tracking
 * @returns Promise resolving to whether the response is rate-limited
 */
export async function processProxyResponse(
	response: Response,
	account: Account,
	ctx: ProxyContext,
	requestId?: string,
	requestMeta?: { headers?: Headers },
): Promise<boolean> {
	let rateLimitInfo = ctx.provider.parseRateLimit(response);

	// For Zai provider, if we got a 429 without resetTime, try parsing the body
	if (
		rateLimitInfo.isRateLimited &&
		!rateLimitInfo.resetTime &&
		account.provider === "zai" &&
		response.status === 429
	) {
		// Try to parse reset time from response body
		const provider = ctx.provider;
		if ("parseRateLimitFromBody" in provider) {
			const bodyResetTime = await (
				provider as Provider & {
					parseRateLimitFromBody: (
						response: Response,
					) => Promise<number | null>;
				}
			).parseRateLimitFromBody(response);
			if (bodyResetTime) {
				rateLimitInfo = {
					...rateLimitInfo,
					resetTime: bodyResetTime,
				};
			}
		}
	}

	// Handle rate limit
	//
	// We deliberately do NOT exclude streaming responses here. A rate-limited
	// account is rate-limited regardless of whether the response that revealed
	// it was a stream — and the failover decision (returning true to signal
	// the next-account loop) is safe at this point because no response bytes
	// have been written to the client yet. The proxy hasn't entered the
	// `forwardToClient` path; it's still inspecting the upstream response.
	//
	// In practice the most common pre-stream 429 has
	// `content-type: application/json` because Anthropic only opens an SSE
	// stream when the request is accepted, but the historic `!isStream` guard
	// here was a footgun: providers that emit `text/event-stream` 429s, or
	// future provider transforms that preserve the requested content-type on
	// errors, would silently bypass marking and failover. The mid-stream case
	// (status 200 with an SSE `event: error` frame partway through the body)
	// is handled separately by the streaming forwarder — see issue #114.
	if (rateLimitInfo.isRateLimited) {
		if (rateLimitInfo.resetTime) {
			handleRateLimitResponse(account, rateLimitInfo, ctx);
		} else {
			// Mark as rate-limited even without reset time
			log.warn(
				`Account ${account.name} rate-limited but no reset time available`,
			);
			ctx.asyncWriter.enqueue(() =>
				ctx.dbOps.markAccountRateLimited(
					account.id,
					Date.now() + 5 * 60 * 60 * 1000,
				),
			); // Default to 5 hours — applies to any provider without reset headers
		}
		// Also update metadata for rate-limited responses
		const bypassSession =
			requestMeta?.headers?.get("x-better-ccflare-bypass-session") === "true";
		updateAccountMetadata(account, response, ctx, requestId, bypassSession);
		return true; // Signal rate limit
	}

	// Update account metadata in background
	const bypassSession =
		requestMeta?.headers?.get("x-better-ccflare-bypass-session") === "true";
	updateAccountMetadata(account, response, ctx, requestId, bypassSession);

	// Clear rate_limited_until on any successful upstream response. We clear unconditionally
	// (even if the timestamp is still in the future) because a successful response proves the
	// account is usable — e.g. after a seat reassignment that resets usage mid-window before
	// the stored expiry fires. Only enqueue the DB write when the in-memory account object
	// already carries a rate_limited_until value to avoid overhead on every normal request.
	if (!rateLimitInfo.isRateLimited && account.rate_limited_until) {
		ctx.asyncWriter.enqueue(async () => {
			const db = ctx.dbOps.getAdapter();
			await db.run(
				"UPDATE accounts SET rate_limited_until = NULL WHERE id = ? AND rate_limited_until IS NOT NULL",
				[account.id],
			);
			log.debug(
				`Cleared rate_limited_until for account ${account.name} on successful response`,
			);
		});
	}

	return false;
}

/**
 * Handles errors that occur during proxy operations
 * @param error - The error that occurred
 * @param account - The account that failed (optional)
 * @param logger - Logger instance
 */
export function handleProxyError(
	error: unknown,
	account: Account | null,
	logger: Logger,
): void {
	logError(error, logger);
	if (account) {
		logger.error(`Failed to proxy request with account ${account.name}`);
	} else {
		logger.error("Failed to proxy request");
	}
}
