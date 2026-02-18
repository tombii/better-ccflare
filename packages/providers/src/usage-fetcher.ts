import { Logger } from "@better-ccflare/logger";
import { supportsUsageTracking } from "@better-ccflare/types";
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
export type AnyUsageData = UsageData | NanoGPTUsageData | ZaiUsageData;

/**
 * Fetch usage data from Anthropic's OAuth usage endpoint
 */
export async function fetchUsageData(
	accessToken: string,
): Promise<UsageData | null> {
	try {
		const response = await fetch("https://api.anthropic.com/api/oauth/usage", {
			method: "GET",
			headers: {
				Authorization: `Bearer ${accessToken}`,
				"anthropic-beta": "oauth-2025-04-20",
				Accept: "application/json",
			},
		});

		if (!response.ok) {
			const errorMessage = response.statusText;
			const responseHeaders = Object.fromEntries(response.headers.entries());
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
			return null;
		}

		const data = (await response.json()) as UsageData;
		return data;
	} catch (error) {
		// Ensure we have a proper error object for logging
		const errorMessage =
			error instanceof Error
				? error.message
				: typeof error === "object" && error !== null
					? JSON.stringify(error)
					: String(error);

		log.error("Error fetching usage data:", errorMessage || "Unknown error");
		return null;
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
	private polling = new Map<string, NodeJS.Timeout>();
	private tokenProviders = new Map<string, AccessTokenProvider>();
	private providerTypes = new Map<string, string>(); // Track provider type for each account
	private customEndpoints = new Map<string, string | null>(); // Track custom endpoints

	/**
	 * Start polling for an account's usage data
	 */
	startPolling(
		accountId: string,
		accessTokenOrProvider: string | AccessTokenProvider,
		provider?: string,
		intervalMs?: number,
		customEndpoint?: string | null,
	) {
		// Check if provider supports usage tracking
		if (provider && !supportsUsageTracking(provider)) {
			log.info(
				`Skipping usage polling for account ${accountId} - provider ${provider} does not support usage tracking`,
			);
			return;
		}

		// Stop existing polling if any to prevent leaks
		const existing = this.polling.get(accountId);
		if (existing) {
			clearInterval(existing);
			log.warn(
				`Clearing existing polling interval for account ${accountId} before starting new one`,
			);
		}

		// Store the token provider (either a static token or a function)
		const tokenProvider: AccessTokenProvider =
			typeof accessTokenOrProvider === "string"
				? async () => accessTokenOrProvider
				: accessTokenOrProvider;
		this.tokenProviders.set(accountId, tokenProvider);

		// Store provider type and custom endpoint for this account
		if (provider) {
			this.providerTypes.set(accountId, provider);
		}
		if (customEndpoint !== undefined) {
			this.customEndpoints.set(accountId, customEndpoint);
		}

		// Immediate fetch
		this.fetchAndCache(accountId, tokenProvider, provider, customEndpoint);

		// Default to 90 seconds ± 5 seconds with randomization if not provided
		const pollingInterval = intervalMs ?? 90000 + Math.random() * 10000;

		// Start interval
		const interval = setInterval(() => {
			this.fetchAndCache(accountId, tokenProvider, provider, customEndpoint);
		}, pollingInterval);

		this.polling.set(accountId, interval);
		log.debug(
			`Started usage polling for account ${accountId} (provider: ${provider}) with interval ${Math.round(pollingInterval / 1000)}s`,
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
		return await this.fetchAndCache(
			accountId,
			tokenProvider,
			provider,
			customEndpoint,
		);
	}

	/**
	 * Stop polling for an account
	 */
	stopPolling(accountId: string) {
		const interval = this.polling.get(accountId);
		if (interval) {
			clearInterval(interval);
			this.polling.delete(accountId);
			this.tokenProviders.delete(accountId);
			// Clean up cache entry when polling stops to prevent memory leaks
			this.cache.delete(accountId);
			log.info(
				`Stopped usage polling and cleared cache for account ${accountId}`,
			);
		}
	}

	/**
	 * Fetch and cache usage data.
	 * Returns true if data was successfully fetched and cached, false otherwise.
	 */
	private async fetchAndCache(
		accountId: string,
		tokenProvider: AccessTokenProvider,
		provider?: string,
		customEndpoint?: string | null,
	): Promise<boolean> {
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
				return false;
			}

			// Validate token before proceeding
			if (!token || (typeof token === "string" && token.trim() === "")) {
				log.warn(
					`No valid token available for account ${accountId}, skipping usage fetch`,
				);
				return false;
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
					return true;
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

					this.cache.set(accountId, { data, timestamp: Date.now() });
					const utilization = getRepresentativeZaiUtilization(
						data as ZaiUsageData,
					);
					const window = getRepresentativeZaiWindow(data as ZaiUsageData);
					log.debug(
						`Successfully fetched Zai usage data for account ${accountId}: ${utilization}% (${window} window)`,
					);
					return true;
				}
			} else {
				// Default to Anthropic usage data
				data = await fetchUsageData(token);
				if (data) {
					this.cache.set(accountId, { data, timestamp: Date.now() });
					const utilization = getRepresentativeUtilization(data as UsageData);
					const window = getRepresentativeWindow(data as UsageData);
					log.debug(
						`Successfully fetched usage data for account ${accountId}: ${utilization}% (${window} window)`,
					);
					return true;
				}
			}

			return false;
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
			return false;
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
		for (const accountId of this.polling.keys()) {
			this.stopPolling(accountId);
		}
		this.cache.clear();
		log.info("Cleared all usage cache and stopped polling");
	}
}

// Export singleton instance
export const usageCache = new UsageCache();
