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
	/** Short token window (5-hour on current plans) — the nearest reset. */
	tokens_limit: ZaiUsageWindow | null;
	/** Long token window (weekly on current plans), null on single-window plans. */
	tokens_limit_weekly: ZaiUsageWindow | null;
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
			tokens_limit_weekly: null,
		};

		// Zai sends MULTIPLE TOKENS_LIMIT entries (a 5-hour and a weekly cap on
		// current plans), distinguished only by unit/number — an undocumented
		// encoding. Ordering by reset time is the durable signal: the nearest
		// reset is the short window, the next one the long window. Assigning
		// them in loop order would let the weekly entry overwrite the 5-hour
		// one, which is what made the dashboard label a weekly cap "5-hour".
		const tokenWindows: ZaiUsageWindow[] = [];

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
				tokenWindows.push({
					used: limit.currentValue ?? 0,
					remaining: limit.remaining ?? 0,
					percentage: limit.percentage ?? 0,
					resetAt: limit.nextResetTime ?? null,
					type: "tokens_limit",
				});
			}
		}

		tokenWindows.sort(
			(a, b) =>
				(a.resetAt ?? Number.POSITIVE_INFINITY) -
				(b.resetAt ?? Number.POSITIVE_INFINITY),
		);
		result.tokens_limit = tokenWindows[0] ?? null;
		result.tokens_limit_weekly = tokenWindows[1]
			? { ...tokenWindows[1], type: "tokens_limit_weekly" }
			: null;

		return result;
	} catch (error) {
		log.warn("Error fetching Zai usage data:", error);
		return null;
	}
}

/**
 * Both token windows, named in Claude terminology so the shared window helpers
 * (throttle pacing, weekly formatting) can size them without a zai special case.
 * time_limit is excluded: it caps the web tools, not model traffic.
 */
function tokenWindows(
	usage: ZaiUsageData,
): Array<{ name: string; percentage: number }> {
	const windows: Array<{ name: string; percentage: number }> = [];
	if (usage.tokens_limit && usage.tokens_limit.percentage !== undefined) {
		windows.push({ name: "five_hour", percentage: usage.tokens_limit.percentage });
	}
	if (
		usage.tokens_limit_weekly &&
		usage.tokens_limit_weekly.percentage !== undefined
	) {
		windows.push({
			name: "seven_day",
			percentage: usage.tokens_limit_weekly.percentage,
		});
	}
	return windows;
}

/**
 * Get the representative utilization percentage (0-100)
 * Returns the most exhausted token window — an account capped weekly is just as
 * unavailable as one capped for the hour.
 */
export function getRepresentativeZaiUtilization(
	usage: ZaiUsageData | null,
): number | null {
	if (!usage) return null;

	const windows = tokenWindows(usage);
	if (windows.length === 0) return null;

	return Math.max(...windows.map((w) => w.percentage));
}

/**
 * Determine which limit is the most restrictive (highest utilization)
 * Returns "five_hour" or "seven_day" to match Claude terminology
 */
export function getRepresentativeZaiWindow(
	usage: ZaiUsageData | null,
): string | null {
	if (!usage) return null;

	const windows = tokenWindows(usage);
	if (windows.length === 0) return null;

	const max = windows.reduce((prev, current) =>
		current.percentage > prev.percentage ? current : prev,
	);

	return max.name;
}
