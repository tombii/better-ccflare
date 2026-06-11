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

/**
 * Response types for the context insights endpoint (/api/insights/context).
 *
 * Char counts are JSON.stringify lengths of stored payload sections — they
 * are estimates, NOT token counts, and are converted with a clearly-labelled
 * ~4 chars/token heuristic. Exact token figures (tokenTotals, growth curve)
 * come from the requests-table token columns instead.
 */

/**
 * Char totals per context section across all parsed payloads, with
 * ~4 chars/token estimates and share-of-total percentages.
 */
export interface ContextCompositionTotals {
	systemChars: number;
	toolsChars: number;
	messagesChars: number;
	totalChars: number;
	/** Math.round(chars / CHARS_PER_TOKEN) per section. */
	estimatedTokens: {
		system: number;
		tools: number;
		messages: number;
		total: number;
	};
	/** Share of totalChars per section (0-100); all 0 when totalChars is 0. */
	percentages: {
		system: number;
		tools: number;
		messages: number;
	};
}

/**
 * Exact token sums over the ANALYZED (successfully parsed) requests, taken
 * from the requests-table columns — not estimated from chars.
 */
export interface ContextTokenTotals {
	uncachedInputTokens: number;
	cacheReadInputTokens: number;
	cacheCreationInputTokens: number;
}

/** Composition breakdown for one request whose payload parsed successfully. */
export interface ContextRequestComposition {
	id: string;
	timestamp: number;
	account: string | null;
	model: string | null;
	project: string | null;
	systemChars: number;
	toolsChars: number;
	messagesChars: number;
	totalChars: number;
	/** ~4 chars/token estimate over totalChars. */
	estimatedContextTokens: number;
	/** Exact requests-table token columns. */
	inputTokens: number;
	cacheReadInputTokens: number;
	cacheCreationInputTokens: number;
	outputTokens: number;
}

/** Kind of message content block reported as a context contributor. */
export type ContextContributorKind = "tool_result" | "text" | "tool_use";

/**
 * One large content block, grouped by content hash across analyzed requests
 * so re-sent copies of the same block collapse into a single entry.
 */
export interface ContextContributor {
	kind: ContextContributorKind;
	/**
	 * Tool name for tool_result/tool_use blocks when resolvable, else a short
	 * single-line content preview (first ~80 chars).
	 */
	label: string;
	/** Serialized size of the largest copy seen. */
	maxChars: number;
	/** ~4 chars/token estimate over maxChars. */
	estimatedTokens: number;
	/** Total times the block was seen across analyzed requests. */
	occurrences: number;
	/** Distinct requests the block appeared in. */
	requestCount: number;
}

/** One request's exact token point on the context growth curve. */
export interface ContextGrowthPoint {
	requestId: string;
	timestamp: number;
	/** input + cache_read + cache_creation (exact requests-table columns). */
	contextTokens: number;
	outputTokens: number;
}

/**
 * A run of requests for one project, split from its neighbours by a
 * configurable time gap (no real session id exists in the schema).
 */
export interface ContextGrowthSession {
	project: string | null;
	startTimestamp: number;
	endTimestamp: number;
	/** Requests in the session BEFORE any per-session point cap was applied. */
	requestCount: number;
	points: ContextGrowthPoint[];
}

/** Metadata echoed back with a context insights response. */
export interface ContextInsightsMeta {
	range: string;
	generatedAt: number;
	/** Payload rows fetched and analyzed (parse attempted). */
	scannedPayloads: number;
	parsedPayloads: number;
	unparseablePayloads: number;
	/** True when more payload-bearing requests existed than the scan limit. */
	truncated: boolean;
	/**
	 * Payload storage is optional and retention-cleaned, so coverage is
	 * partial: requests in the window vs requests with a stored payload.
	 */
	payloadCoverage: {
		requestsInRange: number;
		requestsWithPayload: number;
	};
	/** Human-readable caveat about char-based estimates and partial coverage. */
	estimateNote: string;
}

/** Full response of GET /api/insights/context. */
export interface ContextInsightsResponse {
	meta: ContextInsightsMeta;
	composition: {
		totals: ContextCompositionTotals;
		tokenTotals: ContextTokenTotals;
		perRequest: ContextRequestComposition[];
	};
	topContributors: ContextContributor[];
	growthCurve: {
		sessions: ContextGrowthSession[];
		/** True when the growth scan cap or session/point caps trimmed data. */
		truncated: boolean;
	};
}
