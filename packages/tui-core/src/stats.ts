import * as cliCommands from "@claudeflare/cli-commands";
import { DatabaseFactory } from "@claudeflare/database";

export interface Stats {
	totalRequests: number;
	successRate: number;
	activeAccounts: number;
	avgResponseTime: number;
	totalTokens: number;
	totalCostUsd: number;
	tokenDetails?: {
		inputTokens: number;
		cacheReadInputTokens: number;
		cacheCreationInputTokens: number;
		outputTokens: number;
	};
	accounts: Array<{
		name: string;
		requestCount: number;
		successRate: number;
	}>;
	recentErrors: string[];
}

export async function getStats(): Promise<Stats> {
	const dbOps = DatabaseFactory.getInstance();
	const db = dbOps.getDatabase();
	const requestRepository = dbOps.getRequestRepository();

	// Get overall statistics using the repository method
	const stats = requestRepository.aggregateStats();

	const accountCount = db
		.query("SELECT COUNT(*) as count FROM accounts")
		.get() as { count: number } | undefined;

	const successRate =
		stats && stats.totalRequests > 0
			? Math.round((stats.successfulRequests / stats.totalRequests) * 100)
			: 0;

	// Get per-account stats
	const accountStats = db
		.query(
			`
				SELECT 
					id,
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
	const recentErrors = requestRepository.getRecentErrors();

	return {
		totalRequests: stats.totalRequests,
		successRate,
		activeAccounts: accountCount?.count || 0,
		avgResponseTime: Math.round(stats.avgResponseTime || 0),
		totalTokens: stats.totalTokens,
		totalCostUsd: stats.totalCostUsd,
		tokenDetails:
			stats.inputTokens || stats.outputTokens
				? {
						inputTokens: stats.inputTokens,
						cacheReadInputTokens: stats.cacheReadInputTokens,
						cacheCreationInputTokens: stats.cacheCreationInputTokens,
						outputTokens: stats.outputTokens,
					}
				: undefined,
		accounts: accountsWithStats,
		recentErrors,
	};
}

export async function resetStats(): Promise<void> {
	const dbOps = DatabaseFactory.getInstance();
	const db = dbOps.getDatabase();
	// Clear request history
	db.run("DELETE FROM requests");
	// Reset account statistics
	db.run("UPDATE accounts SET request_count = 0, session_request_count = 0");
}

export async function clearHistory(): Promise<void> {
	const dbOps = DatabaseFactory.getInstance();
	const db = dbOps.getDatabase();
	db.run("DELETE FROM requests");
}

export async function analyzePerformance(): Promise<void> {
	const dbOps = DatabaseFactory.getInstance();
	const db = dbOps.getDatabase();
	cliCommands.analyzePerformance(db);
}
