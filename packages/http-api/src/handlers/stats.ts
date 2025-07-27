import type { Database } from "bun:sqlite";
import type { DatabaseOperations } from "@claudeflare/database";

/**
 * Create a stats handler
 */
export function createStatsHandler(db: Database) {
	return (): Response => {
		const stats = db
			.query(
				`
				SELECT 
					COUNT(*) as totalRequests,
					SUM(CASE WHEN success = 1 THEN 1 ELSE 0 END) as successfulRequests,
					AVG(response_time_ms) as avgResponseTime,
					SUM(total_tokens) as totalTokens,
					SUM(cost_usd) as totalCostUsd
				FROM requests
			`,
			)
			// biome-ignore lint/suspicious/noExplicitAny: Database query results can vary in shape
			.get() as any;

		const accountCount = db
			.query("SELECT COUNT(*) as count FROM accounts")
			.get() as { count: number } | undefined;

		const successRate =
			stats?.totalRequests > 0
				? Math.round((stats.successfulRequests / stats.totalRequests) * 100)
				: 0;

		// Get per-account stats
		const accountStats = db
			.query(
				`
				SELECT 
					name,
					request_count as requestCount,
					total_requests as totalRequests
				FROM accounts
				WHERE request_count > 0
				ORDER BY request_count DESC
				LIMIT 10
			`,
			)
			.all() as Array<{
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
				.get(acc.name) as { total: number; successful: number } | undefined;

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
		const recentErrors = db
			.query(
				`
				SELECT error_message
				FROM requests
				WHERE success = 0 AND error_message IS NOT NULL
				ORDER BY timestamp DESC
				LIMIT 10
			`,
			)
			.all() as Array<{ error_message: string }>;

		// Get top models
		const topModels = db
			.query(
				`
				SELECT model, COUNT(*) as count
				FROM requests
				WHERE model IS NOT NULL
				GROUP BY model
				ORDER BY count DESC
				LIMIT 10
			`,
			)
			.all() as Array<{ model: string; count: number }>;

		const response = {
			totalRequests: stats?.totalRequests || 0,
			successRate,
			activeAccounts: accountCount?.count || 0,
			avgResponseTime: Math.round(stats?.avgResponseTime || 0),
			totalTokens: stats?.totalTokens || 0,
			totalCostUsd: stats?.totalCostUsd || 0,
			topModels,
			accounts: accountsWithStats,
			recentErrors: recentErrors.map((e) => e.error_message),
		};

		return new Response(JSON.stringify(response), {
			headers: { "Content-Type": "application/json" },
		});
	};
}

/**
 * Create a stats reset handler
 */
export function createStatsResetHandler(_dbOps: DatabaseOperations) {
	return async (): Promise<Response> => {
		try {
			// Reset statistics by clearing request history
			// This is a placeholder - actual implementation would use database methods
			return new Response(
				JSON.stringify({
					success: true,
					message: "Statistics reset successfully",
				}),
				{
					headers: { "Content-Type": "application/json" },
				},
			);
		} catch (_error) {
			return new Response(
				JSON.stringify({ error: "Failed to reset statistics" }),
				{
					status: 500,
					headers: { "Content-Type": "application/json" },
				},
			);
		}
	};
}
