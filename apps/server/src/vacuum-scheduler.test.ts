/**
 * Tests for the vacuum scheduler extracted from startServer()'s closures
 * (internal-5): the shared in-flight guard across the hourly and catch-up
 * ticks, and the catch-up dispatch policy. Every dependency is a fake so
 * these run in milliseconds without a real DB, worker, or async writer.
 */
import { describe, expect, it } from "bun:test";
import { Logger } from "@better-ccflare/logger";
import {
	createVacuumScheduler,
	shouldRunVacuumCatchUp,
	VACUUM_CATCHUP_FREELIST_RATIO_THRESHOLD,
	VACUUM_CATCHUP_MAX_PAGES_PER_TICK,
	VACUUM_HOURLY_MAX_PAGES_PER_TICK,
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
	const dbOps: VacuumSchedulerDbOps = {
		incrementalVacuumAdaptive:
			opts.incrementalVacuumAdaptive ??
			(async (o) => {
				calls.push(o);
				return { reclaimedPages: 0, chunks: 0 };
			}),
		getFreelistCount: () => opts.freelistPages ?? 0,
		getPageCount: () => opts.pageCount ?? 100,
	};
	return { dbOps, calls };
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
});
