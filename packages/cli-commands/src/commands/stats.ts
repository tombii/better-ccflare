import type { Config } from "@better-ccflare/config";
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
 * Clear request history using the configured retention windows.
 * Pass 1: delete payloads older than payloadDays.
 * Pass 2: delete request metadata older than requestDays.
 */
export async function clearRequestHistory(
	dbOps: DatabaseOperations,
	config: Config,
): Promise<{ removedRequests: number; removedPayloads: number }> {
	const payloadMs = config.getDataRetentionDays() * 24 * 60 * 60 * 1000;
	const requestMs = config.getRequestRetentionDays() * 24 * 60 * 60 * 1000;
	return dbOps.cleanupOldRequests(payloadMs, requestMs);
}
