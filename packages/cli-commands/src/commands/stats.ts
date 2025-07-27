import type { Database } from "bun:sqlite";

/**
 * Reset all account statistics
 */
export function resetAllStats(db: Database): void {
	db.run(
		"UPDATE accounts SET request_count = 0, session_start = NULL, session_request_count = 0",
	);
}

/**
 * Clear all request history
 */
export function clearRequestHistory(db: Database): { count: number } {
	const result = db.run("DELETE FROM requests");
	return { count: result.changes };
}
