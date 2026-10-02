import type { DatabaseOperations } from "@better-ccflare/database";
import { jsonResponse } from "@better-ccflare/http-common";
import { createTtlCache } from "../utils/ttl-cache";

const STATS_CACHE_TTL_MS = 10_000;

type StatsRepository = ReturnType<DatabaseOperations["getStatsRepository"]>;

interface StatsPayload {
	totalRequests: number;
	successRate: number;
	activeAccounts: number;
	avgResponseTime: number;
	totalTokens: number;
	totalCostUsd: number;
	topModels: Awaited<ReturnType<StatsRepository["getTopModels"]>>;
	avgTokensPerSecond: number | null | undefined;
	accounts: Awaited<ReturnType<StatsRepository["getAccountStats"]>>;
	recentErrors: Awaited<ReturnType<StatsRepository["getRecentErrorGroups"]>>;
}

/**
 * Create a stats handler
 */
export function createStatsHandler(dbOps: DatabaseOperations) {
	// Per-handler cache: short TTL + in-flight dedup so dashboard polling and
	// multiple tabs don't each re-run the aggregate queries.
	const cache = createTtlCache<StatsPayload>(STATS_CACHE_TTL_MS);

	return async (url: URL): Promise<Response> => {
		const statsRepository = dbOps.getStatsRepository();

		// Parse optional ?since=<days> query parameter (default: 30, max: 365)
		const sinceRaw = Number(url.searchParams.get("since") ?? 30);
		const sinceDays =
			Number.isFinite(sinceRaw) && sinceRaw > 0 ? Math.min(sinceRaw, 365) : 30;

		// Parse optional ?errorsSinceHours=<n> query parameter
		// (default: 24, max: 8760 hours = 365 days)
		const errorsHoursRaw = Number(
			url.searchParams.get("errorsSinceHours") ?? 24,
		);
		const errorsHours =
			Number.isFinite(errorsHoursRaw) && errorsHoursRaw > 0
				? Math.min(errorsHoursRaw, 8760)
				: 24;

		const response = await cache.get(
			`${sinceDays}:${errorsHours}`,
			async () => {
				const sinceMs = Date.now() - sinceDays * 24 * 60 * 60 * 1000;
				const errorsSinceMs = Date.now() - errorsHours * 60 * 60 * 1000;

				// The queries are independent, so run them concurrently
				const [
					stats,
					activeAccounts,
					accountsWithStats, // per-account stats (including unauthenticated requests)
					recentErrors,
					topModels,
				] = await Promise.all([
					statsRepository.getAggregatedStats(sinceMs),
					statsRepository.getActiveAccountCount(),
					statsRepository.getAccountStats(10, true, sinceMs),
					statsRepository.getRecentErrorGroups(errorsSinceMs, 50),
					statsRepository.getTopModels(5, sinceMs),
				]);

				const successRate =
					stats.totalRequests > 0
						? Math.round((stats.successfulRequests / stats.totalRequests) * 100)
						: 0;

				return {
					totalRequests: stats.totalRequests,
					successRate,
					activeAccounts,
					avgResponseTime: Math.round(stats.avgResponseTime || 0),
					totalTokens: stats.totalTokens,
					totalCostUsd: stats.totalCostUsd,
					topModels,
					avgTokensPerSecond: stats.avgTokensPerSecond,
					accounts: accountsWithStats,
					recentErrors,
				};
			},
		);

		return jsonResponse(response);
	};
}

/**
 * Create a stats reset handler
 */
export function createStatsResetHandler(dbOps: DatabaseOperations) {
	return async (): Promise<Response> => {
		const adapter = dbOps.getAdapter();
		// Clear request history
		await adapter.run("DELETE FROM requests");
		// Reset account statistics
		await adapter.run(
			"UPDATE accounts SET request_count = 0, session_request_count = 0",
		);

		return jsonResponse({
			success: true,
			message: "Statistics reset successfully",
		});
	};
}
