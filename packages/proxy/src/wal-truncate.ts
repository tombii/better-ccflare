import { registerCleanup } from "@better-ccflare/core";
import type { DatabaseOperations } from "@better-ccflare/database";
import { resolveWalTruncateIntervalMinutes } from "@better-ccflare/database";
import { Logger } from "@better-ccflare/logger";

/**
 * Keep the SQLite -wal file small.
 *
 * The existing 5-minute `wal_checkpoint(PASSIVE)` job (see `optimize()`)
 * copies frames back into the database but never shrinks the -wal file, so
 * after a burst of writes — or after a long-lived reader such as a scheduled
 * integrity check on a multi-GB DB kept the WAL from being reset — the file
 * stays at its high-water mark. `journal_size_limit` (set on the main
 * connection, `CCFLARE_WAL_SIZE_LIMIT_BYTES`) caps what is left behind when
 * the WAL is reset; this job additionally runs `wal_checkpoint(TRUNCATE)`
 * every `CCFLARE_WAL_TRUNCATE_INTERVAL_MINUTES` minutes (default 10, `0`
 * disables) and once after each integrity check.
 *
 * The checkpoint is non-blocking (`DatabaseOperations.truncateWal()` drops
 * `busy_timeout` to 0 for the call). A busy or locked result only means
 * another connection is still using the WAL; it is logged at debug level and
 * retried on the next tick. Nothing here throws.
 */

const logger = new Logger("WalTruncate");

/** Run one non-blocking TRUNCATE checkpoint and log the outcome. */
export function truncateWalQuietly(
	dbOps: DatabaseOperations,
	reason: string,
): void {
	try {
		const result = dbOps.truncateWal();
		if (!result) return;
		if (result.error) {
			logger.debug(
				`WAL truncate (${reason}) skipped, database busy: ${result.error}`,
			);
		} else if (result.busy) {
			logger.debug(
				`WAL truncate (${reason}) incomplete, database busy: ${result.checkpointed}/${result.log} frames checkpointed`,
			);
		} else {
			logger.debug(`WAL truncate (${reason}) done`);
		}
	} catch (error) {
		logger.debug(`WAL truncate (${reason}) failed: ${error}`);
	}
}

/**
 * Checkpoint and truncate the WAL after an integrity check. The check's
 * worker holds a read snapshot for its whole run, which keeps the WAL from
 * being reset and lets it grow; trimming it right away gives the space back
 * without waiting for the next periodic tick. No-op when the periodic job is
 * disabled (`CCFLARE_WAL_TRUNCATE_INTERVAL_MINUTES=0`) or not on SQLite.
 */
export function truncateWalAfterIntegrityCheck(
	dbOps: DatabaseOperations,
): void {
	if (!dbOps.isSQLite) return;
	if (resolveWalTruncateIntervalMinutes() === null) return;
	truncateWalQuietly(dbOps, "after integrity check");
}

/**
 * Start the periodic TRUNCATE checkpoint. Returns a stop function; returns a
 * no-op when disabled or when the backend is not SQLite.
 */
export function startWalTruncateJob(
	dbOps: DatabaseOperations,
	overrides?: { intervalMinutes?: number },
): () => void {
	if (!dbOps.isSQLite) return () => {};

	const intervalMinutes =
		overrides?.intervalMinutes !== undefined
			? overrides.intervalMinutes > 0
				? overrides.intervalMinutes
				: null
			: resolveWalTruncateIntervalMinutes();
	if (intervalMinutes === null) {
		logger.info(
			"Periodic WAL truncate disabled (CCFLARE_WAL_TRUNCATE_INTERVAL_MINUTES=0)",
		);
		return () => {};
	}

	return registerCleanup({
		id: "wal-truncate",
		callback: () => truncateWalQuietly(dbOps, "periodic"),
		minutes: intervalMinutes,
		description: "WAL checkpoint(TRUNCATE) to shrink the -wal file",
	});
}
