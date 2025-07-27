import type { Database } from "bun:sqlite";
import type { StatsResponse } from "../types.js";

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
					AVG(response_time_ms) as avgResponseTime
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

		const response: StatsResponse = {
			totalRequests: stats?.totalRequests || 0,
			successRate,
			activeAccounts: accountCount?.count || 0,
			avgResponseTime: Math.round(stats?.avgResponseTime || 0),
		};

		return new Response(JSON.stringify(response), {
			headers: { "Content-Type": "application/json" },
		});
	};
}
