import { TIME_CONSTANTS } from "@better-ccflare/core";
import type { DatabaseOperations } from "@better-ccflare/database";
import { runIntegrityCheckInWorker } from "@better-ccflare/database";
import { Logger } from "@better-ccflare/logger";

/**
 * Periodic integrity scheduler. Two probes run on independent timers:
 *
 *  - **quick** (`PRAGMA quick_check`) every `CCFLARE_INTEGRITY_CHECK_INTERVAL`
 *    hours (default 6). Catches page-structure corruption and most
 *    freelist issues.
 *  - **full** (`PRAGMA integrity_check` + `PRAGMA foreign_key_check`) every
 *    `CCFLARE_FULL_INTEGRITY_CHECK_INTERVAL` hours (default 24). Catches
 *    the silent-wrong-results class that `quick_check` misses (index/table
 *    cross-checks, UNIQUE/CHECK, foreign-key violations).
 *
 * Both probes run in a dedicated `bun:sqlite` worker (see
 * `integrity-check-worker.ts`) when a SQLite path is available. `bun:sqlite`
 * is synchronous, so even `PRAGMA quick_check` on a multi-GB DB blocks the
 * JS event loop for tens of seconds (~30 s observed on a 7.6 GiB DB),
 * during which the proxy can't accept connections or flush in-flight
 * streaming responses — downstream sockets get reset and clients see
 * "socket connection was closed unexpectedly". For PostgreSQL or when no
 * SQLite path is resolvable, the probe falls back to a direct
 * `DatabaseOperations` call (lightweight on PG; this branch only exists for
 * the non-SQLite case).
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
/**
 * Above this DB size the full `PRAGMA integrity_check` can't finish inside the
 * worker timeout (a 27 GiB DB times out), so the scheduler skips it and runs a
 * `quick_check` instead. A timeout is NOT corruption — recording one as such
 * lights a false cross-dashboard "integrity check failed" banner. Override via
 * `CCFLARE_FULL_INTEGRITY_MAX_DB_BYTES` (0 = no limit / never skip).
 */
const DEFAULT_FULL_INTEGRITY_MAX_DB_BYTES = 16 * 1024 * 1024 * 1024; // 16 GiB
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

/**
 * Resolve the max DB size (bytes) above which the full integrity check is
 * skipped in favour of a quick check. Reads
 * `CCFLARE_FULL_INTEGRITY_MAX_DB_BYTES`: unset/empty → default; positive
 * integer → that value; `0` → no limit (never skip, returns +Infinity);
 * anything else → warn + default.
 */
function resolveMaxFullIntegrityBytes(logger: Logger): number {
	const raw = process.env.CCFLARE_FULL_INTEGRITY_MAX_DB_BYTES;
	if (raw === undefined || raw === "")
		return DEFAULT_FULL_INTEGRITY_MAX_DB_BYTES;
	const parsed = Number(raw);
	if (!Number.isInteger(parsed) || parsed < 0) {
		logger.warn(
			`Invalid CCFLARE_FULL_INTEGRITY_MAX_DB_BYTES="${raw}", using default ${DEFAULT_FULL_INTEGRITY_MAX_DB_BYTES}`,
		);
		return DEFAULT_FULL_INTEGRITY_MAX_DB_BYTES;
	}
	// 0 disables the size limit — the full check always runs.
	if (parsed === 0) return Number.POSITIVE_INFINITY;
	return parsed;
}

export function startIntegrityScheduler(
	dbOps: DatabaseOperations,
	overrides?: { quickIntervalHours?: number; fullIntervalHours?: number },
): () => void {
	const logger = new Logger("IntegrityScheduler");

	// Mirror the env-var convention in `parseIntervalEnv`: 0 disables the
	// probe. Without this branch, `overrides.quickIntervalHours = 0` would
	// multiply to 0ms and pass the `!== null` guard, scheduling
	// `setInterval(runQuick, 0)` — a tight loop hammering the DB every tick.
	const resolveOverrideOrEnv = (
		override: number | undefined,
		envVar: string,
		defaultHours: number,
	): number | null => {
		if (override === undefined) {
			return parseIntervalEnv(envVar, defaultHours, logger);
		}
		if (override === 0) return null;
		return override * TIME_CONSTANTS.HOUR;
	};

	const quickInterval = resolveOverrideOrEnv(
		overrides?.quickIntervalHours,
		"CCFLARE_INTEGRITY_CHECK_INTERVAL",
		DEFAULT_QUICK_INTERVAL_HOURS,
	);

	const fullInterval = resolveOverrideOrEnv(
		overrides?.fullIntervalHours,
		"CCFLARE_FULL_INTEGRITY_CHECK_INTERVAL",
		DEFAULT_FULL_INTERVAL_HOURS,
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
		logger.debug("Running quick integrity check...");
		const { result, error } = await runCheckLocked(dbOps, "quick");
		if (result === "ok") {
			logger.debug("Quick integrity check passed");
		} else {
			logger.error(`Quick integrity check FAILED: ${error}`);
			logger.error(
				"Database corruption detected. Run `bun run cli --doctor` for details.",
			);
		}
	};

	const runFull = async () => {
		if (!dbOps.markIntegrityCheckRunning("full")) {
			logger.debug("Skipping full check — another check is already running");
			return;
		}
		logger.info("Running full integrity check...");
		const { result, error, skipped } = await runCheckLocked(dbOps, "full");
		if (result === "ok") {
			if (skipped) {
				logger.info(
					"Full integrity check skipped (DB too large) — quick check passed",
				);
			} else {
				logger.info("Full integrity check passed");
			}
		} else {
			logger.error(`Full integrity check FAILED: ${error}`);
			logger.error(
				"Database corruption detected. Run `bun run cli --doctor` for details.",
			);
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
 * Run a check (`quick` or `full`) once the caller has already claimed the
 * mutex via `markIntegrityCheckRunning(kind)`. Routes through the
 * `integrity-check-worker` when a SQLite path is resolvable so the
 * (synchronous) `bun:sqlite` pragma doesn't freeze the proxy event loop;
 * falls back to `DatabaseOperations.run{Quick,Full}IntegrityCheck` for the
 * non-SQLite case (PostgreSQL, or any backend without a file path —
 * lightweight there, so blocking is fine).
 *
 * Records the result and (implicitly) releases the mutex via
 * `recordIntegrityResult` (or `recordIntegritySkipped` for size-threshold /
 * timeout skips).
 *
 * Skip semantics (neither is corruption, so both keep the dashboard healthy):
 *  - **Size threshold**: when a `full` check is requested but the DB is over
 *    `CCFLARE_FULL_INTEGRITY_MAX_DB_BYTES`, the full `integrity_check` can't
 *    finish inside the worker timeout, so we record the full probe as skipped
 *    and run a `quick_check` instead, recording ITS result normally.
 *  - **Worker timeout**: a `!ok && timedOut` worker result is a hung
 *    bun:sqlite call (failing disk / unresponsive NFS), not corruption — it is
 *    recorded as skipped, not corrupt.
 *
 * The return contract stays `{ result: "ok" | "corrupt"; error }`; a skip
 * returns `{ result: "ok", error: null }` because nothing is corrupt.
 */
async function runCheckLocked(
	dbOps: DatabaseOperations,
	kind: "quick" | "full",
): Promise<{ result: "ok" | "corrupt"; error: string | null; skipped?: true }> {
	const logger = new Logger("IntegrityScheduler");
	try {
		const dbPath = dbOps.getResolvedDbPath();
		if (!dbPath) {
			const out =
				kind === "quick"
					? await dbOps.runQuickIntegrityCheck()
					: await dbOps.runFullIntegrityCheck();
			const result = out === "ok" ? "ok" : "corrupt";
			dbOps.recordIntegrityResult(
				kind,
				result,
				result === "corrupt" ? out : null,
			);
			return { result, error: result === "corrupt" ? out : null };
		}

		// Full check on an oversized DB: skip integrity_check (it would time
		// out) and run quick_check instead, recording each probe separately.
		//
		// IMPORTANT: recordIntegritySkipped("full") is called AFTER the fallback
		// quick worker resolves, not before. Calling it early releases the mutex
		// (markIntegrityCheckRunning guards on status==="running", which
		// recordIntegritySkipped clears), allowing a concurrent periodic tick or
		// on-demand HTTP request to claim a second probe mid-flight.
		if (kind === "full") {
			const sizeBytes = await dbOps.getDbSizeBytes();
			const maxBytes = resolveMaxFullIntegrityBytes(logger);
			if (sizeBytes > maxBytes) {
				const reason = `full integrity_check skipped — DB is ${(
					sizeBytes / 1024 / 1024 / 1024
				).toFixed(1)} GB (> ${(maxBytes / 1024 / 1024 / 1024).toFixed(
					1,
				)} GB threshold, CCFLARE_FULL_INTEGRITY_MAX_DB_BYTES); ran quick_check instead`;
				logger.warn(reason);

				const quickResult = await runIntegrityCheckInWorker(dbPath, {
					kind: "quick",
				});
				// Record the full-skip only after the fallback worker is done so
				// the mutex stays held for the entire size-skip path.
				dbOps.recordIntegritySkipped("full", reason);
				if (quickResult.ok) {
					dbOps.recordIntegrityResult("quick", "ok");
					return { result: "ok", error: null, skipped: true };
				}
				if (quickResult.timedOut) {
					dbOps.recordIntegritySkipped("quick", quickResult.error);
					return { result: "ok", error: null, skipped: true };
				}
				dbOps.recordIntegrityResult("quick", "corrupt", quickResult.error);
				return { result: "corrupt", error: quickResult.error };
			}
		}

		const workerResult = await runIntegrityCheckInWorker(dbPath, { kind });
		if (workerResult.ok) {
			dbOps.recordIntegrityResult(kind, "ok");
			return { result: "ok", error: null };
		}
		// A worker timeout is a hung bun:sqlite call, not corruption — record
		// it as skipped so it doesn't light the false corruption banner.
		if (workerResult.timedOut) {
			dbOps.recordIntegritySkipped(kind, workerResult.error);
			return { result: "ok", error: null, skipped: true };
		}
		dbOps.recordIntegrityResult(kind, "corrupt", workerResult.error);
		return { result: "corrupt", error: workerResult.error };
	} catch (error) {
		const msg = String(error);
		dbOps.recordIntegrityResult(kind, "corrupt", msg);
		return { result: "corrupt", error: msg };
	}
}

/**
 * Trigger an on-demand integrity probe. Used by the
 * `POST /api/storage/integrity/check` endpoint. Returns
 * `{ ok: false, reason: "already-running" }` if the mutex is held.
 *
 * Both kinds are awaited end-to-end here. The full check can take up to
 * the worker timeout (10 min by default). For HTTP handlers that sit
 * behind a reverse proxy with a short read_timeout, use
 * {@link startFullIntegrityCheckBackground} for the full kind to return
 * 202 immediately.
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
	const { result, error } = await runCheckLocked(dbOps, kind);
	return { ok: true, result, error };
}

/**
 * Claim the mutex for a full integrity check and kick off the worker
 * **without awaiting**. Intended for HTTP handlers — returning 202
 * immediately means a reverse proxy (nginx, Caddy, ALB) with a short
 * `proxy_read_timeout` won't drop the connection before the worker
 * finishes, which would otherwise make the dashboard show a false-
 * negative "Could not trigger check" even though the check is in
 * progress and will land in `/api/storage` once the worker completes.
 *
 * Returns synchronously:
 *  - `{ok: true}` — mutex claimed, worker kicked off in background. The
 *    eventual result is visible via `/api/storage` and `/health` once
 *    `recordIntegrityResult` releases the mutex.
 *  - `{ok: false, reason: "already-running"}` — another probe is in
 *    flight; nothing was started.
 *
 * Errors inside the background coroutine are recorded as
 * `corrupt` with the message — same handling as the awaited path.
 */
export function startFullIntegrityCheckBackground(
	dbOps: DatabaseOperations,
): { ok: true } | { ok: false; reason: "already-running" } {
	if (!dbOps.markIntegrityCheckRunning("full")) {
		return { ok: false, reason: "already-running" };
	}
	// Fire-and-forget. `runCheckLocked` catches its own errors and
	// always calls `recordIntegrityResult` to release the mutex.
	void runCheckLocked(dbOps, "full");
	return { ok: true };
}
