/**
 * The unattended SQLite incremental-vacuum backstop's scheduling policy —
 * extracted (internal-5) from closures that used to live inline in
 * startServer(). Before this extraction, `runVacuumTick()` and
 * `vacuumCatchUp()` were unreachable for both tests and static reference
 * tooling: a later refactor could drop the catch-up tick's smaller
 * `maxPagesPerTick` cap, or remove the shared in-flight guard, and the full
 * test suite would stay green because nothing imported the closures. This
 * module makes the two invariants commit `bcc5f450` introduced —
 * "at most one reclaim runs at a time regardless of which tick started it"
 * and "the catch-up tick's own, smaller per-tick ceiling" — directly
 * testable with fakes instead of a real DB, worker, or async writer.
 *
 * `createVacuumScheduler()` returns `{ runHourlyTick, runCatchUpTick, state }`;
 * `apps/server/src/server.ts` wires the two IntervalManager registrations
 * (and their shutdown cleanup) to the returned functions but does not
 * duplicate any of the policy itself.
 */
import type { Config } from "@better-ccflare/config";
import type { DatabaseOperations } from "@better-ccflare/database";
import type { Logger } from "@better-ccflare/logger";

/**
 * Narrow surface this module needs from `DatabaseOperations`, kept to a
 * `Pick` so tests can pass a fully-typed fake without implementing the
 * whole class.
 */
export type VacuumSchedulerDbOps = Pick<
	DatabaseOperations,
	| "incrementalVacuumAdaptive"
	| "getFreelistCount"
	| "getPageCount"
	| "recordVacuumCatchUpBusySkip"
	| "resetVacuumCatchUpBusySkips"
>;

/** Narrow surface this module needs from `Config`. */
export type VacuumSchedulerConfig = Pick<Config, "getAutoVacuumEnabled">;

/** Narrow surface this module needs from `AsyncDbWriter`. */
export interface VacuumSchedulerAsyncWriter {
	getHealth(): { queuedJobs: number };
}

/**
 * Freelist-ratio threshold that triggers a catch-up incremental-vacuum tick
 * between the hourly retention-driven ones (see `shouldRunVacuumCatchUp`
 * below). A healthy, actively-reclaiming SQLite file sits near 0% free most
 * of the time; 10% is comfortably above ordinary delete/insert-burst noise
 * while catching a growing backlog long before it reaches the 47.5%-free and
 * 83%-free levels observed on one production instance once the hourly-only
 * ceiling could no longer keep up with the delete rate.
 */
export const VACUUM_CATCHUP_FREELIST_RATIO_THRESHOLD = 0.1;

/**
 * Per-tick reclaim ceiling for the catch-up path, deliberately smaller than
 * the hourly tick's ~1 GiB default (`incrementalVacuumAdaptive`'s
 * `maxPagesPerTick`): at the 5-minute cadence this job runs on, 65536 pages
 * (~256 MiB) yields up to ~3 GiB/h of *additional* reclaim capacity on top
 * of the hourly tick's ~1 GiB/h, for a combined ceiling of up to ~4 GiB/h —
 * comfortably above the ~2.2 GiB/h payload-delete rate observed in the
 * incident this backstop responds to, while keeping any single tick's chunk
 * count (and therefore its writer-slot hold time) below the hourly tick's.
 */
export const VACUUM_CATCHUP_MAX_PAGES_PER_TICK = 65536;

/**
 * Per-tick reclaim ceiling passed explicitly by the hourly retention tick.
 * Equal to `incrementalVacuumAdaptive()`'s own default (~1 GiB at 4 KiB
 * pages), but passed as an explicit literal here — rather than relying on
 * the callee's default — so a test can pin it directly (internal-5,
 * scenario: a later refactor drops this from the call and every 5-minute
 * catch-up tick would otherwise silently start running with the hourly
 * ceiling instead of its own smaller one).
 */
export const VACUUM_HOURLY_MAX_PAGES_PER_TICK = 262144;

/**
 * Decides whether the 5-minute vacuum catch-up tick should run this round.
 * Pure and side-effect-free so it can be unit tested without a real DB or
 * async writer; `createVacuumScheduler()` wires it to live reads of
 * `config.getAutoVacuumEnabled()`, `dbOps.getFreelistCount()` /
 * `getPageCount()`, and `asyncWriter.getHealth().queuedJobs`.
 *
 * Order matters for cost, not correctness: the operator switch and the
 * writer-backlog check are both free (memory reads), so they run before the
 * pragma-backed freelist ratio.
 *
 * The backpressure check reuses `queuedJobs > 0` — the exact bar
 * `AsyncDbWriter`'s own health-interval log already treats as "worth
 * flagging" (packages/database/src/async-writer.ts) — rather than a new
 * threshold: if the writer has not fully drained its own 100ms tick, this
 * is not the moment to add another write-lock contender. A byte range or
 * per-account project name is out of scope; this pacing gate only
 * ever affects internal maintenance work, not client-visible routing.
 */
/**
 * Pure freelist-ratio check, factored out of `shouldRunVacuumCatchUp` so the
 * catch-up tick's busy-skip telemetry below can reuse the exact same
 * threshold logic WITHOUT the queue-idle gate `shouldRunVacuumCatchUp` also
 * applies (greptile review on PR #475): the busy-skip counter must fire only
 * when the writer queue is the thing that blocked a catch-up that would
 * otherwise have qualified on the ratio alone, never when the ratio itself
 * was already below threshold (see the busy-skip comment in `runCatchUpTick`
 * for why counting the latter is a false starvation signal).
 */
function freelistRatioAtOrAboveThreshold(input: {
	freelistPages: number;
	pageCount: number;
	ratioThreshold?: number;
}): boolean {
	if (input.pageCount <= 0) return false;
	const ratio = input.freelistPages / input.pageCount;
	return (
		ratio >= (input.ratioThreshold ?? VACUUM_CATCHUP_FREELIST_RATIO_THRESHOLD)
	);
}

export function shouldRunVacuumCatchUp(input: {
	autoVacuumEnabled: boolean;
	asyncWriterQueuedJobs: number;
	freelistPages: number;
	pageCount: number;
	ratioThreshold?: number;
}): boolean {
	if (!input.autoVacuumEnabled) return false;
	if (input.asyncWriterQueuedJobs > 0) return false;
	return freelistRatioAtOrAboveThreshold(input);
}

/**
 * Consecutive catch-up busy-skip count at which the tick escalates to a
 * `warn` log, and every further multiple of it (internal-2): 12 ticks at
 * the 5-minute cadence is 1 hour of the catch-up tick being unable to get a
 * turn because the async writer's queue never drained — long enough that an
 * operator should know reclaim may be falling behind, short enough not to
 * spam logs on an ordinary few-minute contention burst.
 */
const VACUUM_CATCHUP_BUSY_SKIP_WARN_EVERY = 12;

/**
 * Self-heal ceiling for the shared `vacuumTickInFlight` flag (internal-3,
 * revised for internal-breadth-1, then for fix-loop-3): if a tick still
 * finds it set after this long, a prior reclaim promise almost certainly
 * never settled (e.g. the worker died without firing `onmessage` or
 * `onerror`) — or is still genuinely running under sustained writer
 * contention. Past this ceiling, `runVacuumTick` no longer tries to take
 * over and dispatch a second reclaim (see its stale branch below for why
 * that was removed); it only warns and skips.
 * Derivation: each chunk of the hourly tick's reclaim is individually bounded
 * by `incrementalVacuum()`'s own 120s per-chunk worker timeout
 * (`INC_VACUUM_WORKER_TIMEOUT_MS` in database-operations.ts), and the hourly
 * tick issues at most 16 chunks (`VACUUM_HOURLY_MAX_PAGES_PER_TICK` /
 * `CHUNK` = 262144 / 16384) — so a healthy tick, even one whose every single
 * chunk is merely slow (approaching, but never exceeding, the 120s per-chunk
 * timeout), cannot legitimately run longer than 120s * 16 = 32 minutes. A
 * chunk that actually TIMES OUT is a different, faster-ending case, not a
 * slower one: `incrementalVacuumAdaptive()` throws immediately on the first
 * chunk's rejection instead of retrying it (database-operations.ts), which
 * aborts that dispatch's whole reclaim loop right away and — once the
 * rejection reaches `runVacuumTick`'s `.catch()`/`.finally()` below —
 * releases the shared flag with it, so a timed-out chunk ends a dispatch
 * well under the 32-minute bound, never past it. This ceiling is
 * deliberately set to well over 2x that 32-minute healthy-tick bound (65
 * minutes) so a merely slow-but-healthy tick can never trigger a false
 * stale-guard warning, while a genuinely wedged flag is still caught well
 * under two hours instead of silently disabling both reclaim ticks
 * indefinitely without ever telling an operator why.
 */
export const VACUUM_TICK_STALE_GUARD_MS = 65 * 60 * 1000;

export interface VacuumSchedulerState {
	vacuumTickInFlight: boolean;
	/** epoch ms (per the injected `now`) when the flag was last set; null while not in flight. */
	vacuumTickInFlightSince: number | null;
	/**
	 * Monotonically increasing dispatch identity (internal-breadth-1). Every
	 * call to `runVacuumTick()` that actually dispatches mints a new token by
	 * incrementing this counter and captures it in its own `.finally()`
	 * closure, which only clears `vacuumTickInFlight` /
	 * `vacuumTickInFlightSince` when this field still equals the token it
	 * captured. Originally added to guard against a stale dispatch's belated
	 * settlement clobbering a *newer* dispatch's state after a self-heal
	 * takeover; fix-loop-3 removed the takeover path itself (see the
	 * stale-guard comment above `VACUUM_TICK_STALE_GUARD_MS` and the
	 * warn-only stale branch in `runVacuumTick` below), so with only ever one
	 * dispatch outstanding at a time this comparison can no longer actually
	 * diverge in practice — kept as the cheap, already-correct
	 * defense-in-depth it always was (c259ac83) rather than stripped along
	 * with the takeover it used to protect against. 0 before the first
	 * dispatch ever runs; tokens are minted starting at 1.
	 */
	vacuumTickToken: number;
	/**
	 * Count of times the self-heal ceiling has logged a stale-in-flight
	 * warning (fix-loop-3; renamed from `staleTakeovers` — this guard no
	 * longer dispatches a takeover reclaim, only warns and skips, see
	 * `runVacuumTick`'s stale branch). Incremented only on an actual warn
	 * emission, not on every stale tick: `lastStaleWarnAt` below rate-limits
	 * the warn itself to at most once per `VACUUM_TICK_STALE_GUARD_MS` per
	 * stuck dispatch, so a process stuck past the ceiling for hours logs
	 * roughly once per ~65 minutes instead of once per 5-minute catch-up
	 * tick. Exposed for tests/observability; not plumbed into `VacuumStatus`
	 * (packages/types/src/stats.ts) — that struct is populated by
	 * `database-operations.ts`'s `recordVacuumStatus()`, which this
	 * scheduler module has no handle on (its `VacuumSchedulerDbOps` surface
	 * is deliberately narrow), so wiring it through would touch files
	 * outside this fix's scope.
	 */
	staleWarnings: number;
	/**
	 * epoch ms (per the injected `now`) of the last stale-guard warning log;
	 * null before the first one. Rate-limits `runVacuumTick`'s stale branch
	 * to at most one warn per `VACUUM_TICK_STALE_GUARD_MS` per stuck
	 * dispatch (fix-loop-3), so a wedged flag that persists across many
	 * 5-minute catch-up ticks doesn't spam a warning every 5 minutes.
	 */
	lastStaleWarnAt: number | null;
}

export interface VacuumSchedulerDeps {
	dbOps: VacuumSchedulerDbOps;
	config: VacuumSchedulerConfig;
	asyncWriter: VacuumSchedulerAsyncWriter;
	log: Logger;
	/** Injectable clock for the stale-guard test; defaults to `Date.now`. */
	now?: () => number;
}

export interface VacuumScheduler {
	/** The hourly retention-driven tick. Registered on the `data-retention-cleanup` interval. */
	runHourlyTick: () => void;
	/** The 5-minute catch-up tick. Registered on its own `vacuum-catchup` interval. */
	runCatchUpTick: () => Promise<void>;
	/** Exposed for tests only; server.ts does not read this directly. */
	state: VacuumSchedulerState;
}

/**
 * Builds the vacuum scheduler: the shared in-flight guard, the hourly tick,
 * and the catch-up tick. See the module doc comment for why this is a
 * standalone, dependency-injected unit rather than closures inside
 * `startServer()`.
 */
export function createVacuumScheduler(
	deps: VacuumSchedulerDeps,
): VacuumScheduler {
	const { dbOps, config, asyncWriter, log } = deps;
	const now = deps.now ?? Date.now;

	// The hourly retention tick and the 5-minute vacuum catch-up tick both
	// fire incrementalVacuumAdaptive() and are each fire-and-forget from
	// their own IntervalManager callback — so neither interval's own
	// `maxConcurrent: 1` guard (which only tracks the awaited callback, not
	// this dangling promise) sees the other one, or even a still-running
	// invocation of itself if a reclaim ever outlives its tick. This single
	// shared flag serializes every call through runVacuumTick() below,
	// regardless of which tick started it — without it, two concurrent
	// reclaim loops could each hold SQLite's single writer slot in their own
	// worker call, doubling exactly the contention this backstop exists to
	// bound.
	const state: VacuumSchedulerState = {
		vacuumTickInFlight: false,
		vacuumTickInFlightSince: null,
		vacuumTickToken: 0,
		staleWarnings: 0,
		lastStaleWarnAt: null,
	};

	const runVacuumTick = (
		opts: Parameters<VacuumSchedulerDbOps["incrementalVacuumAdaptive"]>[0],
		source: "retention" | "catchup",
	): void => {
		if (state.vacuumTickInFlight) {
			const age =
				state.vacuumTickInFlightSince !== null
					? now() - state.vacuumTickInFlightSince
					: 0;
			if (age < VACUUM_TICK_STALE_GUARD_MS) {
				log.debug(
					`Vacuum tick (${source}) skipped — another vacuum tick is still in flight`,
				);
				return;
			}
			// fix-loop-3: WARN-ONLY, never dispatch a takeover. This branch used
			// to mint a fresh token and dispatch a second
			// `incrementalVacuumAdaptive()` call here (internal-3 /
			// internal-breadth-1) once the flag looked stuck. Since 93daf88b
			// every worker call inside `incrementalVacuum()` is bounded by
			// `INC_VACUUM_WORKER_TIMEOUT_MS` (120s), and that timeout's
			// rejection propagates through `incrementalVacuumAdaptive()` to this
			// dispatch's own `.finally()` below — so a hung worker can no longer
			// latch this flag forever the way the old takeover was built to
			// route around: a healthy reclaim is bounded by 16 chunks * 120s ~=
			// 32 minutes (see `VACUUM_TICK_STALE_GUARD_MS`'s derivation comment
			// above), well under this 65-minute ceiling. A takeover that
			// dispatches while the old call may still be genuinely running (just
			// slow under contention, not hung) would put two reclaim loops on
			// SQLite's single writer slot at once — the exact condition this
			// shared flag exists to prevent (see the top-of-file comment) — and
			// nothing at the `DatabaseOperations` layer serializes them (no
			// mutex around `incrementalVacuumAdaptive()` / `incrementalVacuum()`,
			// and no cancellation hook to stop the stale call instead). So: log
			// once, count it, and skip — never dispatch. The flag can only be
			// cleared by the stuck dispatch's own `.finally()` once its promise
			// actually settles.
			//
			// Discarded alternative: keep the takeover but have it cancel the
			// stale dispatch first. Rejected because `DatabaseOperations` has no
			// cancellation hook for an in-flight worker call, and adding one is
			// out of this fix's scope — the warn-only guard needs no new
			// coordination at that layer.
			const sinceLastWarn =
				state.lastStaleWarnAt !== null
					? now() - state.lastStaleWarnAt
					: Number.POSITIVE_INFINITY;
			if (sinceLastWarn >= VACUUM_TICK_STALE_GUARD_MS) {
				state.staleWarnings += 1;
				state.lastStaleWarnAt = now();
				log.warn(
					`Vacuum tick in-flight flag has been set for ${age}ms (token ` +
						`${state.vacuumTickToken}), past the ${VACUUM_TICK_STALE_GUARD_MS}ms ` +
						`self-heal ceiling — a prior reclaim likely never settled, or is ` +
						`still genuinely running under sustained writer contention. NOT ` +
						`dispatching a second reclaim (would double up on SQLite's ` +
						`single writer slot) — skipping this tick (${source}) instead. ` +
						`The flag clears only when the stuck dispatch's own promise ` +
						`settles. ${state.staleWarnings} stale warning(s) so far.`,
				);
			}
			return;
		}
		// internal-breadth-1: mint a token identifying THIS dispatch. The
		// `.finally()` below only clears the shared in-flight state if this
		// field still holds the same token by the time it runs. With the
		// stale branch above no longer minting a fresh token on takeover
		// (fix-loop-3), this can no longer actually diverge in practice —
		// kept as the cheap, already-correct guard it always was (c259ac83).
		const token = ++state.vacuumTickToken;
		state.vacuumTickInFlight = true;
		state.vacuumTickInFlightSince = now();
		dbOps
			.incrementalVacuumAdaptive(opts)
			.then((r) => {
				if (r.reclaimedPages > 0) {
					log.info(
						`Adaptive incremental vacuum (${source}) reclaimed ${r.reclaimedPages} pages in ${r.chunks} chunk(s)`,
					);
				}
			})
			.catch((err) => {
				log.error(`Incremental vacuum (${source}) error: ${err}`);
			})
			.finally(() => {
				if (state.vacuumTickToken !== token) {
					// Should be unreachable now that the stale branch never mints
					// a new token — left in place as defense-in-depth (c259ac83).
					log.warn(
						`Vacuum tick (${source}, token ${token}) settled after being ` +
							`superseded by a newer dispatch (current token ` +
							`${state.vacuumTickToken}) — leaving the current in-flight ` +
							`state untouched.`,
					);
					return;
				}
				state.vacuumTickInFlight = false;
				state.vacuumTickInFlightSince = null;
			});
	};

	// The hourly tick's own call passes `enabled: config.getAutoVacuumEnabled()`
	// so the operator switch gates this path too, not only the catch-up one.
	const runHourlyTick = (): void => {
		runVacuumTick(
			{
				enabled: config.getAutoVacuumEnabled(),
				maxPagesPerTick: VACUUM_HOURLY_MAX_PAGES_PER_TICK,
			},
			"retention",
		);
	};

	// Catch-up incremental vacuum: the hourly retention-driven tick above caps
	// reclaim at ~1 GiB (VACUUM_HOURLY_MAX_PAGES_PER_TICK), which cannot keep
	// pace with a sustained delete rate above that. This runs every 5 minutes,
	// but shouldRunVacuumCatchUp keeps it a genuine no-op in steady state (a
	// below-threshold ratio skips regardless of the queue, so a healthy DB
	// adds no writer-slot contention at all). Once the ratio IS elevated, it
	// only dispatches while the async writer's queue is empty at the moment
	// this check runs — a best-effort backpressure gate, not a running
	// guarantee (greptile review on PR #475): the queue is a point-in-time
	// snapshot taken before dispatch, so writes arriving afterwards, while
	// the reclaim's own chunks are still in flight, can still contend for
	// the writer slot. This reduces, rather than eliminates, contention on
	// an elevated-ratio dispatch.
	const runCatchUpTick = async (): Promise<void> => {
		const autoVacuumEnabled = config.getAutoVacuumEnabled();
		const asyncWriterQueuedJobs = asyncWriter.getHealth().queuedJobs;
		const freelistPages = dbOps.getFreelistCount();
		const pageCount = dbOps.getPageCount();
		const decision = {
			autoVacuumEnabled,
			asyncWriterQueuedJobs,
			freelistPages,
			pageCount,
		};

		// internal-2 / greptile review on PR #475: asyncWriterQueuedJobs > 0 is
		// the ONE backoff condition this tick added on top of the switch and
		// the ratio threshold, and it is the one that can correlate with — and
		// hide behind — the exact writer contention the tick exists to work
		// through. Track it with its own counter, but ONLY when the freelist
		// ratio alone already cleared the threshold: a busy writer queue is
		// never the reason a catch-up round with a below-threshold ratio does
		// nothing (the ratio check would have skipped it regardless of the
		// queue), so counting that combination here would read as "reclaim is
		// starved by writer contention" on a database that is not actually
		// falling behind at all — the false-starvation telemetry this fix
		// removes. "ratio below threshold" (busy queue or not) stays ordinary
		// steady state and is not tracked here: the consecutive counter is
		// left exactly as it was, neither incremented nor reset — a
		// below-threshold round is not evidence either way about writer
		// contention, so it should not silently erase a real streak that was
		// building while the ratio was still elevated a few ticks ago. The
		// counter only ever resets on an actual catch-up dispatch, below.
		const ratioReachedThreshold =
			autoVacuumEnabled && freelistRatioAtOrAboveThreshold(decision);
		if (ratioReachedThreshold && asyncWriterQueuedJobs > 0) {
			const consecutive = dbOps.recordVacuumCatchUpBusySkip();
			if (consecutive % VACUUM_CATCHUP_BUSY_SKIP_WARN_EVERY === 0) {
				const hours = (consecutive * 5) / 60;
				log.warn(
					`Vacuum catch-up has backed off ${consecutive} consecutive times ` +
						`(~${hours}h at the 5-minute cadence) because the async DB ` +
						`writer's queue was non-empty — reclaim may be starved by ` +
						`sustained writer contention.`,
				);
			}
		}

		if (!shouldRunVacuumCatchUp(decision)) return;

		// A dispatch means the writer was idle this round, so any prior
		// busy-skip streak is over.
		dbOps.resetVacuumCatchUpBusySkips();

		log.debug(
			`Vacuum catch-up dispatching — freelist ${decision.freelistPages}/${decision.pageCount} pages`,
		);
		runVacuumTick(
			{
				maxPagesPerTick: VACUUM_CATCHUP_MAX_PAGES_PER_TICK,
				enabled: true, // shouldRunVacuumCatchUp() already checked the switch
			},
			"catchup",
		);
	};

	return { runHourlyTick, runCatchUpTick, state };
}

/**
 * Narrow surface `runVacuumBootstrap()` needs from `DatabaseOperations`.
 */
export type VacuumBootstrapDbOps = Pick<
	DatabaseOperations,
	"bootstrapAutoVacuum"
>;

/**
 * One-time migration: promote pre-existing DBs from auto_vacuum=NONE to
 * INCREMENTAL. Fresh DBs created since ensureSchema() started issuing
 * `PRAGMA auto_vacuum = INCREMENTAL` are already in mode 2 and this is a
 * fast no-op. Existing DBs upgraded into this build run a full VACUUM here
 * — minutes on a multi-GB file. Called from `startServer()` BEFORE the HTTP
 * listener binds so the proxy never sees a stalled writer slot.
 *
 * internal-7: gated on the operator switch. Without this gate, a file still
 * on auto_vacuum=NONE would run its blocking migration VACUUM regardless of
 * `BETTER_CCFLARE_AUTO_VACUUM` — exactly the writer-slot contention an
 * operator setting the switch off before a maintenance window is trying to
 * avoid, at exactly the moment they act on it. This only DEFERS the
 * migration (it re-runs, still gated, on the next restart) — it never skips
 * it permanently, since bootstrapAutoVacuum() itself is a fast no-op once
 * the file is already in INCREMENTAL mode. Unlike the two periodic reclaim
 * ticks in `createVacuumScheduler()` above (which both call
 * `config.getAutoVacuumEnabled()` live on every tick, so an in-process
 * switch flip reaches them on their very next run — see that method's doc
 * comment), this function only ever runs once per process, at startup
 * before the HTTP listener binds: a switch flipped after boot cannot change
 * whether *this* run's migration happens, only whether the *next* restart's
 * run does.
 */
export function runVacuumBootstrap(
	dbOps: VacuumBootstrapDbOps,
	autoVacuumEnabled: boolean,
	log: Logger,
): void {
	if (!autoVacuumEnabled) {
		log.warn(
			"BETTER_CCFLARE_AUTO_VACUUM is disabled — deferring the one-time " +
				"auto_vacuum mode migration (bootstrapAutoVacuum) until the switch " +
				"is re-enabled and the process restarts. A file still on " +
				"auto_vacuum=NONE will not reclaim any freed pages until this " +
				"migration runs.",
		);
		return;
	}
	try {
		const result = dbOps.bootstrapAutoVacuum();
		if (result.migrated) {
			log.info(
				`One-time auto_vacuum migration: mode ${result.modeBefore} → ${result.modeAfter} ` +
					`in ${result.durationMs}ms. Future free-page reclamation runs incrementally via the ` +
					`hourly worker — no more blocking VACUUM.`,
			);
			if (result.modeAfter !== 2) {
				log.error(
					`auto_vacuum still ${result.modeAfter} after migration VACUUM — ` +
						`incremental reclamation will be a no-op. Investigate disk space and DB integrity.`,
				);
			}
		} else if (result.modeBefore === 1) {
			// Operator set auto_vacuum=FULL on purpose. We don't migrate it to
			// INCREMENTAL silently because FULL reclaims pages on every COMMIT
			// while INCREMENTAL only reclaims when our hourly worker runs —
			// rewriting that policy without notice would surprise the user.
			// Log so it shows up in startup logs and `journalctl`. (Greptile #230)
			log.info(
				`auto_vacuum=FULL (mode 1) detected — left in place. The hourly incremental_vacuum ` +
					`worker is a no-op under FULL mode; pages are reclaimed on every COMMIT. ` +
					`Switch to INCREMENTAL manually if you want the worker-driven cadence.`,
			);
		}
	} catch (err) {
		log.error(
			`Bootstrap auto_vacuum migration failed: ${err instanceof Error ? err.message : String(err)}. ` +
				`Free pages will not be reclaimed until this is resolved. ` +
				`Common causes: disk full (VACUUM needs ~2× DB size free), DB corruption.`,
		);
		throw err;
	}
}
