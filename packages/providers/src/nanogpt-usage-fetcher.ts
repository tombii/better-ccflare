import { Logger } from "@better-ccflare/logger";

const log = new Logger("NanoGPTUsageFetcher");

export interface NanoGPTUsageWindow {
	used: number;
	remaining: number;
	percentUsed: number; // 0-1 decimal range from API
	resetAt: number; // Unix timestamp in milliseconds
}

export interface NanoGPTUsageData {
	active: boolean; // true = subscription active, false = PayG mode
	limits: {
		daily: number;
		monthly: number;
	};
	enforceDailyLimit: boolean; // If true, both daily AND monthly required; if false, only monthly
	daily: NanoGPTUsageWindow;
	monthly: NanoGPTUsageWindow;
	state: "active" | "grace" | "inactive";
	graceUntil: string | null; // ISO timestamp
	period?: {
		currentPeriodEnd?: string; // ISO timestamp
	};
}

/**
 * Fetch usage data from NanoGPT's subscription usage endpoint
 * This is non-blocking - failures return null and won't affect provider operation
 */
export async function fetchNanoGPTUsageData(
	apiKey: string,
	customEndpoint?: string | null,
): Promise<NanoGPTUsageData | null> {
	try {
		const baseUrl = customEndpoint || "https://nano-gpt.com/api";
		const url = new URL("/subscription/v1/usage", baseUrl).toString();

		const response = await fetch(url, {
			method: "GET",
			headers: {
				"x-api-key": apiKey,
				Accept: "application/json",
			},
		});

		if (!response.ok) {
			const errorMessage = response.statusText;
			const responseHeaders = Object.fromEntries(response.headers.entries());
			try {
				const errorBody = await response.text();
				log.warn(
					`Failed to fetch NanoGPT usage data: ${response.status} ${errorMessage}`,
					{
						status: response.status,
						statusText: errorMessage,
						url,
						headers: responseHeaders,
						errorBody: errorBody,
						timestamp: new Date().toISOString(),
					},
				);
			} catch {
				log.warn(
					`Failed to fetch NanoGPT usage data: ${response.status} ${errorMessage}`,
					{
						status: response.status,
						statusText: errorMessage,
						url,
						headers: responseHeaders,
						timestamp: new Date().toISOString(),
					},
				);
			}
			return null;
		}

		const data = (await response.json()) as NanoGPTUsageData;

		// Log if account is in PayG mode
		if (!data.active) {
			log.debug("NanoGPT account is in PayG mode (no active subscription)");
		}

		return data;
	} catch (error) {
		log.warn("Error fetching NanoGPT usage data:", error);
		return null;
	}
}

/**
 * Get the representative utilization percentage (0-100)
 * Returns the highest utilization across daily and monthly windows
 * Can exceed 100% if daily limit is overridden by user
 */
export function getRepresentativeNanoGPTUtilization(
	usage: NanoGPTUsageData | null,
): number | null {
	if (!usage || !usage.active) return null;

	const dailyPercent = usage.daily.percentUsed * 100; // Convert 0-1 to 0-100
	const monthlyPercent = usage.monthly.percentUsed * 100;

	return Math.max(dailyPercent, monthlyPercent);
}

/**
 * Determine which window is the most restrictive (highest utilization)
 * Returns "daily" or "monthly"
 */
export function getRepresentativeNanoGPTWindow(
	usage: NanoGPTUsageData | null,
): string | null {
	if (!usage || !usage.active) return null;

	const dailyPercent = usage.daily.percentUsed;
	const monthlyPercent = usage.monthly.percentUsed;

	return dailyPercent > monthlyPercent ? "daily" : "monthly";
}
