import type { Config } from "@better-ccflare/config";
import { isAccountAvailable, TtlCache } from "@better-ccflare/core";
import type { DatabaseOperations } from "@better-ccflare/database";
import { jsonResponse } from "@better-ccflare/http-common";
import {
	getRepresentativeUtilizationForProvider,
	usageCache,
} from "@better-ccflare/providers";
import type { Account } from "@better-ccflare/types";
import type { HealthResponse, IntegrityStatus, PoolStatus } from "../types";
import {
	getRepresentativeUsageResetMs,
	isUsageExhausted,
} from "./rate-limit-status";

/**
 * Usage snapshot for exhaustion accounting: representative utilization
 * (0-100) plus the representative window's reset time when known.
 */
export interface AccountUsageInfo {
	utilization: number;
	resetMs: number | null;
}
export type AccountUsageInfoFn = (account: Account) => AccountUsageInfo | null;

const usageCacheUsageInfo: AccountUsageInfoFn = (account) => {
	const data = usageCache.get(account.id);
	if (!data) return null;
	const provider = account.provider ?? "anthropic";
	const utilization = getRepresentativeUtilizationForProvider(data, provider);
	if (utilization === null) return null;
	// Same provider-aware reset derivation as the accounts handler, so the
	// staleness guard sees identical inputs on both surfaces (PR #299 review
	// finding: guarding only anthropic-shaped payloads recreated the /health
	// vs accounts split-brain for the other providers).
	return {
		utilization,
		resetMs: getRepresentativeUsageResetMs(data, provider),
	};
};

type AsyncWriterHealthFn = () => {
	healthy: boolean;
	failureCount: number;
	recentDrops: number;
	queuedJobs: number;
	metadataQueuedJobs: number;
	payloadQueuedJobs: number;
	payloadBytesPending: number;
	oldestMetadataAgeMs: number;
	oldestPayloadAgeMs: number;
	metadataDropped: number;
	payloadDropped: number;
	payloadDroppedBytes: number;
};
type UsageWorkerHealthFn = () => {
	state: string;
};
type IntegrityStatusFn = () => IntegrityStatus;

export function computePoolStatus(
	accounts: Account[],
	now: number,
	getUsageInfo: AccountUsageInfoFn = () => null,
): PoolStatus {
	const configured = accounts.length;
	const paused = accounts.filter((a) => a.paused).length;
	const rateLimitedAccounts = accounts.filter(
		(a) => !a.paused && a.rate_limited_until && a.rate_limited_until >= now,
	);
	const rate_limited = rateLimitedAccounts.length;
	const routable = accounts.filter((a) => isAccountAvailable(a, now)).length;
	// Subset of `routable`: accounts with no pause and no active cooldown
	// whose usage window sits at 100% — they look available locally, yet
	// upstream rejects their requests, so `routable > 0` alone can mask an
	// effectively exhausted pool (incident 2026-07-09). Benched accounts are
	// excluded — they are already visible via `rate_limited`, and counting
	// them here would let usage_exhausted exceed routable (PR #299 review
	// finding).
	const usage_exhausted = accounts.filter((a) => {
		if (!isAccountAvailable(a, now)) return false;
		const usage = getUsageInfo(a);
		return (
			usage !== null && isUsageExhausted(usage.utilization, usage.resetMs, now)
		);
	}).length;

	const earliestRateLimit = rateLimitedAccounts.reduce<number | null>(
		(min, account) => {
			if (!account.rate_limited_until) return min;
			return min === null
				? account.rate_limited_until
				: Math.min(min, account.rate_limited_until);
		},
		null,
	);

	const next_available_at = earliestRateLimit
		? new Date(earliestRateLimit).toISOString()
		: null;

	return {
		configured,
		paused,
		rate_limited,
		routable,
		usage_exhausted,
		next_available_at,
	};
}

export function computeHealthStatus(
	runtimeHealthy: boolean,
	pool: PoolStatus,
): "unhealthy" | "degraded" | "ok" {
	// Unhealthy: runtime broken OR no accounts configured OR empty pool with no recovery
	if (
		!runtimeHealthy ||
		pool.configured === 0 ||
		(pool.routable === 0 && !pool.next_available_at)
	) {
		return "unhealthy";
	}

	// Degraded: empty pool but will recover
	if (pool.routable === 0 && pool.next_available_at) {
		return "degraded";
	}

	// OK: runtime healthy and routable accounts available
	return "ok";
}

function toHttpStatus(status: HealthResponse["status"]): 200 | 503 {
	return status === "ok" ? 200 : 503;
}

export function createHealthHandler(
	dbOps: DatabaseOperations,
	config: Config,
	getAsyncWriterHealth?: AsyncWriterHealthFn,
	getUsageWorkerHealth?: UsageWorkerHealthFn,
	getIntegrityStatus?: IntegrityStatusFn,
	getAccountUsageInfo: AccountUsageInfoFn = usageCacheUsageInfo,
) {
	const normalCache = new TtlCache<HealthResponse>(2000);
	const detailCache = new TtlCache<HealthResponse>(2000);

	return async (url: URL): Promise<Response> => {
		const withDetail =
			url.searchParams.get("detail") === "1" && config.getHealthDetailEnabled();
		const cache = withDetail ? detailCache : normalCache;
		const cached = cache.get();
		if (cached) {
			return jsonResponse(cached, toHttpStatus(cached.status));
		}

		const accounts = await dbOps.getAllAccounts();
		const now = Date.now();
		const pool = computePoolStatus(accounts, now, getAccountUsageInfo);

		// Call each health function once and store results
		const asyncWriterHealth = getAsyncWriterHealth
			? getAsyncWriterHealth()
			: null;
		const usageWorkerHealth = getUsageWorkerHealth
			? getUsageWorkerHealth()
			: null;

		// Determine runtime health from stored results
		const asyncWriterHealthy = asyncWriterHealth
			? asyncWriterHealth.healthy
			: true;
		const usageWorkerHealthy = usageWorkerHealth
			? usageWorkerHealth.state !== "error"
			: true;
		const runtimeHealthy = asyncWriterHealthy && usageWorkerHealthy;

		const status = computeHealthStatus(runtimeHealthy, pool);

		const response: HealthResponse = {
			status,
			accounts: pool.configured,
			timestamp: new Date().toISOString(),
			strategy: config.getStrategy(),
			pool,
		};

		// Build runtime section from stored results
		if (asyncWriterHealth && usageWorkerHealth) {
			response.runtime = {
				asyncWriter: asyncWriterHealth,
				usageWorker: usageWorkerHealth,
			};
		}

		// Add storage integrity independently — orthogonal to asyncWriter/usageWorker
		if (getIntegrityStatus) {
			if (!response.runtime) {
				response.runtime = {};
			}
			const integrity = getIntegrityStatus();
			response.runtime!.storage = {
				integrity: {
					status: integrity.status,
					runningKind: integrity.runningKind,
					lastCheckAt: integrity.lastCheckAt
						? new Date(integrity.lastCheckAt).toISOString()
						: null,
					lastError: integrity.lastError,
					lastQuickCheckAt: integrity.lastQuickCheckAt
						? new Date(integrity.lastQuickCheckAt).toISOString()
						: null,
					lastQuickResult: integrity.lastQuickResult,
					lastFullCheckAt: integrity.lastFullCheckAt
						? new Date(integrity.lastFullCheckAt).toISOString()
						: null,
					lastFullResult: integrity.lastFullResult,
				},
			};
		}

		// Support ?detail=1 for per-account details (requires HEALTH_DETAIL_ENABLED=true)
		if (withDetail) {
			response.accounts_detail = accounts.map((a) => ({
				name: a.name,
				status: a.paused
					? "paused"
					: a.rate_limited_until && a.rate_limited_until >= now
						? "rate_limited"
						: "available",
				rate_limited_until:
					!a.paused && a.rate_limited_until && a.rate_limited_until >= now
						? a.rate_limited_until
						: null,
				rate_limited_reason:
					!a.paused && a.rate_limited_until && a.rate_limited_until >= now
						? a.rate_limited_reason
						: null,
				rate_limited_at:
					!a.paused && a.rate_limited_until && a.rate_limited_until >= now
						? a.rate_limited_at
						: null,
			}));
		}

		cache.set(response);
		return jsonResponse(response, toHttpStatus(status));
	};
}
