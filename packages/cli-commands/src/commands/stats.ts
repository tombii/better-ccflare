import { Database } from "bun:sqlite";
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

/**
 * Compact SQLite database (checkpoint + vacuum + WAL truncate).
 *
 * REFUSES if another process holds the writer lock — typically the running
 * better-ccflare server. Running compact concurrently with a live server
 * stalls every main-thread DB write in the server (rate-limit updates,
 * OAuth refresh, post-processor inserts) on SQLite's busy_timeout, which on
 * a multi-GB DB freezes the proxy for the entire VACUUM. See the design
 * note in `packages/database/src/database-operations.ts::incrementalVacuum`
 * for the full locking rationale.
 *
 * The probe opens a short-lived second handle and tries `BEGIN IMMEDIATE`
 * with a 1 s busy_timeout. If it can claim the writer slot the lock is
 * free and we proceed with the real compact; if not, we throw a clear
 * error pointing the operator at the right next step.
 */
export async function compactDatabase(dbOps: DatabaseOperations): Promise<{
	walBusy: number;
	walLog: number;
	walCheckpointed: number;
	vacuumed: boolean;
	walTruncateBusy?: number;
	error?: string;
}> {
	const dbPath = dbOps.getResolvedDbPath();
	if (dbPath) {
		const reason = checkWriterLockAvailable(dbPath);
		if (reason !== null) {
			throw new Error(
				`Refusing to compact: ${reason}. ` +
					`Stop the better-ccflare service first (e.g. \`systemctl stop better-ccflare\`) ` +
					`and re-run this command. Running compact while the server is live blocks ` +
					`every request the server tries to persist.`,
			);
		}
	}
	return dbOps.compact();
}

/**
 * Returns null if the writer lock can be claimed; otherwise a short reason
 * string (SQLITE_BUSY / unexpected error) suitable for surfacing to a CLI
 * user. The probe never actually mutates anything — it rolls back immediately.
 */
function checkWriterLockAvailable(dbPath: string): string | null {
	const probe = new Database(dbPath);
	try {
		probe.exec("PRAGMA busy_timeout = 1000");
		probe.exec("BEGIN IMMEDIATE");
		probe.exec("ROLLBACK");
		return null;
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		return msg.includes("SQLITE_BUSY") || msg.toLowerCase().includes("busy")
			? "another process holds the SQLite writer lock"
			: `lock probe failed (${msg})`;
	} finally {
		probe.close();
	}
}
