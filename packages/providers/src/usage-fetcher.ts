import { Logger } from "@better-ccflare/logger";
import { supportsUsageTracking } from "@better-ccflare/types";

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
		usage.seven_day_opus?.utilization ?? 0,
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
		{
			name: "seven_day_opus",
			util: usage.seven_day_opus?.utilization ?? 0,
		},
	];

	const max = windows.reduce((prev, current) =>
		current.util > prev.util ? current : prev,
	);

	return max.name;
}

/**
 * Type for a function that retrieves a fresh access token
 */
export type AccessTokenProvider = () => Promise<string>;

/**
 * In-memory cache for usage data per account
 */
class UsageCache {
	private cache = new Map<string, { data: UsageData; timestamp: number }>();
	private polling = new Map<string, NodeJS.Timeout>();
	private tokenProviders = new Map<string, AccessTokenProvider>();

	/**
	 * Start polling for an account's usage data
	 */
	startPolling(
		accountId: string,
		accessTokenOrProvider: string | AccessTokenProvider,
		provider?: string,
		intervalMs?: number,
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

		// Immediate fetch
		this.fetchAndCache(accountId, tokenProvider);

		// Default to 90 seconds ± 5 seconds with randomization if not provided
		const pollingInterval = intervalMs ?? 90000 + Math.random() * 10000;

		// Start interval
		const interval = setInterval(() => {
			this.fetchAndCache(accountId, tokenProvider);
		}, pollingInterval);

		this.polling.set(accountId, interval);
		log.debug(
			`Started usage polling for account ${accountId} with interval ${Math.round(pollingInterval / 1000)}s`,
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
	) {
		try {
			// Get a fresh access token on each fetch
			const accessToken = await tokenProvider();
			const data = await fetchUsageData(accessToken);
			if (data) {
				this.cache.set(accountId, { data, timestamp: Date.now() });
				const utilization = getRepresentativeUtilization(data);
				const window = getRepresentativeWindow(data);
				log.debug(
					`Successfully fetched usage data for account ${accountId}: ${utilization}% (${window} window)`,
				);
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
	get(accountId: string): UsageData | null {
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
