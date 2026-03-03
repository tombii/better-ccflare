import type { DatabaseOperations } from "@better-ccflare/database";

/**
 * Reset all account statistics
 */
export async function resetAllStats(dbOps: DatabaseOperations): Promise<void> {
	const adapter = dbOps.getAdapter();
	await adapter.run(
		"UPDATE accounts SET request_count = 0, session_start = NULL, session_request_count = 0",
	);
}

/**
 * Clear all request history
 */
export async function clearRequestHistory(
	dbOps: DatabaseOperations,
): Promise<{ count: number }> {
	const adapter = dbOps.getAdapter();
	const changes = await adapter.runWithChanges("DELETE FROM requests");
	return { count: changes };
}
