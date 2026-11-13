import type {
	ApiKeyUsageEfficiencyStatus,
	ApiKeyUsageSeriesPoint,
} from "@better-ccflare/types";

/**
 * Pure, structural helpers for the API Key Usage page.
 *
 * Kept decoupled from the full ApiKeyResponse type, the same way the Usage
 * History tab's tab-helpers.ts is, so they stay trivially testable.
 */
export interface ApiKeyLike {
	id: string;
	name: string;
	isActive?: boolean;
}

/** First active key's id; else the first key's id; else undefined. */
export function pickDefaultApiKey(keys?: ApiKeyLike[]): string | undefined {
	if (!keys || keys.length === 0) return undefined;
	const active = keys.find((key) => key.isActive !== false);
	return (active ?? keys[0]).id;
}

/**
 * New array with active keys first (stable within each group).
 *
 * Mirrors sortAccountsActiveFirst: a disabled key still has history worth
 * looking at, so it stays in the list rather than being filtered out — it
 * just does not get to be the default or the top of the dropdown.
 */
export function sortKeysActiveFirst<T extends ApiKeyLike>(keys: T[]): T[] {
	// Copy first: Array.prototype.sort mutates in place and callers pass live
	// query data. V8/Bun sort is stable, so equal-group order is preserved.
	return [...keys].sort(
		(a, b) => Number(a.isActive === false) - Number(b.isActive === false),
	);
}

/**
 * The headline number.
 *
 * Returns null when there is nothing honest to print, so the caller renders
 * the word "unavailable" rather than `Infinity` or `NaN` — which is exactly
 * what a naive planValue/planCost division produces for a key whose accounts
 * carry no price.
 *
 * Above 10 the decimals are noise on a figure that is routinely in the tens
 * or hundreds; below 10 they are the whole signal.
 */
export function formatEfficiencyRatio(
	ratio: number | null,
	status: ApiKeyUsageEfficiencyStatus,
): string | null {
	if (ratio === null || !Number.isFinite(ratio)) return null;
	if (status === "unpriced" || status === "no_plan_traffic") return null;
	if (ratio >= 10) return `${Math.round(ratio)}x`;
	return `${ratio.toFixed(1)}x`;
}

/** One line explaining what the ratio does and does not cover. */
export function efficiencyCaption(
	status: ApiKeyUsageEfficiencyStatus,
	unpricedAccountCount: number,
): string {
	switch (status) {
		case "ok":
			return "API-rate value bought per real subscription dollar.";
		case "partial":
			return `Priced accounts only — ${unpricedAccountCount} account${
				unpricedAccountCount === 1 ? " has" : "s have"
			} no monthly price set.`;
		case "unpriced":
			return "No account with plan traffic has a monthly price set. Set one on the Accounts page to get a ratio.";
		default:
			return "This key sent no subscription-billed traffic in this window.";
	}
}

/**
 * X-axis label for a series bucket.
 *
 * Buckets an hour or finer get a clock time; day buckets get a date. The
 * endpoint reports the bucket width it used, so the axis never has to guess
 * from the range string.
 */
export function formatSeriesTick(ts: number, bucketMs: number): string {
	const date = new Date(ts);
	if (bucketMs >= 24 * 60 * 60 * 1000) {
		return date.toLocaleDateString(undefined, {
			month: "short",
			day: "numeric",
		});
	}
	return date.toLocaleTimeString(undefined, {
		hour: "2-digit",
		minute: "2-digit",
	});
}

/**
 * One chart row. Indexed rather than a plain interface so it satisfies the
 * charts' `ChartDataPoint = Record<string, string | number | null>` without a
 * cast at every call site.
 */
export interface CostChartPoint {
	[key: string]: string | number | null;
	ts: number;
	label: string;
	apiCostUsd: number;
	planValueUsd: number;
	totalCostUsd: number;
}

/**
 * Shape the series for recharts, and report the y-max in ONE pass.
 *
 * Explicit loop rather than `Math.max(...points.map(...))`, following the
 * note in UsageHistoryChart.tsx: on the 30d range a long-lived page can hold
 * a few thousand buckets, and spreading an array that size into Math.max
 * both allocates an intermediate array per render and risks a stack overflow
 * on very long series. One pass, no intermediate.
 */
export function buildCostSeries(
	points: ApiKeyUsageSeriesPoint[],
	bucketMs: number,
): { data: CostChartPoint[]; maxCost: number } {
	const data: CostChartPoint[] = new Array(points.length);
	let maxCost = 0;
	for (let i = 0; i < points.length; i++) {
		const point = points[i];
		const stacked = point.apiCostUsd + point.planValueUsd;
		if (stacked > maxCost) maxCost = stacked;
		data[i] = {
			ts: point.ts,
			label: formatSeriesTick(point.ts, bucketMs),
			apiCostUsd: point.apiCostUsd,
			planValueUsd: point.planValueUsd,
			totalCostUsd: stacked,
		};
	}
	return { data, maxCost };
}

/** Resolve ID links and legacy name links, decoding their raw URL exactly once. */
export function apiKeyPageTarget(pathname: string, search = ""): string | null {
	if (pathname.startsWith("/api-keys/")) {
		try {
			return decodeURIComponent(pathname.slice("/api-keys/".length)) || null;
		} catch {
			return null;
		}
	}
	if (pathname === "/api-key-usage")
		return new URLSearchParams(search).get("key");
	return null;
}

/** Push a key selection while retaining the range, custom bounds and URL UI state. */
export function apiKeyUsageSelectionLocation(
	keyId: string,
	search: string,
): string {
	const params = new URLSearchParams(search);
	params.delete("key");
	const query = params.toString();
	return `/api-keys/${encodeURIComponent(keyId)}${query ? `?${query}` : ""}`;
}
