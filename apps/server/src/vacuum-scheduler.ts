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
	"incrementalVacuumAdaptive" | "getFreelistCount" | "getPageCount"
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
export function shouldRunVacuumCatchUp(input: {
	autoVacuumEnabled: boolean;
	asyncWriterQueuedJobs: number;
	freelistPages: number;
	pageCount: number;
	ratioThreshold?: number;
}): boolean {
	if (!input.autoVacuumEnabled) return false;
	if (input.asyncWriterQueuedJobs > 0) return false;
	if (input.pageCount <= 0) return false;
	const ratio = input.freelistPages / input.pageCount;
	return (
		ratio >= (input.ratioThreshold ?? VACUUM_CATCHUP_FREELIST_RATIO_THRESHOLD)
	);
}

/**
 * Self-heal ceiling for the shared `vacuumTickInFlight` flag (internal-3):
 * if a tick still finds it set after this long, a prior reclaim promise
 * almost certainly never settled (e.g. the worker died without firing
 * `onmessage` or `onerror`) rather than genuinely still running —
 * `incrementalVacuum()`'s own 120s per-chunk worker timeout
 * (database-operations.ts) should already have rejected it by then.
 * Derivation: 3 * 120s per-chunk timeout * 16 chunks (the hourly tick's
 * ~1 GiB ceiling / 64 MiB chunk size — the most chunks one legitimate tick
 * can issue) = 96 minutes; capped at 30 minutes so a genuinely wedged flag
 * cannot silently disable both reclaim ticks for over an hour and a half.
 */
export const VACUUM_TICK_STALE_GUARD_MS = 30 * 60 * 1000;

export interface VacuumSchedulerState {
	vacuumTickInFlight: boolean;
	/** epoch ms (per the injected `now`) when the flag was last set; null while not in flight. */
	vacuumTickInFlightSince: number | null;
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
			if (age >= VACUUM_TICK_STALE_GUARD_MS) {
				// internal-3: the flag has been held far longer than any
				// legitimate reclaim can take (incrementalVacuum()'s own
				// per-chunk worker timeout bounds each chunk) — treat it as
				// stuck rather than early-returning forever, and dispatch this
				// tick instead of silently disabling reclaim indefinitely.
				log.warn(
					`Vacuum tick in-flight flag has been set for ${age}ms, past the ` +
						`${VACUUM_TICK_STALE_GUARD_MS}ms self-heal ceiling — a prior ` +
						`reclaim likely never settled. Resetting the guard and ` +
						`dispatching this tick (${source}).`,
				);
				state.vacuumTickInFlight = false;
			} else {
				log.debug(
					`Vacuum tick (${source}) skipped — another vacuum tick is still in flight`,
				);
				return;
			}
		}
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
	// but shouldRunVacuumCatchUp keeps it a no-op in steady state: it only
	// dispatches a (smaller-capped) reclaim while the freelist ratio is
	// elevated and the async writer has fully drained its own queue, so it
	// adds no extra writer-slot contention when the DB is already healthy.
	const runCatchUpTick = async (): Promise<void> => {
		const decision = {
			autoVacuumEnabled: config.getAutoVacuumEnabled(),
			asyncWriterQueuedJobs: asyncWriter.getHealth().queuedJobs,
			freelistPages: dbOps.getFreelistCount(),
			pageCount: dbOps.getPageCount(),
		};
		if (!shouldRunVacuumCatchUp(decision)) return;
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
