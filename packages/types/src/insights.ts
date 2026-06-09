/**
 * Response types for the cache insights endpoint (/api/insights/cache).
 *
 * Pure data shapes shared between the HTTP API and the dashboard.
 */

/** Metadata echoed back with a cache insights response. */
export interface CacheInsightsMeta {
	range: string;
	thresholdPercent: number;
	minRequestsForFlag: number;
}

/**
 * Aggregate totals across all rows of a cache insights response.
 * Cost fields sum over pricing-known volume only.
 */
export interface CacheInsightsTotals {
	requests: number;
	uncachedInputTokens: number;
	cacheReadInputTokens: number;
	cacheCreationInputTokens: number;
	cacheHitRate: number;
	/** Sums over pricing-known volume only. */
	actualCacheCostUsd: number;
	counterfactualCostUsd: number;
	savingsUsd: number;
	/** Distinct model ids (sorted) whose rates were unusable. */
	unknownPricingModels: string[];
}

/**
 * One row of the cache insights response.
 *
 * Cost fields (actualCacheCostUsd, counterfactualCostUsd, savingsUsd) are
 * null whenever pricingKnown is false — i.e. when ANY portion of the row's
 * token volume belongs to a model whose rates were unusable (unknown model,
 * or a null cacheRead/cacheWrite rate with non-zero corresponding tokens).
 */
export interface CacheInsightsRow {
	key: string;
	requests: number;
	uncachedInputTokens: number;
	cacheReadInputTokens: number;
	cacheCreationInputTokens: number;
	/** 0-100; cache_read * 100 / (uncached + cache_read + cache_creation), 0 when denominator is 0 */
	cacheHitRate: number;
	actualCacheCostUsd: number | null;
	counterfactualCostUsd: number | null;
	savingsUsd: number | null;
	pricingKnown: boolean;
	flagged: boolean;
}

/** Full response of GET /api/insights/cache. */
export interface CacheInsightsResponse {
	meta: CacheInsightsMeta;
	totals: CacheInsightsTotals;
	byModel: CacheInsightsRow[];
	byAccount: CacheInsightsRow[];
	byProject: CacheInsightsRow[];
}
