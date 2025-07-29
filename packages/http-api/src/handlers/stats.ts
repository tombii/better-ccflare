import { NO_ACCOUNT_ID } from "@claudeflare/types";
import type { DatabaseOperations } from "@claudeflare/database";
import { jsonResponse } from "@claudeflare/http-common";

/**
 * Create a stats handler
 */
export function createStatsHandler(dbOps: DatabaseOperations) {
	return (): Response => {
		const stats = dbOps.aggregateStats();

		const db = dbOps.getDatabase();
		const accountCount = db
			.query("SELECT COUNT(*) as count FROM accounts")
			.get() as { count: number } | undefined;

		const successRate =
			stats.totalRequests > 0
				? Math.round((stats.successfulRequests / stats.totalRequests) * 100)
				: 0;

		// Get per-account stats (including unauthenticated requests)
		const accountStats = db
			.query(
				`
				WITH account_requests AS (
					SELECT 
						COALESCE(a.id, ?) as id,
						COALESCE(a.name, ?) as name,
						COUNT(r.id) as requestCount,
						COUNT(r.id) as totalRequests
					FROM requests r
					LEFT JOIN accounts a ON a.id = r.account_used
					GROUP BY COALESCE(a.id, ?), COALESCE(a.name, ?)
					HAVING requestCount > 0
				)
				SELECT * FROM account_requests
				ORDER BY requestCount DESC
				LIMIT 10
			`,
			)
			.all(
				NO_ACCOUNT_ID,
				NO_ACCOUNT_ID,
				NO_ACCOUNT_ID,
				NO_ACCOUNT_ID,
			) as Array<{
			id: string;
			name: string;
			requestCount: number;
			totalRequests: number;
		}>;

		// Calculate success rate per account
		const accountsWithStats = accountStats.map((acc) => {
			const accRequests = db
				.query(
					`
					SELECT 
						COUNT(*) as total,
						SUM(CASE WHEN success = 1 THEN 1 ELSE 0 END) as successful
					FROM requests
					WHERE account_used = ?
				`,
				)
				.get(acc.id) as { total: number; successful: number } | undefined;

			const accSuccessRate =
				accRequests && accRequests.total > 0
					? Math.round((accRequests.successful / accRequests.total) * 100)
					: 0;

			return {
				name: acc.name,
				requestCount: acc.requestCount,
				successRate: accSuccessRate,
			};
		});

		// Get recent errors
		const recentErrors = dbOps.getRecentErrors();

		// Get top models
		const topModels = dbOps.getTopModels();

		const response = {
			totalRequests: stats.totalRequests,
			successRate,
			activeAccounts: accountCount?.count || 0,
			avgResponseTime: Math.round(stats.avgResponseTime || 0),
			totalTokens: stats.totalTokens,
			totalCostUsd: stats.totalCostUsd,
			topModels,
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
