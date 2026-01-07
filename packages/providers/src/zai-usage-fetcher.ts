import { Logger } from "@better-ccflare/logger";

const log = new Logger("ZaiUsageFetcher");

export interface ZaiUsageWindow {
	used: number;
	remaining: number;
	percentage: number; // 0-100 from API
	resetAt: number | null; // Unix timestamp in milliseconds
	type: string;
}

export interface ZaiUsageData {
	time_limit: ZaiUsageWindow | null;
	tokens_limit: ZaiUsageWindow | null;
}

/**
 * Fetch usage data from Zai's monitoring usage endpoint
 * This is non-blocking - failures return null and won't affect provider operation
 */
export async function fetchZaiUsageData(
	apiKey: string,
): Promise<ZaiUsageData | null> {
	try {
		const response = await fetch(
			"https://api.z.ai/api/monitor/usage/quota/limit",
			{
				method: "GET",
				headers: {
					"x-api-key": apiKey,
					Accept: "application/json",
				},
			},
		);

		if (!response.ok) {
			const errorMessage = response.statusText;
			const responseHeaders = Object.fromEntries(response.headers.entries());
			try {
				const errorBody = await response.text();
				log.warn(
					`Failed to fetch Zai usage data: ${response.status} ${errorMessage}`,
					{
						status: response.status,
						statusText: errorMessage,
						url: "https://api.z.ai/api/monitor/usage/quota/limit",
						headers: responseHeaders,
						errorBody: errorBody,
						timestamp: new Date().toISOString(),
					},
				);
			} catch {
				log.warn(
					`Failed to fetch Zai usage data: ${response.status} ${errorMessage}`,
					{
						status: response.status,
						statusText: errorMessage,
						url: "https://api.z.ai/api/monitor/usage/quota/limit",
						headers: responseHeaders,
						timestamp: new Date().toISOString(),
					},
				);
			}
			return null;
		}

		const json = await response.json();

		// Validate response structure
		if (!json.success || !json.data || !Array.isArray(json.data.limits)) {
			log.warn("Invalid Zai usage response structure");
			return null;
		}

		const limits = json.data.limits;
		const result: ZaiUsageData = {
			time_limit: null,
			tokens_limit: null,
		};

		// Parse each limit type
		for (const limit of limits) {
			if (limit.type === "TIME_LIMIT") {
				result.time_limit = {
					used: limit.currentValue ?? 0,
					remaining: limit.remaining ?? 0,
					percentage: limit.percentage ?? 0,
					resetAt: limit.nextResetTime ?? null,
					type: "time_limit",
				};
			} else if (limit.type === "TOKENS_LIMIT") {
				result.tokens_limit = {
					used: limit.currentValue ?? 0,
					remaining: limit.remaining ?? 0,
					percentage: limit.percentage ?? 0,
					resetAt: limit.nextResetTime ?? null,
					type: "tokens_limit",
				};
			}
		}

		return result;
	} catch (error) {
		log.warn("Error fetching Zai usage data:", error);
		return null;
	}
}

/**
 * Get the representative utilization percentage (0-100)
 * Returns the tokens_limit utilization (5-hour token quota)
 */
export function getRepresentativeZaiUtilization(
	usage: ZaiUsageData | null,
): number | null {
	if (!usage) return null;

	// Only consider tokens_limit (5-hour token quota)
	// time_limit is not displayed to users
	if (
		usage.tokens_limit &&
		usage.tokens_limit.percentage !== undefined
	) {
		return usage.tokens_limit.percentage;
	}

	return null;
}

/**
 * Determine which limit is the most restrictive (highest utilization)
 * Returns "five_hour" (for tokens_limit) to match Claude terminology
 */
export function getRepresentativeZaiWindow(
	usage: ZaiUsageData | null,
): string | null {
	if (!usage) return null;

	const windows: Array<{ name: string; percentage: number }> = [];

	// Only consider tokens_limit (5-hour token quota)
	// time_limit is not displayed to users
	if (usage.tokens_limit && usage.tokens_limit.percentage !== undefined) {
		windows.push({
			name: "five_hour", // Map to "5-hour" to match Claude terminology
			percentage: usage.tokens_limit.percentage,
		});
	}

	if (windows.length === 0) return null;

	const max = windows.reduce((prev, current) =>
		current.percentage > prev.percentage ? current : prev,
	);

	return max.name;
}
