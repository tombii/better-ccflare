import { TIME_CONSTANTS } from "@better-ccflare/core";
import type { DatabaseOperations } from "@better-ccflare/database";
import { runIntegrityCheckInWorker } from "@better-ccflare/database";
import { Logger } from "@better-ccflare/logger";

/**
 * Periodic integrity scheduler. Two probes run on independent timers:
 *
 *  - **quick** (`PRAGMA quick_check`) every `CCFLARE_INTEGRITY_CHECK_INTERVAL`
 *    hours (default 6). Fast enough to run on the main thread; catches
 *    page-structure corruption and most freelist issues.
 *  - **full** (`PRAGMA integrity_check` + `PRAGMA foreign_key_check`) every
 *    `CCFLARE_FULL_INTEGRITY_CHECK_INTERVAL` hours (default 24). On
 *    multi-GB databases this takes tens of seconds, so it runs in a
 *    dedicated `bun:sqlite` worker (see `integrity-check-worker.ts`) so the
 *    proxy event loop isn't blocked. Catches the silent-wrong-results class
 *    that `quick_check` misses (index/table cross-checks, UNIQUE/CHECK,
 *    foreign-key violations).
 *
 * Mutex: only one probe runs at a time. If a probe is in flight, the next
 * tick logs and skips rather than queueing — checks are idempotent reads,
 * so dropping a tick is harmless.
 *
 * Setting either env var to `0` disables that probe; the corresponding
 * status field stays at its last value (or `null` if never run).
 */

const DEFAULT_QUICK_INTERVAL_HOURS = 6;
const DEFAULT_FULL_INTERVAL_HOURS = 24;
const QUICK_INITIAL_DELAY_MS = 30 * TIME_CONSTANTS.SECOND;
/** Delay full check past startup spike of disk I/O (dashboard build, schema
 *  migrations, performance index creation) so it doesn't compound with
 *  startup latency. */
const FULL_INITIAL_DELAY_MS = 30 * TIME_CONSTANTS.MINUTE;

function parseIntervalEnv(
	envVar: string,
	defaultHours: number,
	logger: Logger,
): number | null {
	const raw = process.env[envVar];
	if (raw === undefined || raw === "") {
		return defaultHours * TIME_CONSTANTS.HOUR;
	}
	const parsed = Number(raw);
	if (!Number.isInteger(parsed) || parsed < 0) {
		logger.warn(`Invalid ${envVar}="${raw}", using default ${defaultHours}h`);
		return defaultHours * TIME_CONSTANTS.HOUR;
	}
	if (parsed === 0) return null;
	return parsed * TIME_CONSTANTS.HOUR;
}

export function startIntegrityScheduler(
	dbOps: DatabaseOperations,
	overrides?: { quickIntervalHours?: number; fullIntervalHours?: number },
): () => void {
	const logger = new Logger("IntegrityScheduler");

	const quickInterval =
		overrides?.quickIntervalHours !== undefined
			? overrides.quickIntervalHours * TIME_CONSTANTS.HOUR
			: parseIntervalEnv(
					"CCFLARE_INTEGRITY_CHECK_INTERVAL",
					DEFAULT_QUICK_INTERVAL_HOURS,
					logger,
				);

	const fullInterval =
		overrides?.fullIntervalHours !== undefined
			? overrides.fullIntervalHours * TIME_CONSTANTS.HOUR
			: parseIntervalEnv(
					"CCFLARE_FULL_INTEGRITY_CHECK_INTERVAL",
					DEFAULT_FULL_INTERVAL_HOURS,
					logger,
				);

	if (quickInterval === null && fullInterval === null) {
		logger.info("Integrity scheduler fully disabled by env");
		return () => {};
	}

	const runQuick = async () => {
		if (!dbOps.markIntegrityCheckRunning("quick")) {
			logger.debug("Skipping quick check — another check is already running");
			return;
		}
		try {
			logger.debug("Running quick integrity check...");
			const result = await dbOps.runQuickIntegrityCheck();
			if (result === "ok") {
				dbOps.recordIntegrityResult("quick", "ok");
				logger.debug("Quick integrity check passed");
			} else {
				dbOps.recordIntegrityResult("quick", "corrupt", result);
				logger.error(`Quick integrity check FAILED: ${result}`);
				logger.error(
					"Database corruption detected. Run `bun run cli --doctor` for details.",
				);
			}
		} catch (error) {
			logger.error(`Quick integrity check error: ${error}`);
			dbOps.recordIntegrityResult("quick", "corrupt", String(error));
		}
	};

	const runFull = async () => {
		if (!dbOps.markIntegrityCheckRunning("full")) {
			logger.debug("Skipping full check — another check is already running");
			return;
		}
		const dbPath = dbOps.getResolvedDbPath();
		if (!dbPath) {
			// PostgreSQL or otherwise no SQLite file. Use the inline full-check
			// method which is fast in that mode (just a SELECT 1).
			try {
				const result = await dbOps.runFullIntegrityCheck();
				dbOps.recordIntegrityResult(
					"full",
					result === "ok" ? "ok" : "corrupt",
					result === "ok" ? null : result,
				);
			} catch (error) {
				dbOps.recordIntegrityResult("full", "corrupt", String(error));
			}
			return;
		}
		try {
			logger.info("Running full integrity check (in worker)...");
			const result = await runIntegrityCheckInWorker(dbPath);
			if (result.ok) {
				dbOps.recordIntegrityResult("full", "ok");
				logger.info("Full integrity check passed");
			} else {
				dbOps.recordIntegrityResult("full", "corrupt", result.error);
				logger.error(`Full integrity check FAILED: ${result.error}`);
				logger.error(
					"Database corruption detected. Run `bun run cli --doctor` for details.",
				);
			}
		} catch (error) {
			logger.error(`Full integrity check error: ${error}`);
			dbOps.recordIntegrityResult("full", "corrupt", String(error));
		}
	};

	const handles: ReturnType<typeof setTimeout>[] = [];
	const intervals: ReturnType<typeof setInterval>[] = [];

	if (quickInterval !== null) {
		handles.push(setTimeout(runQuick, QUICK_INITIAL_DELAY_MS));
		intervals.push(setInterval(runQuick, quickInterval));
	} else {
		logger.info(
			"Quick integrity check disabled (CCFLARE_INTEGRITY_CHECK_INTERVAL=0)",
		);
	}

	if (fullInterval !== null) {
		handles.push(setTimeout(runFull, FULL_INITIAL_DELAY_MS));
		intervals.push(setInterval(runFull, fullInterval));
	} else {
		logger.info(
			"Full integrity check disabled (CCFLARE_FULL_INTEGRITY_CHECK_INTERVAL=0)",
		);
	}

	return () => {
		for (const h of handles) clearTimeout(h);
		for (const i of intervals) clearInterval(i);
		logger.info("Integrity scheduler stopped");
	};
}

/**
 * Trigger an on-demand integrity probe. Used by the
 * `POST /api/storage/integrity/check` endpoint. Returns
 * `{ ok: false, reason: "already-running" }` if the mutex is held.
 */
export async function runIntegrityCheckOnDemand(
	dbOps: DatabaseOperations,
	kind: "quick" | "full",
): Promise<
	| { ok: true; result: "ok" | "corrupt"; error: string | null }
	| { ok: false; reason: "already-running" }
> {
	if (!dbOps.markIntegrityCheckRunning(kind)) {
		return { ok: false, reason: "already-running" };
	}
	try {
		if (kind === "quick") {
			const out = await dbOps.runQuickIntegrityCheck();
			const result = out === "ok" ? "ok" : "corrupt";
			dbOps.recordIntegrityResult(
				"quick",
				result,
				result === "corrupt" ? out : null,
			);
			return { ok: true, result, error: result === "corrupt" ? out : null };
		}
		const dbPath = dbOps.getResolvedDbPath();
		if (!dbPath) {
			const out = await dbOps.runFullIntegrityCheck();
			const result = out === "ok" ? "ok" : "corrupt";
			dbOps.recordIntegrityResult(
				"full",
				result,
				result === "corrupt" ? out : null,
			);
			return { ok: true, result, error: result === "corrupt" ? out : null };
		}
		const workerResult = await runIntegrityCheckInWorker(dbPath);
		const result = workerResult.ok ? "ok" : "corrupt";
		dbOps.recordIntegrityResult(
			"full",
			result,
			workerResult.ok ? null : workerResult.error,
		);
		return {
			ok: true,
			result,
			error: workerResult.ok ? null : workerResult.error,
		};
	} catch (error) {
		dbOps.recordIntegrityResult(kind, "corrupt", String(error));
		return { ok: true, result: "corrupt", error: String(error) };
	}
}
