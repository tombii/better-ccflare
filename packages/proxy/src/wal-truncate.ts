import { registerCleanup } from "@better-ccflare/core";
import type { DatabaseOperations } from "@better-ccflare/database";
import {
	clampTimerIntervalMinutes,
	resolveWalTruncateIntervalMinutes,
} from "@better-ccflare/database";
import { Logger } from "@better-ccflare/logger";

/**
 * Keep the SQLite -wal file small.
 *
 * The existing 5-minute `wal_checkpoint(PASSIVE)` job (see `optimize()`)
 * copies frames back into the database but never shrinks the -wal file, so
 * after a burst of writes — or after a long-lived reader such as a scheduled
 * integrity check on a multi-GB DB kept the WAL from being reset — the file
 * stays at its high-water mark. `journal_size_limit` (set on the main
 * connection, `CCFLARE_WAL_SIZE_LIMIT_BYTES`) bounds what is left behind
 * whenever SQLite resets the WAL — it is not a hard cap, the file can still
 * grow past it while a reader pins the WAL. This job is what actually
 * shrinks the file: it runs `wal_checkpoint(TRUNCATE)` every
 * `CCFLARE_WAL_TRUNCATE_INTERVAL_MINUTES` minutes (default 10, `0`
 * disables) and once after each integrity check.
 *
 * The checkpoint itself runs in a worker thread (see
 * `DatabaseOperations.truncateWal()`), so a large WAL backlog never stalls
 * the proxy's event loop. A busy result only means another connection is
 * still using the WAL; it is logged at debug level and retried on the next
 * tick. Real failures (I/O error, disk full, worker crash) are logged at
 * error level. Nothing here throws.
 */

const logger = new Logger("WalTruncate");

/** Run one TRUNCATE checkpoint and log the outcome. */
export async function truncateWalQuietly(
	dbOps: DatabaseOperations,
	reason: string,
): Promise<void> {
	try {
		const result = await dbOps.truncateWal();
		if (!result) return;
		if (result.error) {
			// Lock contention is expected and harmless; anything else is a
			// real failure the operator needs to see.
			if (result.busy) {
				logger.debug(
					`WAL truncate (${reason}) skipped, database busy: ${result.error}`,
				);
			} else {
				logger.error(`WAL truncate (${reason}) failed: ${result.error}`);
			}
		} else if (result.busy) {
			logger.debug(
				`WAL truncate (${reason}) incomplete, database busy: ${result.checkpointed}/${result.log} frames checkpointed`,
			);
		} else if (result.log === -1) {
			// `wal_checkpoint` reports log = -1 when the database is not in WAL
			// mode — there is no -wal file to shrink.
			logger.debug(
				`WAL truncate (${reason}) skipped, database is not in WAL mode`,
			);
		} else {
			logger.debug(`WAL truncate (${reason}) done`);
		}
	} catch (error) {
		logger.error(
			`WAL truncate (${reason}) failed: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

/**
 * Checkpoint and truncate the WAL after an integrity check. The check's
 * worker holds a read snapshot for its whole run, which keeps the WAL from
 * being reset and lets it grow; trimming it right away gives the space back
 * without waiting for the next periodic tick.
 *
 * No-op when the WAL truncate feature is switched off
 * (`CCFLARE_WAL_TRUNCATE_INTERVAL_MINUTES=0`, which disables both this and
 * the periodic job) or not on SQLite.
 */
export async function truncateWalAfterIntegrityCheck(
	dbOps: DatabaseOperations,
): Promise<void> {
	if (!dbOps.isSQLite) return;
	if (resolveWalTruncateIntervalMinutes() === null) return;
	await truncateWalQuietly(dbOps, "after integrity check");
}

/**
 * Start the periodic TRUNCATE checkpoint. Returns a stop function; returns a
 * no-op when disabled or when the backend is not SQLite.
 *
 * The `intervalMinutes` override only controls this periodic job; the
 * post-integrity-check truncate is governed by
 * `CCFLARE_WAL_TRUNCATE_INTERVAL_MINUTES` (the env var an operator
 * actually sets).
 */
export function startWalTruncateJob(
	dbOps: DatabaseOperations,
	overrides?: { intervalMinutes?: number },
): () => void {
	if (!dbOps.isSQLite) return () => {};

	const intervalMinutes =
		overrides?.intervalMinutes !== undefined
			? overrides.intervalMinutes > 0
				? // A fractional interval would turn into a sub-minute
					// checkpoint loop; round down to whole minutes.
					clampTimerIntervalMinutes(
						Math.max(1, Math.floor(overrides.intervalMinutes)),
					)
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
		maxConcurrent: 1,
		description: "WAL checkpoint(TRUNCATE) to shrink the -wal file",
	});
}
