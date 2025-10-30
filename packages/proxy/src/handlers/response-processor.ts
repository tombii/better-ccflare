import { logError, RateLimitError } from "@better-ccflare/core";
import { Logger } from "@better-ccflare/logger";
import type { Provider } from "@better-ccflare/providers";
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
		ctx.asyncWriter.enqueue(() => {
			// Manually increment request count and total requests without touching session
			const db = ctx.dbOps.getDatabase();
			const now = Date.now();
			db.run(
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
	} else {
		// If there's no rate limit status header (meaning request was successful),
		// clear the rate_limited_until field if it has expired
		ctx.asyncWriter.enqueue(() => {
			const db = ctx.dbOps.getDatabase();
			const result = db
				.query<{ rate_limited_until: number | null }, [string]>(
					"SELECT rate_limited_until FROM accounts WHERE id = ?",
				)
				.get(account.id);

			if (
				result?.rate_limited_until &&
				result.rate_limited_until < Date.now()
			) {
				db.run("UPDATE accounts SET rate_limited_until = NULL WHERE id = ?", [
					account.id,
				]);
				log.debug(
					`Cleared expired rate_limited_until for account ${account.name} on successful response`,
				);
			}
		});
	}

	// Extract tier info if supported
	if (ctx.provider.extractTierInfo) {
		const _extractTierInfo = ctx.provider.extractTierInfo.bind(ctx.provider);
		(async () => {})();
	}

	// Extract usage info if supported
	if (ctx.provider.extractUsageInfo && requestId) {
		const extractUsageInfo = ctx.provider.extractUsageInfo.bind(ctx.provider);
		(async () => {
			const usageInfo = await extractUsageInfo(response.clone() as Response);
			if (usageInfo) {
				log.debug(
					`Extracted usage info for account ${account.name}: ${JSON.stringify(usageInfo)}`,
				);
				// Store usage info in database
				ctx.asyncWriter.enqueue(() =>
					ctx.dbOps.updateRequestUsage(requestId, usageInfo),
				);
			}
		})();
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
	const isStream = ctx.provider.isStreamingResponse?.(response) ?? false;
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
	if (!isStream && rateLimitInfo.isRateLimited) {
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
			); // Default to 5 hours for Zai
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

	// Clear rate_limited_until if the account was previously rate-limited but is now successful
	if (!rateLimitInfo.isRateLimited) {
		// Check if the account had a rate_limited_until value and clear it
		ctx.asyncWriter.enqueue(() => {
			const db = ctx.dbOps.getDatabase();
			// Only clear rate_limited_until if it's in the past or null (meaning it was rate-limited before)
			const result = db
				.query<{ rate_limited_until: number | null }, [string]>(
					"SELECT rate_limited_until FROM accounts WHERE id = ?",
				)
				.get(account.id);

			if (result?.rate_limited_until) {
				const now = Date.now();
				// If the rate limit was in the past (already expired) or if we're just clearing it after success
				// We clear it regardless if it's expired to ensure the account is no longer marked as rate-limited
				if (result.rate_limited_until <= now) {
					db.run("UPDATE accounts SET rate_limited_until = NULL WHERE id = ?", [
						account.id,
					]);
					log.debug(
						`Cleared expired rate_limited_until for account ${account.name}`,
					);
				}
			}
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
