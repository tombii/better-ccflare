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
 */
export function updateAccountMetadata(
	account: Account,
	response: Response,
	ctx: ProxyContext,
	requestId?: string,
): void {
	// Update basic usage
	ctx.asyncWriter.enqueue(() => ctx.dbOps.updateAccountUsage(account.id));

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

	// Extract tier info if supported
	if (ctx.provider.extractTierInfo) {
		const extractTierInfo = ctx.provider.extractTierInfo.bind(ctx.provider);
		(async () => {
			const tier = await extractTierInfo(response.clone() as Response);
			if (tier && tier !== account.account_tier) {
				log.info(
					`Updating account ${account.name} tier from ${account.account_tier} to ${tier}`,
				);
				ctx.asyncWriter.enqueue(() =>
					ctx.dbOps.updateAccountTier(account.id, tier),
				);
			}
		})();
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
		updateAccountMetadata(account, response, ctx, requestId);
		return true; // Signal rate limit
	}

	// Update account metadata in background
	updateAccountMetadata(account, response, ctx, requestId);
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
