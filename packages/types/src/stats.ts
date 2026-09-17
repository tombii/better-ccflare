import type { RateLimitReason } from "./account";

/** Whether a given integrity probe is a fast page-structure check or the
 *  slower full check (page structure + index/table cross-checks + foreign
 *  keys). The full check needs to run in a worker on large DBs. */
export type IntegrityCheckKind = "quick" | "full";

/**
 * Cached data-retention job status. Minimal by design (#384): retention
 * cleanup runs hourly and silently swallows errors into a log line today, so
 * there's no way to distinguish "retention healthy" from "retention dead for
 * weeks" without tailing logs. This exposes just enough for a dead-man alert
 * on `lastSuccessAt` plus the most recent error for triage.
 */
export interface RetentionStatus {
	/** Epoch ms when cleanupOldRequests + pruneUsageSnapshots last both completed without throwing; null before the first successful run. */
	lastSuccessAt: number | null;
	/** Most recent error message from a failed run; null if the last run succeeded (or none has failed yet). */
	lastError: string | null;
	/** Epoch ms of the most recent error; null if none has occurred. */
	lastErrorAt: number | null;
}

/**
 * Cached status of the adaptive incremental-vacuum backstop
 * (`DatabaseOperations.incrementalVacuumAdaptive`). Exists so an operator can
 * tell "reclaim is keeping up with deletes" from "the freelist is growing
 * unbounded" without tailing logs — the same gap `RetentionStatus` closed for
 * the retention job. Updated on every `incrementalVacuumAdaptive()` call,
 * whether it ran a reclaim, no-opped in steady state, or was skipped because
 * automatic reclaim is disabled.
 */
export interface VacuumStatus {
	/** Whether automatic (unattended) reclaim is enabled, as of the most recent call. Mirrors `auto_vacuum_enabled` / `BETTER_CCFLARE_AUTO_VACUUM`. Forced `false` whenever `supported` is `false` — the switch cannot enable something the backend cannot do. */
	enabled: boolean;
	/**
	 * Whether this backend can run incremental-vacuum reclaim at all.
	 * `false` on PostgreSQL, which has no freelist or `incremental_vacuum`
	 * concept, and stays `false` forever there — no call ever flips it back.
	 * Distinct from `enabled`: `enabled` reflects the operator switch,
	 * `supported` reflects backend capability. Both are forced `false` on an
	 * unsupported backend so `/health` never implies reclaim could run there.
	 */
	supported: boolean;
	/** Epoch ms of the most recent `incrementalVacuumAdaptive()` call, run or skipped-while-disabled; null before the first call. */
	lastRunAt: number | null;
	/** Pages reclaimed by the most recent call that actually ran a reclaim pass (0 in steady state or while disabled). */
	lastReclaimedPages: number;
	/** Worker chunks the most recent call issued (0 in steady state or while disabled). */
	lastChunks: number;
	/** `PRAGMA freelist_count` as of the end of the most recent call that ran; stale (not refreshed) while disabled. */
	freelistPages: number;
	/** `freelistPages / PRAGMA page_count`, 0-1; stale (not refreshed) while disabled. 0 when page_count is 0 (fresh/empty DB). */
	freelistRatio: number;
	/** Consecutive `incrementalVacuum()` ticks that failed to claim the writer slot (SQLITE_BUSY); mirrors the internal escalation counter used for the log warning. */
	consecutiveBusySkips: number;
	/** True once `consecutiveBusySkips` has crossed the escalation threshold — sustained reclaim starvation an operator should investigate. */
	escalated: boolean;
	/**
	 * Most recent error message (no stack trace) from a failed
	 * `incrementalVacuum()` chunk — e.g. a worker timeout or an `onerror`
	 * event. Null when the last attempted run completed without throwing, or
	 * none has failed yet.
	 */
	lastError: string | null;
	/**
	 * Consecutive 5-minute catch-up ticks that backed off because the async
	 * DB writer's queue was non-empty. Resets to 0 the next time a catch-up
	 * reclaim actually dispatches — NOT on a skip for any other reason (switch
	 * off, freelist ratio below threshold). A high value means the catch-up
	 * tick is being starved by writer contention, the exact condition it
	 * exists to work through.
	 */
	catchUpBusySkips: number;
	/** Lifetime total of the same backoff; never reset, a coarse long-run signal alongside the consecutive counter. */
	catchUpBusySkipsTotal: number;
}

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
 *
 * A "skipped" probe (the full check was skipped because the DB is over the
 * size threshold, or a worker run timed out) is informational only: it is
 * recorded in `lastQuickSkipReason` / `lastFullSkipReason` and does NOT mark
 * the DB corrupt. The collapsed `status` stays driven by the last real
 * ok/corrupt results — a skip never moves `status` to "corrupt".
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
	/** Reason the most recent quick probe was skipped (size threshold / timeout) instead of completing; null if it completed. */
	lastQuickSkipReason: string | null;
	/** Reason the most recent full probe was skipped (DB over size threshold, or worker timeout) instead of completing; null if it completed. */
	lastFullSkipReason: string | null;
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
		// Fixed-window burn-rate KPIs, independent of the active range/filters.
		// Daily: sum(last 7d) / effectiveDays(≤7). Weekly: sum(last 30d) × 7 / effectiveDays(≤30).
		// effectiveDays is clamped to the actual age of data so thin history doesn't inflate the average.
		// Optional because an older server may not populate them — consumers should `?? 0`.
		avgDailyPlanCostUsd?: number;
		avgWeeklyPlanCostUsd?: number;
		avgDailyApiCostUsd?: number;
		avgWeeklyApiCostUsd?: number;
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
	// Unpaused accounts whose usage window sits at 100%: they still count as
	// routable (no active cooldown), but upstream will reject their requests.
	// Surfaced separately so `routable > 0` stops masking an exhausted pool
	// (incident 2026-07-09).
	usage_exhausted: number;
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
	/**
	 * Build-time provenance. Populated from env vars injected by the
	 * Dockerfile at build time:
	 *   - version: `npm_package_version` (set by `bun run`/npm), or
	 *     BETTER_CCFLARE_VERSION at build time. Falls back to the literal
	 *     "unknown" if neither is set (dev runs without a build).
	 *   - git_sha: full 40-char commit SHA, or "unknown" if not set.
	 *   - git_ref: branch / tag name (e.g. "main", "deploy/2026-07-30"),
	 *     or "unknown" if not set.
	 *   - build_date: RFC 3339 timestamp the image was built, or "unknown".
	 */
	version?: string;
	git_sha?: string;
	git_ref?: string;
	build_date?: string;
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
		};
		storage?: {
			integrity?: {
				status: "ok" | "corrupt" | "unchecked" | "running";
				runningKind: IntegrityCheckKind | null;
				lastCheckAt: string | null;
				lastError: string | null;
				lastQuickCheckAt: string | null;
				lastQuickResult: "ok" | "corrupt" | null;
				lastFullCheckAt: string | null;
				lastFullResult: "ok" | "corrupt" | null;
			};
			retention?: {
				lastSuccessAt: string | null;
				lastError: string | null;
				lastErrorAt: string | null;
			};
			vacuum?: {
				enabled: boolean;
				supported: boolean;
				lastRunAt: string | null;
				lastReclaimedPages: number;
				lastChunks: number;
				freelistPages: number;
				freelistRatio: number;
				consecutiveBusySkips: number;
				escalated: boolean;
				lastError: string | null;
				catchUpBusySkips: number;
				catchUpBusySkipsTotal: number;
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
