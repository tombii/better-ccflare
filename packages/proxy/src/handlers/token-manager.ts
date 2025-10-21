import {
	registerDisposable,
	ServiceUnavailableError,
	TokenRefreshError,
} from "@better-ccflare/core";
import { Logger } from "@better-ccflare/logger";
import {
	getProvider,
	type TokenRefreshResult,
} from "@better-ccflare/providers";
import type { Account } from "@better-ccflare/types";
import { TOKEN_REFRESH_BACKOFF_MS, TOKEN_SAFETY_WINDOW_MS } from "../constants";
import { ERROR_MESSAGES, type ProxyContext } from "./proxy-types";

const log = new Logger("TokenManager");

// Track refresh failures for backoff with TTL cleanup
const refreshFailures = new Map<string, number>();
// Track consecutive backoff hits per account
const backoffCounters = new Map<string, number>();
const FAILURE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const MAX_FAILURE_RECORDS = 1000; // Prevent unbounded growth
const MAX_BACKOFF_RETRIES = 10; // After 10 backoff hits, check DB

// Cleanup old failures periodically
let cleanupInterval: Timer | null = null;

export const startTokenCleanupInterval = () => {
	if (!cleanupInterval) {
		cleanupInterval = setInterval(() => {
			const now = Date.now();
			const toDelete: string[] = [];

			for (const [accountId, failureTime] of refreshFailures.entries()) {
				if (now - failureTime > FAILURE_TTL_MS) {
					toDelete.push(accountId);
				}
			}

			toDelete.forEach((accountId) => refreshFailures.delete(accountId));

			if (toDelete.length > 0) {
				log.debug(`Cleaned up ${toDelete.length} expired failure records`);
			}
		}, FAILURE_TTL_MS / 10); // Run cleanup more frequently (every 30 seconds)
	}
};

export const stopTokenCleanupInterval = () => {
	if (cleanupInterval) {
		clearInterval(cleanupInterval);
		cleanupInterval = null;
	}
};

// Start cleanup interval and register for shutdown
startTokenCleanupInterval();

// Register cleanup as disposable for proper shutdown
registerDisposable({
	dispose: () => {
		stopTokenCleanupInterval();
		refreshFailures.clear();
		backoffCounters.clear();
	},
});

/**
 * Helper function to clean expired entries from refreshFailures Map
 */
function cleanupExpiredFailures(): void {
	const now = Date.now();
	const toDelete: string[] = [];

	for (const [accountId, failureTime] of refreshFailures.entries()) {
		if (now - failureTime > FAILURE_TTL_MS) {
			toDelete.push(accountId);
		}
	}

	toDelete.forEach((accountId) => {
		refreshFailures.delete(accountId);
		backoffCounters.delete(accountId); // Also clean up backoff counters
	});

	if (toDelete.length > 0) {
		log.debug(
			`Cleaned up ${toDelete.length} expired failure records during proactive cleanup`,
		);
	}
}

/**
 * Helper function to enforce maximum size limit on refreshFailures Map
 */
function enforceMaxSize(): void {
	if (refreshFailures.size > MAX_FAILURE_RECORDS) {
		// Remove oldest entries if we exceed the max size
		const _now = Date.now();
		const entries = Array.from(refreshFailures.entries()).sort(
			(a, b) => a[1] - b[1], // Sort by timestamp (oldest first)
		);

		const toRemove = entries.slice(
			0,
			refreshFailures.size - MAX_FAILURE_RECORDS + 1,
		);
		for (const [accountId] of toRemove) {
			refreshFailures.delete(accountId);
			backoffCounters.delete(accountId); // Also clean up backoff counters
		}

		if (toRemove.length > 0) {
			log.warn(
				`Removed ${toRemove.length} oldest failure records to maintain max size limit`,
			);
		}
	}
}

/**
 * Safely refreshes an access token with deduplication
 * @param account - The account to refresh token for
 * @param ctx - The proxy context
 * @returns Promise resolving to the new access token
 * @throws {TokenRefreshError} If token refresh fails
 * @throws {ServiceUnavailableError} If refresh promise is not found
 */
export async function refreshAccessTokenSafe(
	account: Account,
	ctx: ProxyContext,
): Promise<string> {
	// Proactively clean expired entries before checking
	cleanupExpiredFailures();

	// Check for recent refresh failures and implement backoff
	const lastFailure = refreshFailures.get(account.id);
	if (lastFailure && Date.now() - lastFailure < TOKEN_REFRESH_BACKOFF_MS) {
		// Increment backoff counter
		const currentCount = backoffCounters.get(account.id) || 0;
		const newCount = currentCount + 1;
		backoffCounters.set(account.id, newCount);

		log.warn(
			`Account ${account.name} is in refresh backoff period (attempt ${newCount})`,
		);

		// After MAX_BACKOFF_RETRIES consecutive backoff hits, check DB for updated tokens
		if (newCount >= MAX_BACKOFF_RETRIES) {
			log.info(
				`Account ${account.name} has hit ${newCount} backoff attempts, checking DB for updated tokens`,
			);

			try {
				// Reload account from database
				const dbAccount = ctx.dbOps.getAccount(account.id);
				if (dbAccount) {
					// Check if DB has a valid token that we don't have in memory
					const hasValidToken =
						dbAccount.access_token &&
						dbAccount.expires_at &&
						dbAccount.expires_at - Date.now() > TOKEN_SAFETY_WINDOW_MS;

					if (
						hasValidToken &&
						dbAccount.access_token !== account.access_token
					) {
						log.info(
							`Found updated token in DB for account ${account.name}, updating in-memory account`,
						);

						// Update in-memory account with DB data
						account.access_token = dbAccount.access_token;
						account.expires_at = dbAccount.expires_at;
						if (dbAccount.refresh_token) {
							account.refresh_token = dbAccount.refresh_token;
						}
						account.last_used = Date.now();

						// Clear failure records and backoff counter
						refreshFailures.delete(account.id);
						backoffCounters.delete(account.id);

						log.info(
							`Successfully recovered token for account ${account.name} from DB`,
						);
						return dbAccount.access_token;
					} else {
						log.warn(
							`DB token for account ${account.name} is not valid or same as in-memory`,
						);
					}
				} else {
					log.warn(
						`Account ${account.name} not found in DB during backoff recovery`,
					);
				}
			} catch (error) {
				log.error(
					`Failed to check DB for account ${account.name} during backoff recovery`,
					error,
				);
			}
		}

		throw new ServiceUnavailableError(
			`Token refresh for account ${account.name} is in backoff period after recent failure`,
		);
	} else {
		// Not in backoff, reset counter
		backoffCounters.delete(account.id);
	}

	// Check if a refresh is already in progress for this account
	if (!ctx.refreshInFlight.has(account.id)) {
		// Get the provider for this account
		const provider = getProvider(account.provider) || ctx.provider;

		// Create a new refresh promise and store it
		const refreshPromise = provider
			.refreshToken(account, ctx.runtime.clientId)
			.then((result: TokenRefreshResult) => {
				// 1. Persist to database asynchronously
				ctx.asyncWriter.enqueue(() =>
					ctx.dbOps.updateAccountTokens(
						account.id,
						result.accessToken,
						result.expiresAt,
						result.refreshToken,
					),
				);

				// 2. Update the live in-memory account object immediately
				// This prevents subsequent requests from seeing stale token data
				account.access_token = result.accessToken;
				account.expires_at = result.expiresAt;
				if (result.refreshToken) {
					account.refresh_token = result.refreshToken;
				}
				account.last_used = Date.now();

				// Clear any previous failure record on successful refresh
				refreshFailures.delete(account.id);

				log.info(`Successfully refreshed token for account: ${account.name}`);
				return result.accessToken;
			})
			.catch((error) => {
				// Record the failure timestamp for backoff
				refreshFailures.set(account.id, Date.now());
				// Enforce size limit after adding a new entry
				enforceMaxSize();
				log.error(`Token refresh failed for account ${account.name}`, error);
				throw new TokenRefreshError(account.id, error as Error);
			})
			.finally(() => {
				// Clean up the map when done (success or failure)
				ctx.refreshInFlight.delete(account.id);
			});
		ctx.refreshInFlight.set(account.id, refreshPromise);
	}

	// Return the existing or new refresh promise
	const promise = ctx.refreshInFlight.get(account.id);
	if (!promise) {
		throw new ServiceUnavailableError(
			`${ERROR_MESSAGES.REFRESH_NOT_FOUND} ${account.id}`,
		);
	}
	return promise;
}

/**
 * Gets a valid access token for an account, refreshing if necessary
 * @param account - The account to get token for
 * @param ctx - The proxy context
 * @returns Promise resolving to a valid access token
 */
export async function getValidAccessToken(
	account: Account,
	ctx: ProxyContext,
): Promise<string> {
	// For OpenAI-compatible providers, the refresh_token field contains the API key
	// Return it directly without any OAuth token refresh logic
	if (account.provider === "openai-compatible" || account.provider === "zai") {
		if (account.refresh_token) {
			return account.refresh_token;
		}
		if (account.api_key) {
			return account.api_key;
		}
		throw new Error(`No API key available for account ${account.name}`);
	}

	// API key accounts don't use access tokens
	if (!account.refresh_token && account.api_key) {
		// Return empty string - the API key will be used in prepareHeaders
		return "";
	}

	// Check if token exists and won't expire within the safety window
	if (
		account.access_token &&
		account.expires_at &&
		account.expires_at - Date.now() > TOKEN_SAFETY_WINDOW_MS
	) {
		return account.access_token;
	}

	// Token is expired, missing, or will expire soon
	const reason = !account.access_token
		? "missing"
		: !account.expires_at
			? "no expiry"
			: account.expires_at <= Date.now()
				? "expired"
				: "expiring soon";

	log.info(`Token ${reason} for account: ${account.name}`);
	return await refreshAccessTokenSafe(account, ctx);
}
