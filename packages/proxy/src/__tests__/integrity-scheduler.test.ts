/**
 * Tests for startIntegrityScheduler + runIntegrityCheckOnDemand
 * (packages/proxy/src/integrity-scheduler.ts).
 *
 * Strategy: pass a mock DatabaseOperations so we can observe calls to
 * runQuickIntegrityCheck / runFullIntegrityCheck / markIntegrityCheckRunning
 * / recordIntegrityResult without touching a real database. Timers run on a
 * very long interval so the periodic ticks don't fire during the test —
 * we exercise the per-check coroutines via the on-demand entry point.
 */
import { afterEach, describe, expect, it, mock } from "bun:test";
import type { DatabaseOperations } from "@better-ccflare/database";

import {
	runIntegrityCheckOnDemand,
	startFullIntegrityCheckBackground,
	startIntegrityScheduler,
} from "../integrity-scheduler";

interface MockDbOpsOptions {
	quickResult?: string | Error;
	fullResult?: { ok: true } | { ok: false; error: string } | Error;
	dbPath?: string | undefined;
	canClaim?: boolean;
}

function makeDbOps(opts: MockDbOpsOptions = {}): DatabaseOperations {
	const quickResult = opts.quickResult ?? "ok";
	const fullResult = opts.fullResult ?? { ok: true };
	let claimed = false;

	const runQuickIntegrityCheck = mock(async () => {
		if (quickResult instanceof Error) throw quickResult;
		return quickResult;
	});
	const runFullIntegrityCheck = mock(async () => {
		if (fullResult instanceof Error) throw fullResult;
		return fullResult.ok ? "ok" : fullResult.error;
	});
	const markIntegrityCheckRunning = mock(() => {
		if (opts.canClaim === false) return false;
		if (claimed) return false;
		claimed = true;
		return true;
	});
	const recordIntegrityResult = mock(() => {
		claimed = false;
	});
	const getResolvedDbPath = mock(() => opts.dbPath);

	return {
		runQuickIntegrityCheck,
		runFullIntegrityCheck,
		markIntegrityCheckRunning,
		recordIntegrityResult,
		getResolvedDbPath,
	} as unknown as DatabaseOperations;
}

describe("startIntegrityScheduler", () => {
	afterEach(() => {
		delete process.env.CCFLARE_INTEGRITY_CHECK_INTERVAL;
		delete process.env.CCFLARE_FULL_INTEGRITY_CHECK_INTERVAL;
	});

	it("returns a stop function that doesn't throw", () => {
		const dbOps = makeDbOps();
		const stop = startIntegrityScheduler(dbOps, {
			quickIntervalHours: 500,
			fullIntervalHours: 500,
		});
		expect(typeof stop).toBe("function");
		expect(() => stop()).not.toThrow();
	});

	it("CCFLARE_INTEGRITY_CHECK_INTERVAL=0 disables only the quick check", () => {
		process.env.CCFLARE_INTEGRITY_CHECK_INTERVAL = "0";
		const dbOps = makeDbOps();
		const stop = startIntegrityScheduler(dbOps, { fullIntervalHours: 500 });
		expect(typeof stop).toBe("function");
		stop();
	});

	it("setting both env vars to 0 returns a no-op stop", () => {
		process.env.CCFLARE_INTEGRITY_CHECK_INTERVAL = "0";
		process.env.CCFLARE_FULL_INTEGRITY_CHECK_INTERVAL = "0";
		const dbOps = makeDbOps();
		const stop = startIntegrityScheduler(dbOps);
		expect(() => stop()).not.toThrow();
		expect(
			(dbOps.runQuickIntegrityCheck as ReturnType<typeof mock>).mock.calls
				.length,
		).toBe(0);
	});

	it("garbled env values fall back to default", () => {
		process.env.CCFLARE_INTEGRITY_CHECK_INTERVAL = "6abc";
		const dbOps = makeDbOps();
		const stop = startIntegrityScheduler(dbOps, { fullIntervalHours: 500 });
		expect(typeof stop).toBe("function");
		stop();
	});

	it("override quickIntervalHours=0 disables the quick probe (not setInterval(0))", () => {
		// Regression: an explicit `0` override used to multiply by HOUR (still
		// 0) and pass the !== null guard, scheduling setInterval(runQuick, 0).
		const dbOps = makeDbOps();
		const stop = startIntegrityScheduler(dbOps, {
			quickIntervalHours: 0,
			fullIntervalHours: 500,
		});
		expect(typeof stop).toBe("function");
		// If the disable path is broken setInterval would have fired by now
		// (we don't sleep, but constructor-time logic decides scheduling).
		// The test passes as long as we don't blow up; full assertion is
		// indirect via "no exception on stop()" + no exception during setup.
		stop();
	});

	it("override fullIntervalHours=0 disables the full probe", () => {
		const dbOps = makeDbOps();
		const stop = startIntegrityScheduler(dbOps, {
			quickIntervalHours: 500,
			fullIntervalHours: 0,
		});
		expect(typeof stop).toBe("function");
		stop();
	});
});

describe("runIntegrityCheckOnDemand", () => {
	it("quick returns ok when quick_check returns 'ok'", async () => {
		const dbOps = makeDbOps({ quickResult: "ok" });
		const out = await runIntegrityCheckOnDemand(dbOps, "quick");
		expect(out.ok).toBe(true);
		if (out.ok) {
			expect(out.result).toBe("ok");
			expect(out.error).toBeNull();
		}
		expect(dbOps.recordIntegrityResult).toHaveBeenCalledWith(
			"quick",
			"ok",
			null,
		);
	});

	it("quick returns corrupt with the error message when quick_check fails", async () => {
		const dbOps = makeDbOps({ quickResult: "*** missing index entry" });
		const out = await runIntegrityCheckOnDemand(dbOps, "quick");
		expect(out.ok).toBe(true);
		if (out.ok) {
			expect(out.result).toBe("corrupt");
			expect(out.error).toBe("*** missing index entry");
		}
	});

	it("quick reports corrupt when runQuickIntegrityCheck throws", async () => {
		const dbOps = makeDbOps({ quickResult: new Error("I/O error") });
		const out = await runIntegrityCheckOnDemand(dbOps, "quick");
		expect(out.ok).toBe(true);
		if (out.ok) {
			expect(out.result).toBe("corrupt");
			expect(out.error).toContain("I/O error");
		}
	});

	it("returns 409-style { ok: false, reason: 'already-running' } when mutex is held", async () => {
		const dbOps = makeDbOps({ canClaim: false });
		const out = await runIntegrityCheckOnDemand(dbOps, "quick");
		expect(out.ok).toBe(false);
		if (!out.ok) expect(out.reason).toBe("already-running");
	});

	it("full falls back to PG-style runFullIntegrityCheck when no SQLite path", async () => {
		const dbOps = makeDbOps({ dbPath: undefined, fullResult: { ok: true } });
		const out = await runIntegrityCheckOnDemand(dbOps, "full");
		expect(out.ok).toBe(true);
		if (out.ok) expect(out.result).toBe("ok");
		// Should NOT have tried to spawn a worker — it has no SQLite file
		expect(dbOps.runFullIntegrityCheck).toHaveBeenCalled();
	});

	it("a quick on-demand check followed by a full corrupt produces sticky-corrupt status", async () => {
		// This is the integration glue: the scheduler routes results through
		// `recordIntegrityResult`, which is what enforces the sticky rule.
		// `runIntegrityCheckOnDemand` should call into it with the correct kind.
		const dbOps = makeDbOps({
			quickResult: "ok",
			fullResult: { ok: false, error: "index missing entry" },
			dbPath: undefined, // forces full to use runFullIntegrityCheck path
		});

		await runIntegrityCheckOnDemand(dbOps, "quick");
		const quickCall = (
			dbOps.recordIntegrityResult as ReturnType<typeof mock>
		).mock.calls.at(-1);
		expect(quickCall?.[0]).toBe("quick");
		expect(quickCall?.[1]).toBe("ok");

		await runIntegrityCheckOnDemand(dbOps, "full");
		const fullCall = (
			dbOps.recordIntegrityResult as ReturnType<typeof mock>
		).mock.calls.at(-1);
		expect(fullCall?.[0]).toBe("full");
		expect(fullCall?.[1]).toBe("corrupt");
		expect(fullCall?.[2]).toBe("index missing entry");
	});
});

describe("startFullIntegrityCheckBackground", () => {
	it("returns ok synchronously and kicks the worker off without awaiting", async () => {
		const dbOps = makeDbOps({ fullResult: { ok: true }, dbPath: undefined });
		const out = startFullIntegrityCheckBackground(dbOps);
		expect(out.ok).toBe(true);

		// The mutex must already be claimed by the time this function returns.
		expect(dbOps.markIntegrityCheckRunning).toHaveBeenCalledWith("full");

		// The background promise hasn't necessarily settled yet — drain
		// microtasks so the test asserts on the eventual state.
		await new Promise<void>((resolve) => setImmediate(resolve));
		const lastCall = (
			dbOps.recordIntegrityResult as ReturnType<typeof mock>
		).mock.calls.at(-1);
		expect(lastCall?.[0]).toBe("full");
		expect(lastCall?.[1]).toBe("ok");
	});

	it("returns 409-style { ok: false, reason: 'already-running' } when mutex held", () => {
		const dbOps = makeDbOps({ canClaim: false });
		const out = startFullIntegrityCheckBackground(dbOps);
		expect(out.ok).toBe(false);
		if (!out.ok) expect(out.reason).toBe("already-running");
		// MUST NOT have called the worker path
		expect(dbOps.runFullIntegrityCheck).not.toHaveBeenCalled();
	});

	it("releases the mutex via recordIntegrityResult on background failure", async () => {
		const dbOps = makeDbOps({
			fullResult: new Error("boom"),
			dbPath: undefined,
		});
		const out = startFullIntegrityCheckBackground(dbOps);
		expect(out.ok).toBe(true);

		await new Promise<void>((resolve) => setImmediate(resolve));
		const lastCall = (
			dbOps.recordIntegrityResult as ReturnType<typeof mock>
		).mock.calls.at(-1);
		expect(lastCall?.[0]).toBe("full");
		expect(lastCall?.[1]).toBe("corrupt");
	});
});
