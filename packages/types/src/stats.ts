import type { RateLimitReason } from "./account";

/** Whether a given integrity probe is a fast page-structure check or the
 *  slower full check (page structure + index/table cross-checks + foreign
 *  keys). The full check needs to run in a worker on large DBs. */
export type IntegrityCheckKind = "quick" | "full";

/**
 * Cached integrity status. The `status` collapses both probes into a single
 * surface, but each probe's own most-recent result is preserved so a quick
 * `ok` cannot mask a previously-detected full `corrupt`.
 *
 * Status semantics:
 *  - `unchecked`: no probe has completed yet (fresh boot, scheduler still in
 *    its initial-delay window).
 *  - `running`: a probe is currently in flight; `runningKind` says which.
 *  - `ok`: both the last-known quick and full results are "ok" (or only one
 *    has been run and it was "ok").
 *  - `corrupt`: at least one of the last-known probes returned non-"ok".
 *    A subsequent quick `ok` clears quick-only corruption but does NOT clear
 *    a full `corrupt`; only another full `ok` does that.
 */
export interface IntegrityStatus {
	status: "ok" | "corrupt" | "unchecked" | "running";
	/** Which kind of probe is in flight when status="running"; null otherwise. */
	runningKind: IntegrityCheckKind | null;
	/** Last completed probe of either kind, ms epoch. */
	lastCheckAt: number | null;
	/** Combined error message if status is "corrupt"; null when "ok". */
	lastError: string | null;
	/** Most recent quick_check result. */
	lastQuickCheckAt: number | null;
	lastQuickResult: "ok" | "corrupt" | null;
	lastQuickError: string | null;
	/** Most recent full integrity_check + foreign_key_check result. */
	lastFullCheckAt: number | null;
	lastFullResult: "ok" | "corrupt" | null;
	lastFullError: string | null;
}

// Stats types
export interface Stats {
	totalRequests: number;
	successRate: number;
	activeAccounts: number;
	avgResponseTime: number;
	totalTokens: number;
	totalCostUsd: number;
	topModels: Array<{ model: string; count: number }>;
	avgTokensPerSecond: number | null;
}

export interface StatsResponse {
	totalRequests: number;
	successRate: number;
	activeAccounts: number;
	avgResponseTime: number;
	totalTokens: number;
	totalCostUsd: number;
	topModels: Array<{ model: string; count: number }>;
	avgTokensPerSecond: number | null;
}

export interface RecentErrorGroup {
	errorCode: string; // raw value from requests.error_message
	accountId: string | null; // null when unauthenticated
	accountName: string | null; // null when account deleted
	provider: string | null; // owning account's provider, null when account deleted
	occurrenceCount: number;
	latestTimestamp: number; // ms epoch
	firstTimestamp: number; // ms epoch
	latestRequestId: string;
	model: string | null;
	statusCode: number | null;
	path: string | null;
	failoverAttempts: number;
	rateLimitedUntil: number | null; // from accounts table, ms epoch
	rateLimitedReason: RateLimitReason | null;
	rateLimitedAt: number | null;
}

export interface StatsWithAccounts extends Stats {
	accounts: Array<{
		name: string;
		requestCount: number;
		successRate: number;
	}>;
	recentErrors: RecentErrorGroup[];
}

// Analytics types
export interface TimePoint {
	ts: number; // period start (ms)
	model?: string; // Optional model name for per-model time series
	requests: number;
	tokens: number;
	costUsd: number;
	planCostUsd: number;
	apiCostUsd: number;
	successRate: number; // 0-100
	errorRate: number; // 0-100
	cacheHitRate: number; // 0-100
	avgResponseTime: number; // ms
	avgTokensPerSecond: number | null;
}

export interface TokenBreakdown {
	inputTokens: number;
	cacheReadInputTokens: number;
	cacheCreationInputTokens: number;
	outputTokens: number;
}

export interface ModelPerformance {
	model: string;
	avgResponseTime: number;
	p95ResponseTime: number;
	errorRate: number;
	avgTokensPerSecond: number | null;
	minTokensPerSecond: number | null;
	maxTokensPerSecond: number | null;
}

export interface AnalyticsResponse {
	meta?: {
		range: string;
		bucket: string;
		cumulative?: boolean;
	};
	totals: {
		requests: number;
		successRate: number;
		activeAccounts: number;
		avgResponseTime: number;
		totalTokens: number;
		totalCostUsd: number;
		planCostUsd: number;
		apiCostUsd: number;
		avgTokensPerSecond: number | null;
	};
	timeSeries: TimePoint[];
	tokenBreakdown: TokenBreakdown;
	modelDistribution: Array<{ model: string; count: number }>;
	accountPerformance: Array<{
		name: string;
		requests: number;
		successRate: number;
		planCostUsd: number;
		apiCostUsd: number;
		totalCostUsd: number;
	}>;
	apiKeyPerformance: Array<{
		id: string;
		name: string;
		requests: number;
		successRate: number;
	}>;
	costByModel: Array<{
		model: string;
		costUsd: number;
		requests: number;
		totalTokens?: number;
	}>;
	accountModelUsage: Array<{ account: string; model: string; count: number }>;
	modelPerformance: ModelPerformance[];
}

// Pool status for health check
export interface PoolStatus {
	configured: number; // Total accounts in database
	routable: number; // Available for routing
	paused: number; // Manually or automatically paused
	rate_limited: number; // Temporarily rate-limited
	next_available_at: string | null; // ISO timestamp when earliest rate-limit expires
}

// Account detail for ?detail=1
export interface AccountDetail {
	name: string;
	status: "available" | "paused" | "rate_limited";
	rate_limited_until: number | null;
	rate_limited_reason: RateLimitReason | null;
	rate_limited_at: number | null;
}

// Health check response
export interface HealthResponse {
	status: string;
	accounts: number;
	timestamp: string;
	strategy: string;
	pool?: PoolStatus;
	accounts_detail?: Array<AccountDetail>;
	runtime?: {
		asyncWriter?: {
			healthy: boolean;
			failureCount: number;
			queuedJobs: number;
		};
		usageWorker?: {
			state: string;
			pendingAcks: number;
			lastError: string | null;
			startedAt: number | null;
		};
		storage?: {
			integrity: {
				status: "ok" | "corrupt" | "unchecked" | "running";
				runningKind: IntegrityCheckKind | null;
				lastCheckAt: string | null;
				lastError: string | null;
				lastQuickCheckAt: string | null;
				lastQuickResult: "ok" | "corrupt" | null;
				lastFullCheckAt: string | null;
				lastFullResult: "ok" | "corrupt" | null;
			};
		};
	};
}

// Config types
export interface ConfigResponse {
	lb_strategy: string;
	port: number;
	sessionDurationMs: number;
	default_agent_model: string;
	tls_enabled: boolean;
	system_prompt_cache_ttl_1h: boolean;
	usage_throttling_five_hour_enabled: boolean;
	usage_throttling_weekly_enabled: boolean;
}

export interface StrategyUpdateRequest {
	strategy: string;
}
