import { Logger } from "@better-ccflare/logger";

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
			log.error(
				`Failed to fetch usage data: ${response.status} ${response.statusText}`,
			);
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
		usage.seven_day_oauth_apps.utilization,
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
			util: usage.seven_day_oauth_apps.utilization,
		},
		{ name: "seven_day_opus", util: usage.seven_day_opus.utilization },
	];

	const max = windows.reduce((prev, current) =>
		current.util > prev.util ? current : prev,
	);

	return max.name;
}

/**
 * In-memory cache for usage data per account
 */
class UsageCache {
	private cache = new Map<string, { data: UsageData; timestamp: number }>();
	private polling = new Map<string, NodeJS.Timeout>();

	/**
	 * Start polling for an account's usage data
	 */
	startPolling(accountId: string, accessToken: string, intervalMs?: number) {
		// Stop existing polling if any
		this.stopPolling(accountId);

		// Immediate fetch
		this.fetchAndCache(accountId, accessToken);

		// Default to 90 seconds ± 5 seconds with randomization if not provided
		const pollingInterval = intervalMs ?? 90000 + Math.random() * 10000;

		// Start interval
		const interval = setInterval(() => {
			this.fetchAndCache(accountId, accessToken);
		}, pollingInterval);

		this.polling.set(accountId, interval);
		log.info(
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
			log.info(`Stopped usage polling for account ${accountId}`);
		}
	}

	/**
	 * Fetch and cache usage data
	 */
	private async fetchAndCache(accountId: string, accessToken: string) {
		const data = await fetchUsageData(accessToken);
		if (data) {
			this.cache.set(accountId, { data, timestamp: Date.now() });
			log.debug(
				`Updated usage data for account ${accountId}: ${getRepresentativeUtilization(data)}%`,
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
