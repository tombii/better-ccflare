import { Logger } from "@better-ccflare/logger";
import { supportsUsageTracking } from "@better-ccflare/types";
import {
	fetchNanoGPTUsageData,
	type NanoGPTUsageData,
} from "./nanogpt-usage-fetcher";

const log = new Logger("UsageFetcher");

export interface UsageWindow {
	utilization: number;
	resets_at: string | null;
}

export interface UsageData {
	five_hour: UsageWindow;
	seven_day: UsageWindow;
	seven_day_oauth_apps: UsageWindow;
	seven_day_opus: UsageWindow;
}

// Union type for all provider usage data
export type AnyUsageData = UsageData | NanoGPTUsageData;

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
		log.error("Error fetching usage data:", error);
		return null;
	}
}

/**
 * Get the representative utilization percentage
 * Returns the highest utilization across all windows
 */
export function getRepresentativeUtilization(
	usage: UsageData | null,
): number | null {
	if (!usage) return null;

	const utilizations = [
		usage.five_hour.utilization,
		usage.seven_day.utilization,
		usage.seven_day_oauth_apps?.utilization ?? 0,
		usage.seven_day_opus.utilization,
	];

	return Math.max(...utilizations);
}

/**
 * Determine which window is the most restrictive (highest utilization)
 */
export function getRepresentativeWindow(
	usage: UsageData | null,
): string | null {
	if (!usage) return null;

	const windows = [
		{ name: "five_hour", util: usage.five_hour.utilization },
		{ name: "seven_day", util: usage.seven_day.utilization },
		{
			name: "seven_day_oauth_apps",
			util: usage.seven_day_oauth_apps?.utilization ?? 0,
		},
		{ name: "seven_day_opus", util: usage.seven_day_opus.utilization },
	];

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
	 * Stop polling for an account
	 */
	stopPolling(accountId: string) {
		const interval = this.polling.get(accountId);
		if (interval) {
			clearInterval(interval);
			this.polling.delete(accountId);
			this.tokenProviders.delete(accountId);
			log.info(`Stopped usage polling for account ${accountId}`);
		}
	}

	/**
	 * Fetch and cache usage data
	 */
	private async fetchAndCache(
		accountId: string,
		tokenProvider: AccessTokenProvider,
		provider?: string,
		customEndpoint?: string | null,
	) {
		try {
			// Get a fresh access token or API key on each fetch
			const token = await tokenProvider();

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
				}
			}
		} catch (error) {
			log.error(
				`Error fetching usage data for account ${accountId}:`,
				error instanceof Error ? error.message : String(error),
			);
		}
	}

	/**
	 * Get cached usage data for an account
	 */
	get(accountId: string): AnyUsageData | null {
		const cached = this.cache.get(accountId);
		return cached?.data ?? null;
	}

	/**
	 * Get cached data age in milliseconds
	 */
	getAge(accountId: string): number | null {
		const cached = this.cache.get(accountId);
		if (!cached) return null;
		return Date.now() - cached.timestamp;
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
