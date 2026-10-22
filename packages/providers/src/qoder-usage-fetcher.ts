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
 *
 * When `total` is 0 there is nothing to divide by, and the utilization is
 * reported as **null** — "no opinion" — rather than as 0 or 100. A zero-credit
 * account is NOT out of service: Qoder's free models are served at a zero
 * balance and report `billable: false`, so `isQuotaExceeded` describes the
 * *credit* balance, not the account's ability to answer. Reading it as 100%
 * would mark the account usage-exhausted and take it out of the rotation
 * entirely, which is exactly the account this provider exists to serve. A
 * paid model on a zero-credit account fails at request time (Qoder's quota
 * code), and that failure — not the balance — is what benches the account.
 */
export function mapQoderQuota(quota: QoderQuota): QoderUsageData {
	const total = Math.max(0, quota.total);
	const used = Math.max(0, quota.used);
	const utilizationPercent =
		total > 0 ? Math.min(100, (used / total) * 100) : null;
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
 * What the fetcher needs from an account.
 *
 * The ACCOUNT, not a bare endpoint string: the quota endpoint lives on
 * Qoder's OpenAPI host, which is derived from the account's custom endpoint
 * (the gateway host) by the shared resolver. Handing the fetcher a host
 * string instead is how the two hosts got confused.
 */
export interface QoderUsageAccount {
	access_token?: string | null;
	custom_endpoint?: string | null;
}

/**
 * Fetch usage for a Qoder account.
 *
 * The account's `access_token` may be the stored prefixed token
 * (`__qoder_jwt.<mode>.<token>`) or a bare job token; it is decoded first, and
 * an undecodable value yields null rather than a request with a broken bearer.
 *
 * Non-blocking: never throws, returns null on any failure.
 */
export async function fetchQoderUsageData(
	account: QoderUsageAccount | null | undefined,
): Promise<QoderUsageData | null> {
	try {
		const decoded = decodeQoderAccessToken(account?.access_token);
		if (!decoded?.token) return null;
		const quota = await fetchQoderQuota(decoded.token, account);
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
