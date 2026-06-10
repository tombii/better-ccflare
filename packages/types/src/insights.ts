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

/**
 * Response types for the anomaly insights endpoint (/api/insights/anomalies).
 */

/** Which per-request token metric an outlier was detected on. */
export type TokenOutlierMetric = "total_tokens" | "output_tokens";

/** Effective detector thresholds echoed back with an anomalies response. */
export interface AnomalyInsightsMeta {
	range: string;
	zScoreThreshold: number;
	minBaselineRequests: number;
	loopWindowMinutes: number;
	loopMinRequests: number;
	/** Max coefficient of variation of request-side tokens for a burst to count as a loop. */
	loopSimilarityTolerance: number;
	misroutingMaxTotalTokens: number;
	misroutingMinOutputRateUsd: number;
	misroutingMinRequests: number;
	maxEventsPerDetector: number;
	/** Number of request rows the detectors actually ran over. */
	scannedRequests: number;
	/** True when the window held more rows than the scan cap; only the most recent rows were analyzed. */
	truncated: boolean;
}

/**
 * Rolling token baseline for one (account, model) pair over the requested
 * window. Only computed from requests with at least one token; groups with
 * fewer than minBaselineRequests such requests have no baseline.
 */
export interface AnomalyBaseline {
	account: string;
	model: string;
	requests: number;
	meanTotalTokens: number;
	stdDevTotalTokens: number;
	meanOutputTokens: number;
	stdDevOutputTokens: number;
}

/**
 * A single request whose token usage sits at or above zScoreThreshold
 * standard deviations over its (account, model) baseline mean. Low-side
 * deviations are never reported.
 */
export interface TokenOutlierEvent {
	requestId: string;
	timestamp: number;
	account: string;
	model: string;
	project: string | null;
	metric: TokenOutlierMetric;
	value: number;
	baselineMean: number;
	baselineStdDev: number;
	zScore: number;
}

/**
 * A sustained burst of near-identical requests (same account/model/project,
 * similar request-side token profile) dense enough to look like a runaway
 * agent loop.
 */
export interface RunawayLoopGroup {
	account: string;
	model: string;
	project: string | null;
	windowStartMs: number;
	windowEndMs: number;
	requests: number;
	/** Request rate over the burst, floored at a one-minute span. */
	requestsPerMinute: number;
	/** Mean request-side tokens (input + cache read + cache creation). */
	meanRequestSideTokens: number;
	/** Coefficient of variation of request-side tokens (0 = identical). */
	requestSideTokenSpread: number;
}

/**
 * An (account, model) pair where an expensive model handled repeated
 * trivially small calls that a cheaper model could likely serve.
 */
export interface ModelMisroutingGroup {
	account: string;
	model: string;
	requests: number;
	meanTotalTokens: number;
	/** The model's output rate ($ per 1M tokens) that classified it as expensive. */
	outputRateUsd: number;
	/** Sum of logged cost_usd over the flagged calls. */
	totalCostUsd: number;
	/** Up to five request ids illustrating the pattern. */
	exampleRequestIds: string[];
}

/** Full response of GET /api/insights/anomalies. */
export interface AnomalyInsightsResponse {
	meta: AnomalyInsightsMeta;
	baselines: AnomalyBaseline[];
	tokenOutliers: TokenOutlierEvent[];
	outputBlowups: TokenOutlierEvent[];
	runawayLoops: RunawayLoopGroup[];
	misrouting: ModelMisroutingGroup[];
}
