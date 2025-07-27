import { DatabaseOperations } from "@claudeflare/database";

export interface Stats {
	totalRequests: number;
	successRate: number;
	activeAccounts: number;
	accounts: Array<{
		name: string;
		requestCount: number;
		successRate: number;
	}>;
	recentErrors: string[];
}

export async function getStats(): Promise<Stats> {
	const dbOps = new DatabaseOperations();
	const db = dbOps.getDatabase();

	try {
		// Get overall statistics
		const stats = db
			.query(
				`
				SELECT 
					COUNT(*) as totalRequests,
					SUM(CASE WHEN success = 1 THEN 1 ELSE 0 END) as successfulRequests
				FROM requests
			`,
			)
			.get() as
			| { totalRequests: number; successfulRequests: number }
			| undefined;

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

		return {
			totalRequests: stats?.totalRequests || 0,
			successRate,
			activeAccounts: accountCount?.count || 0,
			accounts: accountsWithStats,
			recentErrors: recentErrors.map((e) => e.error_message),
		};
	} finally {
		dbOps.close();
	}
}

export async function resetStats(): Promise<void> {
	const dbOps = new DatabaseOperations();
	const db = dbOps.getDatabase();

	try {
		// Clear request history
		db.run("DELETE FROM requests");
		// Reset account statistics
		db.run("UPDATE accounts SET request_count = 0, session_request_count = 0");
	} finally {
		dbOps.close();
	}
}

export async function clearHistory(): Promise<void> {
	const dbOps = new DatabaseOperations();
	const db = dbOps.getDatabase();

	try {
		db.run("DELETE FROM requests");
	} finally {
		dbOps.close();
	}
}
