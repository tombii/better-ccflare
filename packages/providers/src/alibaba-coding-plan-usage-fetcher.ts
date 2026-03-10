import { Logger } from "@better-ccflare/logger";

const log = new Logger("AlibabaCodingPlanUsageFetcher");

const USAGE_URL =
	"https://bailian-singapore-cs.alibabacloud.com/data/api.json?action=IntlBroadScopeAspnGateway&product=sfm_bailian&api=zeldaEasy.broadscope-bailian.codingPlan.queryCodingPlanInstanceInfoV2&_v=undefined";

export interface AlibabaCodingPlanQuotaWindow {
	used: number;
	total: number;
	/** Percentage 0-100 */
	percentUsed: number;
	resetAt: number | null; // Unix timestamp in milliseconds
}

export interface AlibabaCodingPlanUsageData {
	five_hour: AlibabaCodingPlanQuotaWindow;
	weekly: AlibabaCodingPlanQuotaWindow;
	monthly: AlibabaCodingPlanQuotaWindow;
	/** Plan name e.g. "Coding Plan Lite" */
	planName: string | null;
	/** Plan status e.g. "VALID" */
	status: string | null;
	/** Remaining days in billing period */
	remainingDays: number | null;
}

/**
 * Fetch usage data from Alibaba Coding Plan's quota endpoint.
 * This is non-blocking - failures return null and won't affect provider operation.
 */
export async function fetchAlibabaCodingPlanUsageData(
	apiKey: string,
): Promise<AlibabaCodingPlanUsageData | null> {
	try {
		const response = await fetch(USAGE_URL, {
			method: "GET",
			headers: {
				Authorization: `Bearer ${apiKey}`,
				Accept: "application/json",
			},
		});

		if (!response.ok) {
			const errorMessage = response.statusText;
			const responseHeaders = Object.fromEntries(response.headers.entries());
			try {
				const errorBody = await response.text();
				log.warn(
					`Failed to fetch Alibaba Coding Plan usage data: ${response.status} ${errorMessage}`,
					{
						status: response.status,
						statusText: errorMessage,
						url: USAGE_URL,
						headers: responseHeaders,
						errorBody,
						timestamp: new Date().toISOString(),
					},
				);
			} catch {
				log.warn(
					`Failed to fetch Alibaba Coding Plan usage data: ${response.status} ${errorMessage}`,
					{
						status: response.status,
						statusText: errorMessage,
						url: USAGE_URL,
						headers: responseHeaders,
						timestamp: new Date().toISOString(),
					},
				);
			}
			return null;
		}

		const json = await response.json();

		// Navigate the nested response structure
		const dataV2 = json?.data?.DataV2;
		if (!dataV2?.success) {
			log.warn("Alibaba Coding Plan usage API returned unsuccessful response", {
				errorCode: json?.data?.errorCode,
				errorMsg: json?.data?.errorMsg,
			});
			return null;
		}

		const instances: unknown[] =
			dataV2?.data?.data?.codingPlanInstanceInfos ?? [];
		if (instances.length === 0) {
			log.warn("No Alibaba Coding Plan instances found in response");
			return null;
		}

		// Use the first VALID instance, or fall back to the first one
		const instance =
			(instances as Array<{ status?: string }>).find(
				(i) => i.status === "VALID",
			) ?? instances[0];

		const quota =
			(instance as { codingPlanQuotaInfo?: Record<string, number> })
				.codingPlanQuotaInfo ?? {};
		const info = instance as {
			instanceName?: string;
			status?: string;
			remainingDays?: number;
		};

		const fiveHourUsed = quota.per5HourUsedQuota ?? 0;
		const fiveHourTotal = quota.per5HourTotalQuota ?? 0;
		const weeklyUsed = quota.perWeekUsedQuota ?? 0;
		const weeklyTotal = quota.perWeekTotalQuota ?? 0;
		const monthlyUsed = quota.perBillMonthUsedQuota ?? 0;
		const monthlyTotal = quota.perBillMonthTotalQuota ?? 0;

		return {
			five_hour: {
				used: fiveHourUsed,
				total: fiveHourTotal,
				percentUsed:
					fiveHourTotal > 0
						? Math.min(100, (fiveHourUsed / fiveHourTotal) * 100)
						: 0,
				resetAt: quota.per5HourQuotaNextRefreshTime ?? null,
			},
			weekly: {
				used: weeklyUsed,
				total: weeklyTotal,
				percentUsed:
					weeklyTotal > 0 ? Math.min(100, (weeklyUsed / weeklyTotal) * 100) : 0,
				resetAt: quota.perWeekQuotaNextRefreshTime ?? null,
			},
			monthly: {
				used: monthlyUsed,
				total: monthlyTotal,
				percentUsed:
					monthlyTotal > 0
						? Math.min(100, (monthlyUsed / monthlyTotal) * 100)
						: 0,
				resetAt: quota.perBillMonthQuotaNextRefreshTime ?? null,
			},
			planName: info.instanceName ?? null,
			status: info.status ?? null,
			remainingDays: info.remainingDays ?? null,
		};
	} catch (error) {
		log.warn("Error fetching Alibaba Coding Plan usage data:", error);
		return null;
	}
}

/**
 * Get the representative utilization percentage (0-100).
 * Returns the highest utilization across 5-hour, weekly, and monthly windows.
 */
export function getRepresentativeAlibabaCodingPlanUtilization(
	usage: AlibabaCodingPlanUsageData | null,
): number | null {
	if (!usage) return null;

	return Math.max(
		usage.five_hour.percentUsed,
		usage.weekly.percentUsed,
		usage.monthly.percentUsed,
	);
}

/**
 * Get the label of the most restrictive window.
 */
export function getRepresentativeAlibabaCodingPlanWindow(
	usage: AlibabaCodingPlanUsageData | null,
): string | null {
	if (!usage) return null;

	const windows = [
		{ name: "five_hour", util: usage.five_hour.percentUsed },
		{ name: "weekly", util: usage.weekly.percentUsed },
		{ name: "monthly", util: usage.monthly.percentUsed },
	];

	const max = windows.reduce((prev, cur) =>
		cur.util > prev.util ? cur : prev,
	);

	return max.name;
}
