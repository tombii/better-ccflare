import type { Database } from "bun:sqlite";
import type { RequestResponse } from "../types.js";

/**
 * Create a requests handler
 */
export function createRequestsHandler(db: Database) {
	return (limit: number = 50): Response => {
		const requests = db
			.query(
				`
				SELECT r.*, a.name as account_name
				FROM requests r
				LEFT JOIN accounts a ON r.account_used = a.id
				ORDER BY r.timestamp DESC
				LIMIT ?1
			`,
			)
			.all(limit) as Array<{
			id: string;
			timestamp: number;
			method: string;
			path: string;
			account_used: string | null;
			account_name: string | null;
			status_code: number | null;
			success: 0 | 1;
			error_message: string | null;
			response_time_ms: number | null;
			failover_attempts: number;
		}>;

		const response: RequestResponse[] = requests.map((request) => ({
			id: request.id,
			timestamp: new Date(request.timestamp).toISOString(),
			method: request.method,
			path: request.path,
			accountUsed: request.account_name || request.account_used,
			statusCode: request.status_code,
			success: request.success === 1,
			errorMessage: request.error_message,
			responseTimeMs: request.response_time_ms,
			failoverAttempts: request.failover_attempts,
		}));

		return new Response(JSON.stringify(response), {
			headers: { "Content-Type": "application/json" },
		});
	};
}
