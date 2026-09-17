/**
 * Tests for the vacuum scheduler extracted from startServer()'s closures
 * (internal-5): the shared in-flight guard across the hourly and catch-up
 * ticks, and the catch-up dispatch policy. Every dependency is a fake so
 * these run in milliseconds without a real DB, worker, or async writer.
 */
import { describe, expect, it } from "bun:test";
import { Logger, logBus } from "@better-ccflare/logger";
import type { LogEvent } from "@better-ccflare/types";
import {
	createVacuumScheduler,
	runVacuumBootstrap,
	shouldRunVacuumCatchUp,
	VACUUM_CATCHUP_FREELIST_RATIO_THRESHOLD,
	VACUUM_CATCHUP_MAX_PAGES_PER_TICK,
	VACUUM_HOURLY_MAX_PAGES_PER_TICK,
	VACUUM_TICK_STALE_GUARD_MS,
	type VacuumSchedulerDbOps,
} from "./vacuum-scheduler";

// ---------------------------------------------------------------------------
// shouldRunVacuumCatchUp — moved verbatim from server.test.ts (internal-5).
// ---------------------------------------------------------------------------

describe("shouldRunVacuumCatchUp", () => {
	const baseInput = {
		autoVacuumEnabled: true,
		asyncWriterQueuedJobs: 0,
		freelistPages: 30,
		pageCount: 100, // 30% free — above the 10% default threshold
	};

	it("runs when enabled, the writer is idle, and the freelist ratio is at or above the threshold", () => {
		expect(shouldRunVacuumCatchUp(baseInput)).toBe(true);
	});

	it("does not run when the operator switch is off — the explicit reason the switch must gate this path too", () => {
		expect(
			shouldRunVacuumCatchUp({ ...baseInput, autoVacuumEnabled: false }),
		).toBe(false);
	});

	it("backs off when the async writer has not drained its queue", () => {
		expect(
			shouldRunVacuumCatchUp({ ...baseInput, asyncWriterQueuedJobs: 1 }),
		).toBe(false);
	});

	it("does not run when page_count is 0 (fresh/empty DB) — avoids a division by zero reading as a false trigger", () => {
		expect(
			shouldRunVacuumCatchUp({ ...baseInput, freelistPages: 0, pageCount: 0 }),
		).toBe(false);
	});

	it("does not run below the freelist ratio threshold (steady state)", () => {
		expect(
			shouldRunVacuumCatchUp({ ...baseInput, freelistPages: 5 }), // 5%
		).toBe(false);
	});

	it("runs exactly at the threshold boundary (>=, not >)", () => {
		expect(
			shouldRunVacuumCatchUp({
				...baseInput,
				freelistPages: VACUUM_CATCHUP_FREELIST_RATIO_THRESHOLD * 100,
				pageCount: 100,
			}),
		).toBe(true);
	});

	it("honors an explicit ratioThreshold override instead of the module default", () => {
		expect(
			shouldRunVacuumCatchUp({
				...baseInput,
				freelistPages: 5,
				ratioThreshold: 0.03,
			}),
		).toBe(true);
		expect(
			shouldRunVacuumCatchUp({
				...baseInput,
				freelistPages: 5,
				ratioThreshold: 0.5,
			}),
		).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// createVacuumScheduler — the shared guard and the per-tick dispatch caps.
// ---------------------------------------------------------------------------

interface FakeDbOpsOptions {
	incrementalVacuumAdaptive?: VacuumSchedulerDbOps["incrementalVacuumAdaptive"];
	freelistPages?: number;
	pageCount?: number;
}

function makeFakeDbOps(opts: FakeDbOpsOptions = {}) {
	const calls: Array<
		Parameters<VacuumSchedulerDbOps["incrementalVacuumAdaptive"]>[0]
	> = [];
	let catchUpBusySkips = 0;
	let catchUpBusySkipsTotal = 0;
	const dbOps: VacuumSchedulerDbOps = {
		incrementalVacuumAdaptive:
			opts.incrementalVacuumAdaptive ??
			(async (o) => {
				calls.push(o);
				return { reclaimedPages: 0, chunks: 0 };
			}),
		getFreelistCount: () => opts.freelistPages ?? 0,
		getPageCount: () => opts.pageCount ?? 100,
		recordVacuumCatchUpBusySkip: () => {
			catchUpBusySkips += 1;
			catchUpBusySkipsTotal += 1;
			return catchUpBusySkips;
		},
		resetVacuumCatchUpBusySkips: () => {
			catchUpBusySkips = 0;
		},
	};
	return {
		dbOps,
		calls,
		getCatchUpBusySkips: () => catchUpBusySkips,
		getCatchUpBusySkipsTotal: () => catchUpBusySkipsTotal,
	};
}

/**
 * Flushes the microtask queue past a `.then().catch().finally()` chain of
 * arbitrary depth (runVacuumTick's fire-and-forget chain needs a handful of
 * microtask ticks to fully settle) — a macrotask boundary guarantees every
 * pending microtask has drained, so tests don't need to guess a tick count.
 */
function flushAsync(): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, 0));
}

function makeFakeAsyncWriter(queuedJobs = 0) {
	return { getHealth: () => ({ queuedJobs }) };
}

function makeFakeConfig(autoVacuumEnabled = true) {
	return { getAutoVacuumEnabled: () => autoVacuumEnabled };
}

describe("createVacuumScheduler — shared in-flight guard", () => {
	it("(a) two concurrent invocations dispatch exactly one incrementalVacuumAdaptive call", async () => {
		let resolveFirst: (() => void) | undefined;
		const gate = new Promise<void>((resolve) => {
			resolveFirst = resolve;
		});
		const { dbOps, calls } = makeFakeDbOps({
			incrementalVacuumAdaptive: async (o) => {
				calls.push(o);
				await gate;
				return { reclaimedPages: 0, chunks: 0 };
			},
		});
		const scheduler = createVacuumScheduler({
			dbOps,
			config: makeFakeConfig(),
			asyncWriter: makeFakeAsyncWriter(),
			log: new Logger("test"),
		});

		scheduler.runHourlyTick();
		scheduler.runHourlyTick(); // fires while the first is still in flight

		expect(calls.length).toBe(1);
		resolveFirst?.();
		// Let the in-flight promise's .finally() run.
		await flushAsync();
	});

	it("(b) a rejection resets the guard so the next tick actually runs", async () => {
		let callCount = 0;
		const { dbOps, calls } = makeFakeDbOps({
			incrementalVacuumAdaptive: async (o) => {
				calls.push(o);
				callCount += 1;
				if (callCount === 1) throw new Error("worker timed out");
				return { reclaimedPages: 0, chunks: 0 };
			},
		});
		const scheduler = createVacuumScheduler({
			dbOps,
			config: makeFakeConfig(),
			asyncWriter: makeFakeAsyncWriter(),
			log: new Logger("test"),
		});

		scheduler.runHourlyTick();
		// Flush microtasks so the rejection's .catch()/.finally() run.
		await flushAsync();

		expect(scheduler.state.vacuumTickInFlight).toBe(false);

		scheduler.runHourlyTick();
		await flushAsync();

		expect(calls.length).toBe(2);
	});

	it("(c) the hourly tick passes maxPagesPerTick 262144 and the catch-up tick passes 65536", async () => {
		const { dbOps, calls } = makeFakeDbOps({
			freelistPages: 50,
			pageCount: 100, // 50% free, well above the 10% threshold
		});
		const scheduler = createVacuumScheduler({
			dbOps,
			config: makeFakeConfig(),
			asyncWriter: makeFakeAsyncWriter(0),
			log: new Logger("test"),
		});

		scheduler.runHourlyTick();
		await flushAsync();
		expect(calls[0]?.maxPagesPerTick).toBe(VACUUM_HOURLY_MAX_PAGES_PER_TICK);
		expect(VACUUM_HOURLY_MAX_PAGES_PER_TICK).toBe(262144);

		await scheduler.runCatchUpTick();
		await flushAsync();
		expect(calls[1]?.maxPagesPerTick).toBe(VACUUM_CATCHUP_MAX_PAGES_PER_TICK);
		expect(VACUUM_CATCHUP_MAX_PAGES_PER_TICK).toBe(65536);
	});

	it("does not dispatch the catch-up tick below the freelist ratio threshold (steady state)", async () => {
		const { dbOps, calls } = makeFakeDbOps({
			freelistPages: 5,
			pageCount: 100, // 5% — below the 10% threshold
		});
		const scheduler = createVacuumScheduler({
			dbOps,
			config: makeFakeConfig(),
			asyncWriter: makeFakeAsyncWriter(0),
			log: new Logger("test"),
		});

		await scheduler.runCatchUpTick();

		expect(calls.length).toBe(0);
	});

	it("(f) a stale dispatch settling after a self-heal takeover does not clobber the newer dispatch's state, and a tick during the takeover window still skips (internal-breadth-1)", async () => {
		let now = 1_000_000;
		let resolveFirst: (() => void) | undefined;
		const firstGate = new Promise<void>((resolve) => {
			resolveFirst = resolve;
		});
		// The second (takeover) dispatch's own promise never settles within
		// this test — it represents the genuinely still-running reclaim the
		// self-heal takeover started.
		const secondGate = new Promise<void>(() => {});
		const { dbOps, calls } = makeFakeDbOps({
			incrementalVacuumAdaptive: async (o) => {
				calls.push(o);
				if (calls.length === 1) {
					await firstGate;
				} else {
					await secondGate;
				}
				return { reclaimedPages: 0, chunks: 0 };
			},
		});
		const scheduler = createVacuumScheduler({
			dbOps,
			config: makeFakeConfig(),
			asyncWriter: makeFakeAsyncWriter(),
			log: new Logger("test"),
			now: () => now,
		});

		// Dispatch #1 (token 1): slow but healthy, not actually hung yet.
		scheduler.runHourlyTick();
		await flushAsync();
		expect(calls.length).toBe(1);
		expect(scheduler.state.vacuumTickInFlight).toBe(true);

		// Past the self-heal ceiling — a second tick takes over and mints a
		// new token (dispatch #2), even though dispatch #1 is merely slow.
		now += VACUUM_TICK_STALE_GUARD_MS;
		scheduler.runHourlyTick();
		await flushAsync();
		expect(calls.length).toBe(2);
		expect(scheduler.state.vacuumTickInFlight).toBe(true);
		const tokenAfterTakeover = scheduler.state.vacuumTickToken;
		expect(scheduler.state.staleTakeovers).toBe(1);

		// A third tick fires immediately after the takeover — the guard was
		// just re-latched (vacuumTickInFlightSince reset), so age is ~0 and
		// this tick must skip rather than dispatch a THIRD call.
		scheduler.runHourlyTick();
		await flushAsync();
		expect(calls.length).toBe(2);

		// Dispatch #1 (the stale one) now settles — belatedly, after being
		// superseded. Its own `.finally()` must NOT clear the state dispatch
		// #2 owns: this is the clobber internal-breadth-1 identified.
		resolveFirst?.();
		await flushAsync();
		expect(scheduler.state.vacuumTickInFlight).toBe(true);
		expect(scheduler.state.vacuumTickToken).toBe(tokenAfterTakeover);

		// A fourth tick, right after dispatch #1's belated settlement, must
		// still see "in flight" (dispatch #2 is genuinely still running) and
		// skip — proving no third dispatch snuck in via the clobbered state.
		scheduler.runHourlyTick();
		await flushAsync();
		expect(calls.length).toBe(2);
	});

	it("(e) a stale in-flight flag self-heals after VACUUM_TICK_STALE_GUARD_MS and dispatches", async () => {
		let now = 1_000_000;
		const gate = new Promise<void>(() => {}); // never settles — simulates a hung worker
		const { dbOps, calls } = makeFakeDbOps({
			incrementalVacuumAdaptive: async (o) => {
				calls.push(o);
				if (calls.length === 1) {
					await gate;
				}
				return { reclaimedPages: 0, chunks: 0 };
			},
		});
		const scheduler = createVacuumScheduler({
			dbOps,
			config: makeFakeConfig(),
			asyncWriter: makeFakeAsyncWriter(),
			log: new Logger("test"),
			now: () => now,
		});

		scheduler.runHourlyTick(); // latches the flag forever (gate never resolves)
		await flushAsync();
		expect(scheduler.state.vacuumTickInFlight).toBe(true);

		// Still within the ceiling — stays skipped.
		now += VACUUM_TICK_STALE_GUARD_MS - 1;
		scheduler.runHourlyTick();
		await flushAsync();
		expect(calls.length).toBe(1);

		// Past the ceiling — self-heals and dispatches a fresh call.
		now += 2;
		scheduler.runHourlyTick();
		await flushAsync();
		expect(calls.length).toBe(2);
	});
});

describe("createVacuumScheduler — live config reads (internal-breadth-2)", () => {
	it("runHourlyTick reads config.getAutoVacuumEnabled() live on every tick — a switch flip takes effect on the very next tick, no restart needed", async () => {
		let enabled = true;
		const { dbOps, calls } = makeFakeDbOps();
		const scheduler = createVacuumScheduler({
			dbOps,
			config: { getAutoVacuumEnabled: () => enabled },
			asyncWriter: makeFakeAsyncWriter(),
			log: new Logger("test"),
		});

		scheduler.runHourlyTick();
		await flushAsync();
		expect(calls[0]?.enabled).toBe(true);

		// Simulates an in-process setAutoVacuumEnabled(false) call between
		// ticks — no restart, no re-construction of the scheduler.
		enabled = false;
		scheduler.runHourlyTick();
		await flushAsync();
		expect(calls[1]?.enabled).toBe(false);
	});
});

describe("createVacuumScheduler — catch-up busy-skip telemetry (internal-2)", () => {
	it("does not dispatch and does not touch the busy-skip counter when the freelist ratio is below threshold", async () => {
		const { dbOps, calls, getCatchUpBusySkips } = makeFakeDbOps({
			freelistPages: 5,
			pageCount: 100, // 5% — below the 10% threshold
		});
		const scheduler = createVacuumScheduler({
			dbOps,
			config: makeFakeConfig(),
			asyncWriter: makeFakeAsyncWriter(0), // writer idle
			log: new Logger("test"),
		});

		await scheduler.runCatchUpTick();

		expect(calls.length).toBe(0);
		expect(getCatchUpBusySkips()).toBe(0);
	});

	it("records a busy skip and does not dispatch when the async writer queue is non-empty", async () => {
		const { dbOps, calls, getCatchUpBusySkips, getCatchUpBusySkipsTotal } =
			makeFakeDbOps({
				freelistPages: 50,
				pageCount: 100, // 50% free — would otherwise qualify
			});
		const scheduler = createVacuumScheduler({
			dbOps,
			config: makeFakeConfig(),
			asyncWriter: makeFakeAsyncWriter(1), // queue non-empty
			log: new Logger("test"),
		});

		await scheduler.runCatchUpTick();
		await scheduler.runCatchUpTick();

		expect(calls.length).toBe(0);
		expect(getCatchUpBusySkips()).toBe(2);
		expect(getCatchUpBusySkipsTotal()).toBe(2);
	});

	it("resets the consecutive busy-skip counter once a catch-up reclaim actually dispatches", async () => {
		let queuedJobs = 1;
		const { dbOps, calls, getCatchUpBusySkips, getCatchUpBusySkipsTotal } =
			makeFakeDbOps({
				freelistPages: 50,
				pageCount: 100,
			});
		const scheduler = createVacuumScheduler({
			dbOps,
			config: makeFakeConfig(),
			asyncWriter: { getHealth: () => ({ queuedJobs }) },
			log: new Logger("test"),
		});

		await scheduler.runCatchUpTick(); // busy skip #1
		await scheduler.runCatchUpTick(); // busy skip #2
		expect(getCatchUpBusySkips()).toBe(2);

		queuedJobs = 0; // writer drains
		await scheduler.runCatchUpTick();
		await flushAsync();

		expect(calls.length).toBe(1);
		expect(getCatchUpBusySkips()).toBe(0);
		// The lifetime total is never reset.
		expect(getCatchUpBusySkipsTotal()).toBe(2);
	});

	it("logs a WARN once the consecutive busy-skip count reaches 12, and again at 24", async () => {
		const { dbOps } = makeFakeDbOps({ freelistPages: 50, pageCount: 100 });
		const log = new Logger("test");
		const scheduler = createVacuumScheduler({
			dbOps,
			config: makeFakeConfig(),
			asyncWriter: makeFakeAsyncWriter(1),
			log,
		});

		const captured: LogEvent[] = [];
		const handler = (event: LogEvent) => captured.push(event);
		logBus.on("log", handler);
		try {
			for (let i = 0; i < 24; i++) {
				await scheduler.runCatchUpTick();
			}
		} finally {
			logBus.off("log", handler);
		}

		const warns = captured.filter((e) => e.level === "WARN");
		expect(warns.length).toBe(2);
		expect(warns[0]?.msg).toContain("12");
		expect(warns[1]?.msg).toContain("24");
	});
});

describe("runVacuumBootstrap (internal-7)", () => {
	it("runs bootstrapAutoVacuum() when the operator switch is enabled", () => {
		let calls = 0;
		const dbOps: Parameters<typeof runVacuumBootstrap>[0] = {
			bootstrapAutoVacuum: () => {
				calls += 1;
				return { migrated: false, modeBefore: 2, modeAfter: 2, durationMs: 0 };
			},
		};
		runVacuumBootstrap(dbOps, true, new Logger("test"));
		expect(calls).toBe(1);
	});

	it("skips bootstrapAutoVacuum() and logs a WARN when the operator switch is disabled", () => {
		let calls = 0;
		const dbOps: Parameters<typeof runVacuumBootstrap>[0] = {
			bootstrapAutoVacuum: () => {
				calls += 1;
				return { migrated: true, modeBefore: 0, modeAfter: 2, durationMs: 5 };
			},
		};
		const log = new Logger("test");
		const captured: LogEvent[] = [];
		const handler = (event: LogEvent) => captured.push(event);
		logBus.on("log", handler);
		try {
			runVacuumBootstrap(dbOps, false, log);
		} finally {
			logBus.off("log", handler);
		}

		expect(calls).toBe(0);
		expect(captured.some((e) => e.level === "WARN")).toBe(true);
	});

	it("propagates a thrown error from bootstrapAutoVacuum() instead of swallowing it", () => {
		const dbOps: Parameters<typeof runVacuumBootstrap>[0] = {
			bootstrapAutoVacuum: () => {
				throw new Error("disk full");
			},
		};
		expect(() => runVacuumBootstrap(dbOps, true, new Logger("test"))).toThrow(
			"disk full",
		);
	});
});
