import type { DatabaseOperations } from "@better-ccflare/database";
import { jsonResponse } from "@better-ccflare/http-common";

/**
 * Create a stats handler
 */
export function createStatsHandler(dbOps: DatabaseOperations) {
	return (url: URL): Response => {
		const statsRepository = dbOps.getStatsRepository();

		// Parse optional ?since=<days> query parameter (default: 30, max: 365)
		const sinceRaw = Number(url.searchParams.get("since") ?? 30);
		const sinceDays =
			Number.isFinite(sinceRaw) && sinceRaw > 0 ? Math.min(sinceRaw, 365) : 30;
		const sinceMs = Date.now() - sinceDays * 24 * 60 * 60 * 1000;

		// Get overall statistics using the consolidated repository
		const stats = statsRepository.getAggregatedStats(sinceMs);
		const activeAccounts = statsRepository.getActiveAccountCount();

		const successRate =
			stats.totalRequests > 0
				? Math.round((stats.successfulRequests / stats.totalRequests) * 100)
				: 0;

		// Get per-account stats (including unauthenticated requests)
		const accountsWithStats = statsRepository.getAccountStats(10, true);

		// Get recent errors
		const recentErrors = statsRepository.getRecentErrors();

		// Get top models
		const topModels = statsRepository.getTopModels();

		const response = {
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

		return jsonResponse(response);
	};
}

/**
 * Create a stats reset handler
 */
export function createStatsResetHandler(dbOps: DatabaseOperations) {
	return async (): Promise<Response> => {
		const db = dbOps.getDatabase();
		// Clear request history
		db.run("DELETE FROM requests");
		// Reset account statistics
		db.run("UPDATE accounts SET request_count = 0, session_request_count = 0");

		return jsonResponse({
			success: true,
			message: "Statistics reset successfully",
		});
	};
}
