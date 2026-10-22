import {
	decodeQoderAccessToken,
	fetchQoderQuota,
	type QoderQuota,
} from "./providers/qoder/auth-flow";

/**
 * Qoder usage: a credit balance read from the OpenAPI quota endpoint with the
 * account's short-lived job token. Shapes the balance the way Kilo's credit
 * data is shaped so the dashboard's credit-balance panel can render it.
 */
export interface QoderUsageData {
	totalCredits: number;
	usedCredits: number;
	/** Remaining credits as reported upstream (clamped at 0) */
	remainingCredits: number;
	unit: string;
	isQuotaExceeded: boolean;
	/** Utilization as percentage 0-100; null when there is no balance to divide by */
	utilizationPercent: number | null;
}

/**
 * Map an upstream quota payload to the fetcher's shape.
 *
 * A credit balance has no percentage window, so utilization is used/total.
 * When `total` is 0 there is nothing to divide by: an exhausted quota reports
 * 100% (the account genuinely cannot serve), and anything else reports 0 —
 * a zero-balance account with no cap left to spend against is not "used up" in
 * any way a threshold or ranking could act on.
 */
export function mapQoderQuota(quota: QoderQuota): QoderUsageData {
	const total = Math.max(0, quota.total);
	const used = Math.max(0, quota.used);
	let utilizationPercent: number | null;
	if (total > 0) {
		utilizationPercent = Math.min(100, (used / total) * 100);
	} else {
		utilizationPercent = quota.isQuotaExceeded ? 100 : 0;
	}
	return {
		totalCredits: total,
		usedCredits: used,
		remainingCredits: Math.max(0, quota.remaining),
		unit: quota.unit || "credits",
		isQuotaExceeded: quota.isQuotaExceeded,
		utilizationPercent,
	};
}

/**
 * Fetch usage for a Qoder account.
 *
 * `accessToken` may be the account's stored access token (prefixed
 * `__qoder_jwt.<mode>.<token>`) or a bare job token; it is decoded first, and
 * an undecodable value yields null rather than a request with a broken bearer.
 * `endpoint` is the account's custom endpoint (a CN-region OpenAPI host), when
 * one is set.
 *
 * Non-blocking: never throws, returns null on any failure.
 */
export async function fetchQoderUsageData(
	accessToken: string | null | undefined,
	endpoint?: string | null,
): Promise<QoderUsageData | null> {
	try {
		const decoded = decodeQoderAccessToken(accessToken);
		if (!decoded?.token) return null;
		const quota = await fetchQoderQuota(decoded.token, endpoint);
		if (!quota) return null;
		return mapQoderQuota(quota);
	} catch {
		return null;
	}
}

/**
 * Get the representative utilization percentage (0-100)
 */
export function getRepresentativeQoderUtilization(
	usage: QoderUsageData | null,
): number | null {
	if (!usage) return null;
	return usage.utilizationPercent;
}

/**
 * Get the representative window label (a credit balance has no reset window).
 */
export function getRepresentativeQoderWindow(
	_usage: QoderUsageData | null,
): string | null {
	return "credits";
}
