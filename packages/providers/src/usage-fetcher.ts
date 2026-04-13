import { CLAUDE_CLI_VERSION } from "@better-ccflare/core";
import { Logger } from "@better-ccflare/logger";
import { supportsUsageTracking } from "@better-ccflare/types";
import {
	type AlibabaCodingPlanUsageData,
	fetchAlibabaCodingPlanUsageData,
	getRepresentativeAlibabaCodingPlanUtilization,
	getRepresentativeAlibabaCodingPlanWindow,
} from "./alibaba-coding-plan-usage-fetcher";
import {
	fetchKiloUsageData,
	getRepresentativeKiloUtilization,
	getRepresentativeKiloWindow,
	type KiloUsageData,
} from "./kilo-usage-fetcher";
import {
	fetchNanoGPTUsageData,
	type NanoGPTUsageData,
} from "./nanogpt-usage-fetcher";
import { fetchZaiUsageData, type ZaiUsageData } from "./zai-usage-fetcher";

const log = new Logger("UsageFetcher");

export interface UsageWindow {
	utilization: number;
	resets_at: string | null;
}

export interface ExtraUsage {
	is_enabled: boolean;
	monthly_limit: number | null;
	used_credits: number | null;
	utilization: number | null;
}

export interface UsageData {
	// Core windows (always present in older API versions)
	five_hour: UsageWindow;
	seven_day: UsageWindow;
	seven_day_oauth_apps?: UsageWindow;
	seven_day_opus?: UsageWindow | null;
	// New fields from 2025-11 API update (all optional for backward compatibility)
	seven_day_sonnet?: UsageWindow | null;
	iguana_necktie?: unknown; // Unknown purpose, keep as flexible type
	extra_usage?: ExtraUsage;
	// Allow any additional fields Anthropic might add in the future
	[key: string]: UsageWindow | ExtraUsage | unknown;
}

// Union type for all provider usage data
export type AnyUsageData =
	| UsageData
	| NanoGPTUsageData
	| ZaiUsageData
	| KiloUsageData
	| AlibabaCodingPlanUsageData;

/**
 * Extract the primary window reset timestamp (ms) from usage data.
 * Returns null if the provider doesn't expose a reset time or it isn't available.
 */
export function extractWindowResetTime(
	data: AnyUsageData,
	provider: string,
): number | null {
	if (provider === "zai") {
		const zai = data as ZaiUsageData;
		return zai.tokens_limit?.resetAt ?? null;
	}
	if (provider === "anthropic") {
		const anthropic = data as UsageData;
		const resetsAt = anthropic.five_hour?.resets_at;
		if (!resetsAt) return null;
		const ms = new Date(resetsAt).getTime();
		return Number.isFinite(ms) ? ms : null;
	}
	return null;
}

/**
 * Fetch usage data from Anthropic's OAuth usage endpoint
 */
export interface UsageFetchResult {
	data: UsageData | null;
	retryAfterMs: number | null; // Set when server returns retry-after on 429
}

export async function fetchUsageData(
	accessToken: string,
): Promise<UsageFetchResult> {
	try {
		const response = await fetch("https://api.anthropic.com/api/oauth/usage", {
			method: "GET",
			headers: {
				Authorization: `Bearer ${accessToken}`,
				"anthropic-beta": "oauth-2025-04-20",
				"User-Agent": `claude-code/${CLAUDE_CLI_VERSION}`,
				Accept: "application/json",
			},
		});

		if (!response.ok) {
			const errorMessage = response.statusText;
			const responseHeaders = Object.fromEntries(response.headers.entries());

			// Extract retry-after on 429 so callers can schedule smarter backoff
			let retryAfterMs: number | null = null;
			if (response.status === 429) {
				const retryAfter = response.headers.get("retry-after");
				if (retryAfter) {
					const seconds = parseInt(retryAfter, 10);
					if (!Number.isNaN(seconds) && seconds > 0) {
						retryAfterMs = seconds * 1000;
						log.warn(`Usage endpoint rate-limited, retry-after: ${seconds}s`);
					}
				}
			}

			try {
				const errorBody = await response.text();
				log.error(
					`Failed to fetch usage data: ${response.status} ${errorMessage}`,
					{
						status: response.status,
						statusText: errorMessage,
						url: "https://api.anthropic.com/api/oauth/usage",
						headers: responseHeaders,
						errorBody: errorBody,
						timestamp: new Date().toISOString(),
					},
				);
			} catch {
				log.error(
					`Failed to fetch usage data: ${response.status} ${errorMessage}`,
					{
						status: response.status,
						statusText: errorMessage,
						url: "https://api.anthropic.com/api/oauth/usage",
						headers: responseHeaders,
						timestamp: new Date().toISOString(),
					},
				);
			}
			return { data: null, retryAfterMs };
		}

		const data = (await response.json()) as UsageData;
		return { data, retryAfterMs: null };
	} catch (error) {
		// Ensure we have a proper error object for logging
		const errorMessage =
			error instanceof Error
				? error.message
				: typeof error === "object" && error !== null
					? JSON.stringify(error)
					: String(error);

		log.error("Error fetching usage data:", errorMessage || "Unknown error");
		return { data: null, retryAfterMs: null };
	}
}

/**
 * Get the representative utilization percentage
 * Returns the highest utilization across all windows
 * Dynamically handles any usage window fields in the response
 */
export function getRepresentativeUtilization(
	usage: UsageData | null,
): number | null {
	if (!usage) return null;

	const utilizations: number[] = [];

	// Iterate through all properties to find UsageWindow objects
	for (const [key, value] of Object.entries(usage)) {
		// Check if this is a UsageWindow object
		if (
			value &&
			typeof value === "object" &&
			"utilization" in value &&
			typeof value.utilization === "number"
		) {
			utilizations.push(value.utilization);
		}
		// Also check extra_usage if present
		if (
			key === "extra_usage" &&
			value &&
			typeof value === "object" &&
			"utilization" in value &&
			typeof value.utilization === "number"
		) {
			utilizations.push(value.utilization);
		}
	}

	return utilizations.length > 0 ? Math.max(...utilizations) : 0;
}

/**
 * Determine which window is the most restrictive (highest utilization)
 * Dynamically handles any usage window fields in the response
 */
export function getRepresentativeWindow(
	usage: UsageData | null,
): string | null {
	if (!usage) return null;

	const windows: Array<{ name: string; util: number }> = [];

	// Iterate through all properties to find UsageWindow objects
	for (const [key, value] of Object.entries(usage)) {
		// Check if this is a UsageWindow object
		if (
			value &&
			typeof value === "object" &&
			"utilization" in value &&
			typeof value.utilization === "number"
		) {
			windows.push({ name: key, util: value.utilization });
		}
		// Also check extra_usage if present
		if (
			key === "extra_usage" &&
			value &&
			typeof value === "object" &&
			"utilization" in value &&
			typeof value.utilization === "number"
		) {
			windows.push({ name: key, util: value.utilization });
		}
	}

	if (windows.length === 0) return null;

	const max = windows.reduce((prev, current) =>
		current.util > prev.util ? current : prev,
	);

	return max.name;
}

/**
 * Type for a function that retrieves a fresh access token or API key
 */
export type AccessTokenProvider = () => Promise<string>;

/**
 * In-memory cache for usage data per account
 */
class UsageCache {
	private cache = new Map<string, { data: AnyUsageData; timestamp: number }>();
	private pollTimeouts = new Map<string, NodeJS.Timeout>();
	private failureCounts = new Map<string, number>();
	private tokenProviders = new Map<string, AccessTokenProvider>();
	private providerTypes = new Map<string, string>(); // Track provider type for each account
	private customEndpoints = new Map<string, string | null>(); // Track custom endpoints
	private windowResetCallbacks = new Map<string, (accountId: string) => void>();

	/**
	 * Schedule the next poll with exponential backoff on failures.
	 * If retryAfterMs is provided (from a 429 retry-after header), it takes
	 * precedence over the calculated backoff delay.
	 */
	private scheduleNextPoll(
		accountId: string,
		tokenProvider: AccessTokenProvider,
		baseIntervalMs: number,
		provider?: string,
		customEndpoint?: string | null,
		retryAfterMs?: number | null,
	) {
		const failures = this.failureCounts.get(accountId) ?? 0;
		// Use server-provided retry-after if available, otherwise exponential backoff capped at 30 minutes
		const delay =
			retryAfterMs != null
				? retryAfterMs
				: failures === 0
					? baseIntervalMs
					: Math.min(baseIntervalMs * 2 ** failures, 30 * 60 * 1000);

		if (failures > 0) {
			log.info(
				`Usage poll backoff for account ${accountId}: retry in ${Math.round(delay / 1000)}s (${failures} consecutive failure(s))${retryAfterMs != null ? " [server retry-after]" : ""}`,
			);
		}

		const timeoutId = setTimeout(async () => {
			this.pollTimeouts.delete(accountId);
			// Bail if polling was stopped
			if (!this.tokenProviders.has(accountId)) return;

			const { success, retryAfterMs: nextRetryAfterMs } =
				await this.fetchAndCache(
					accountId,
					tokenProvider,
					provider,
					customEndpoint,
				);
			if (success) {
				this.failureCounts.delete(accountId); // reset streak on success
			} else {
				const count = (this.failureCounts.get(accountId) ?? 0) + 1;
				this.failureCounts.set(accountId, count);
			}
			// Schedule the next poll if still active
			if (this.tokenProviders.has(accountId)) {
				this.scheduleNextPoll(
					accountId,
					tokenProvider,
					baseIntervalMs,
					provider,
					customEndpoint,
					nextRetryAfterMs,
				);
			}
		}, delay);

		this.pollTimeouts.set(accountId, timeoutId);
	}

	/**
	 * Start polling for an account's usage data
	 */
	startPolling(
		accountId: string,
		accessTokenOrProvider: string | AccessTokenProvider,
		provider?: string,
		intervalMs?: number,
		customEndpoint?: string | null,
		onWindowReset?: (accountId: string) => void,
	) {
		// Check if provider supports usage tracking
		if (provider && !supportsUsageTracking(provider)) {
			log.info(
				`Skipping usage polling for account ${accountId} - provider ${provider} does not support usage tracking`,
			);
			return;
		}

		// Stop existing polling if any to prevent leaks
		const existing = this.pollTimeouts.get(accountId);
		if (existing) {
			clearTimeout(existing);
			log.warn(
				`Clearing existing polling timeout for account ${accountId} before starting new one`,
			);
		}

		// Reset failure count for fresh start
		this.failureCounts.delete(accountId);

		// Store the token provider (either a static token or a function)
		const tokenProvider: AccessTokenProvider =
			typeof accessTokenOrProvider === "string"
				? async () => accessTokenOrProvider
				: accessTokenOrProvider;
		this.tokenProviders.set(accountId, tokenProvider);

		// Store provider type, custom endpoint, and window-reset callback for this account
		if (provider) {
			this.providerTypes.set(accountId, provider);
		}
		if (customEndpoint !== undefined) {
			this.customEndpoints.set(accountId, customEndpoint);
		}
		if (onWindowReset) {
			this.windowResetCallbacks.set(accountId, onWindowReset);
		} else {
			this.windowResetCallbacks.delete(accountId);
		}

		// Default to 90s if not provided
		const baseIntervalMs = intervalMs ?? 90000;

		// Immediate fetch
		this.fetchAndCache(accountId, tokenProvider, provider, customEndpoint).then(
			({ success, retryAfterMs }) => {
				if (!success) {
					this.failureCounts.set(accountId, 1);
				}
				if (this.tokenProviders.has(accountId)) {
					this.scheduleNextPoll(
						accountId,
						tokenProvider,
						baseIntervalMs,
						provider,
						customEndpoint,
						retryAfterMs,
					);
				}
			},
		);

		log.debug(
			`Started usage polling for account ${accountId} (provider: ${provider}) with base interval ${Math.round(baseIntervalMs / 1000)}s`,
		);
	}

	/**
	 * Trigger an immediate usage fetch for an account that already has polling configured.
	 * Returns false when no polling/token provider is configured or when the fetch fails.
	 */
	async refreshNow(accountId: string): Promise<boolean> {
		const tokenProvider = this.tokenProviders.get(accountId);
		if (!tokenProvider) {
			return false;
		}

		const provider = this.providerTypes.get(accountId);
		const customEndpoint = this.customEndpoints.get(accountId);
		const { success } = await this.fetchAndCache(
			accountId,
			tokenProvider,
			provider,
			customEndpoint,
		);
		return success;
	}

	/**
	 * Stop polling for an account
	 */
	stopPolling(accountId: string) {
		const timeout = this.pollTimeouts.get(accountId);
		if (timeout) {
			clearTimeout(timeout);
			this.pollTimeouts.delete(accountId);
		}
		if (this.tokenProviders.has(accountId)) {
			this.tokenProviders.delete(accountId);
			this.failureCounts.delete(accountId);
			this.windowResetCallbacks.delete(accountId);
			// Clean up cache entry when polling stops to prevent memory leaks
			this.cache.delete(accountId);
			log.info(
				`Stopped usage polling and cleared cache for account ${accountId}`,
			);
		}
	}

	/**
	 * Fetch and cache usage data.
	 * Returns { success, retryAfterMs } where retryAfterMs is set when the
	 * server returns a retry-after header on a 429 response.
	 */
	private async fetchAndCache(
		accountId: string,
		tokenProvider: AccessTokenProvider,
		provider?: string,
		customEndpoint?: string | null,
	): Promise<{ success: boolean; retryAfterMs: number | null }> {
		try {
			// Get a fresh access token or API key on each fetch
			let token: string;
			try {
				token = await tokenProvider();
			} catch (tokenError) {
				// Handle token provider errors that might result in empty objects
				const tokenErrorMessage =
					tokenError instanceof Error
						? tokenError.message
						: typeof tokenError === "object" && tokenError !== null
							? JSON.stringify(tokenError)
							: String(tokenError);

				log.warn(
					`Token provider failed for account ${accountId}: ${tokenErrorMessage || "Unknown error"}`,
				);
				return { success: false, retryAfterMs: null };
			}

			// Validate token before proceeding
			if (!token || (typeof token === "string" && token.trim() === "")) {
				log.warn(
					`No valid token available for account ${accountId}, skipping usage fetch`,
				);
				return { success: false, retryAfterMs: null };
			}

			// Fetch data based on provider type
			let data: AnyUsageData | null = null;

			if (provider === "nanogpt") {
				// Fetch NanoGPT usage data
				data = await fetchNanoGPTUsageData(token, customEndpoint);
				if (data) {
					// Import NanoGPT helper functions
					const {
						getRepresentativeNanoGPTUtilization,
						getRepresentativeNanoGPTWindow,
					} = await import("./nanogpt-usage-fetcher");

					this.cache.set(accountId, { data, timestamp: Date.now() });
					const utilization = getRepresentativeNanoGPTUtilization(
						data as NanoGPTUsageData,
					);
					const window = getRepresentativeNanoGPTWindow(
						data as NanoGPTUsageData,
					);
					log.debug(
						`Successfully fetched NanoGPT usage data for account ${accountId}: ${utilization}% (${window} window)`,
					);
					return { success: true, retryAfterMs: null };
				}
			} else if (provider === "zai") {
				// Fetch Zai usage data
				data = await fetchZaiUsageData(token);
				if (data) {
					// Import Zai helper functions
					const {
						getRepresentativeZaiUtilization,
						getRepresentativeZaiWindow,
					} = await import("./zai-usage-fetcher");

					const callback = this.windowResetCallbacks.get(accountId);
					if (callback) this.notifyWindowReset(accountId, data, "zai", callback);
					this.cache.set(accountId, { data, timestamp: Date.now() });
					const utilization = getRepresentativeZaiUtilization(
						data as ZaiUsageData,
					);
					const window = getRepresentativeZaiWindow(data as ZaiUsageData);
					log.debug(
						`Successfully fetched Zai usage data for account ${accountId}: ${utilization}% (${window} window)`,
					);
					return { success: true, retryAfterMs: null };
				}
			} else if (provider === "kilo") {
				// Fetch Kilo usage data
				data = await fetchKiloUsageData(token);
				if (data) {
					this.cache.set(accountId, { data, timestamp: Date.now() });
					const utilization = getRepresentativeKiloUtilization(
						data as KiloUsageData,
					);
					const window = getRepresentativeKiloWindow(data as KiloUsageData);
					log.debug(
						`Successfully fetched Kilo usage data for account ${accountId}: $${(data as KiloUsageData).remainingUsd.toFixed(2)} remaining (${utilization?.toFixed(1)}% used, ${window})`,
					);
					return { success: true, retryAfterMs: null };
				}
			} else if (provider === "alibaba-coding-plan") {
				// Fetch Alibaba Coding Plan usage data
				data = await fetchAlibabaCodingPlanUsageData(token);
				if (data) {
					this.cache.set(accountId, { data, timestamp: Date.now() });
					const utilization = getRepresentativeAlibabaCodingPlanUtilization(
						data as AlibabaCodingPlanUsageData,
					);
					const window = getRepresentativeAlibabaCodingPlanWindow(
						data as AlibabaCodingPlanUsageData,
					);
					log.debug(
						`Successfully fetched Alibaba Coding Plan usage data for account ${accountId}: ${utilization?.toFixed(1)}% used (${window} window)`,
					);
					return { success: true, retryAfterMs: null };
				}
			} else {
				// Default to Anthropic usage data
				const result = await fetchUsageData(token);
				if (result.data) {
					const callback = this.windowResetCallbacks.get(accountId);
					if (callback) this.notifyWindowReset(accountId, result.data, "anthropic", callback);
					this.cache.set(accountId, {
						data: result.data,
						timestamp: Date.now(),
					});
					const utilization = getRepresentativeUtilization(
						result.data as UsageData,
					);
					const window = getRepresentativeWindow(result.data as UsageData);
					log.debug(
						`Successfully fetched usage data for account ${accountId}: ${utilization}% (${window} window)`,
					);
					return { success: true, retryAfterMs: null };
				}
				return { success: false, retryAfterMs: result.retryAfterMs };
			}

			return { success: false, retryAfterMs: null };
		} catch (error) {
			// Ensure we have a proper error object for logging
			const errorMessage =
				error instanceof Error
					? error.message
					: typeof error === "object" && error !== null
						? JSON.stringify(error)
						: String(error);

			log.error(
				`Error fetching usage data for account ${accountId}:`,
				errorMessage || "Unknown error",
			);
			return { success: false, retryAfterMs: null };
		}
	}

	/**
	 * Clean up stale cache entries older than maxAgeMs
	 */
	cleanupStaleEntries(maxAgeMs: number = 10 * 60 * 1000): void {
		const now = Date.now();
		let cleanedCount = 0;

		for (const [accountId, cached] of this.cache.entries()) {
			if (now - cached.timestamp > maxAgeMs) {
				this.cache.delete(accountId);
				cleanedCount++;
			}
		}

		if (cleanedCount > 0) {
			log.debug(`Cleaned up ${cleanedCount} stale usage cache entries`);
		}
	}

	/**
	 * Get cached usage data for an account
	 */
	get(accountId: string): AnyUsageData | null {
		const cached = this.cache.get(accountId);
		if (!cached) return null;

		// Clean up stale entries while accessing
		const age = Date.now() - cached.timestamp;
		if (age > 10 * 60 * 1000) {
			// 10 minutes max age
			this.cache.delete(accountId);
			log.debug(
				`Removed stale cache entry for account ${accountId} (age: ${Math.round(age / 1000)}s)`,
			);
			return null;
		}

		return cached.data;
	}

	/**
	 * Set cached usage data for an account
	 */
	set(accountId: string, data: AnyUsageData): void {
		this.cache.set(accountId, { data, timestamp: Date.now() });

		// Periodic cleanup of stale entries to prevent memory bloat
		// Run cleanup every 100 sets to balance performance and memory
		if (this.cache.size % 100 === 0) {
			this.cleanupStaleEntries();
		}
	}

	/**
	 * Check if the usage window has reset by comparing the new data's reset time
	 * against the previously cached data, and fire the callback if it has advanced.
	 * Should be called after successfully fetching new data, before updating the cache.
	 * No-ops on the first poll (no previous data) to avoid spurious resets.
	 */
	notifyWindowReset(
		accountId: string,
		newData: AnyUsageData,
		provider: string,
		callback: (accountId: string) => void,
	): void {
		const previous = this.cache.get(accountId);
		if (!previous) return; // first poll — no baseline to compare against

		const prevResetAt = extractWindowResetTime(previous.data, provider);
		const newResetAt = extractWindowResetTime(newData, provider);

		if (
			prevResetAt !== null &&
			newResetAt !== null &&
			newResetAt > prevResetAt
		) {
			log.info(
				`Usage window reset detected for account ${accountId} (${provider}): ` +
					`${new Date(prevResetAt).toISOString()} → ${new Date(newResetAt).toISOString()}`,
			);
			callback(accountId);
		}
	}

	/**
	 * Get cached data age in milliseconds
	 */
	getAge(accountId: string): number | null {
		const cached = this.cache.get(accountId);
		if (!cached) return null;

		const age = Date.now() - cached.timestamp;
		// Clean up if too old
		if (age > 10 * 60 * 1000) {
			// 10 minutes max age
			this.cache.delete(accountId);
			return null;
		}

		return age;
	}

	/**
	 * Clear cached data for a specific account
	 */
	delete(accountId: string): void {
		this.cache.delete(accountId);
		log.debug(`Cleared usage cache for account ${accountId}`);
	}

	/**
	 * Clear all cached data and stop all polling
	 */
	clear() {
		for (const accountId of this.tokenProviders.keys()) {
			this.stopPolling(accountId);
		}
		this.cache.clear();
		log.info("Cleared all usage cache and stopped polling");
	}
}

// Export singleton instance
export const usageCache = new UsageCache();
