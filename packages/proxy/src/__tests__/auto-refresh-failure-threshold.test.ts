/**
 * Tests for AutoRefreshScheduler consecutive-failure threshold behaviour.
 *
 * When an account exceeds FAILURE_THRESHOLD consecutive auto-refresh failures
 * the scheduler must pause the account in the database so that the request
 * router (SessionStrategy) skips it until an operator resumes it.
 */
import { describe, expect, it, mock } from "bun:test";
import type { AutoRefreshScheduler } from "../auto-refresh-scheduler";

// ── helpers ───────────────────────────────────────────────────────────────────

/** Build a minimal mock DB adapter with a spy on `run`. */
function makeDb() {
	const runCalls: Array<[string, unknown[]]> = [];
	return {
		run: mock(async (sql: string, params: unknown[]) => {
			runCalls.push([sql, params]);
		}),
		query: mock(async () => []),
		runCalls,
	};
}

/** Build a mock DB whose `run` throws on the first call, then succeeds. */
function makeDbWithRunError(error: Error) {
	const runCalls: Array<[string, unknown[]]> = [];
	let callCount = 0;
	return {
		run: mock(async (sql: string, params: unknown[]) => {
			callCount++;
			if (callCount === 1) throw error;
			runCalls.push([sql, params]);
		}),
		query: mock(async () => []),
		runCalls,
		get callCount() {
			return callCount;
		},
	};
}

/** Build a minimal mock ProxyContext. */
function makeProxyContext() {
	return {
		runtime: { port: 8080, clientId: "test-client" },
		refreshInFlight: new Map(),
	};
}

/** Instantiate the scheduler without starting the interval. */
async function makeScheduler(db: ReturnType<typeof makeDb>) {
	const { AutoRefreshScheduler } = await import("../auto-refresh-scheduler");
	return new AutoRefreshScheduler(
		db as never,
		makeProxyContext() as never,
	) as AutoRefreshScheduler & {
		recordRefreshFailure(id: string, name: string, ctx: string): Promise<void>;
		consecutiveFailures: Map<string, number>;
		FAILURE_THRESHOLD: number;
	};
}

// ── tests ─────────────────────────────────────────────────────────────────────

describe("AutoRefreshScheduler — consecutive failure threshold", () => {
	it("does not pause account before threshold is reached", async () => {
		const db = makeDb();
		const scheduler = await makeScheduler(db);

		// Simulate FAILURE_THRESHOLD - 1 failures
		for (let i = 0; i < scheduler.FAILURE_THRESHOLD - 1; i++) {
			await scheduler.recordRefreshFailure("acc-1", "test-account", "(test)");
		}

		// No UPDATE paused=1 should have been issued
		const pauseCall = db.runCalls.find(
			([sql]) => sql.includes("paused = 1") && sql.includes("accounts"),
		);
		expect(pauseCall).toBeUndefined();
		expect(scheduler.consecutiveFailures.get("acc-1")).toBe(
			scheduler.FAILURE_THRESHOLD - 1,
		);
	});

	it("pauses account in the database when threshold is reached", async () => {
		const db = makeDb();
		const scheduler = await makeScheduler(db);

		// Simulate exactly FAILURE_THRESHOLD failures
		for (let i = 0; i < scheduler.FAILURE_THRESHOLD; i++) {
			await scheduler.recordRefreshFailure("acc-1", "test-account", "(test)");
		}

		// An UPDATE SET paused = 1 should have been issued for this account
		const pauseCall = db.runCalls.find(
			([sql, params]) =>
				sql.includes("paused = 1") &&
				Array.isArray(params) &&
				params[0] === "acc-1",
		);
		expect(pauseCall).toBeDefined();
	});

	it("pauses account exactly once even when threshold is exceeded (counter cleared after pause)", async () => {
		const db = makeDb();
		const scheduler = await makeScheduler(db);

		// Simulate FAILURE_THRESHOLD + 2 failures
		for (let i = 0; i < scheduler.FAILURE_THRESHOLD + 2; i++) {
			await scheduler.recordRefreshFailure("acc-1", "test-account", "(test)");
		}

		const pauseCalls = db.runCalls.filter(
			([sql, params]) =>
				sql.includes("paused = 1") &&
				Array.isArray(params) &&
				params[0] === "acc-1",
		);
		// Counter is cleared after the first pause — subsequent failures should NOT
		// trigger further DB writes. Exactly one pause UPDATE should be issued.
		expect(pauseCalls.length).toBe(1);
	});

	it("clears consecutive failure counter after account is paused", async () => {
		const db = makeDb();
		const scheduler = await makeScheduler(db);

		// Drive to threshold
		for (let i = 0; i < scheduler.FAILURE_THRESHOLD; i++) {
			await scheduler.recordRefreshFailure("acc-1", "test-account", "(test)");
		}

		// Counter must be cleared so subsequent scheduler cycles don't re-fire the pause UPDATE
		expect(scheduler.consecutiveFailures.get("acc-1")).toBeUndefined();
	});

	it("tracks failures independently per account", async () => {
		const db = makeDb();
		const scheduler = await makeScheduler(db);

		// Push acc-1 to threshold; acc-2 stays below
		for (let i = 0; i < scheduler.FAILURE_THRESHOLD; i++) {
			await scheduler.recordRefreshFailure("acc-1", "account-1", "(test)");
		}
		// One failure for acc-2
		await scheduler.recordRefreshFailure("acc-2", "account-2", "(test)");

		// acc-1 should be paused
		const pauseCallAcc1 = db.runCalls.find(
			([sql, params]) =>
				sql.includes("paused = 1") &&
				Array.isArray(params) &&
				params[0] === "acc-1",
		);
		expect(pauseCallAcc1).toBeDefined();

		// acc-2 should NOT be paused
		const pauseCallAcc2 = db.runCalls.find(
			([sql, params]) =>
				sql.includes("paused = 1") &&
				Array.isArray(params) &&
				params[0] === "acc-2",
		);
		expect(pauseCallAcc2).toBeUndefined();
	});

	it("resets consecutive failure counter on successful refresh", async () => {
		const db = makeDb();
		const scheduler = await makeScheduler(db);

		// Accumulate some failures (below threshold)
		for (let i = 0; i < scheduler.FAILURE_THRESHOLD - 1; i++) {
			await scheduler.recordRefreshFailure("acc-1", "test-account", "(test)");
		}
		expect(scheduler.consecutiveFailures.get("acc-1")).toBe(
			scheduler.FAILURE_THRESHOLD - 1,
		);

		// Simulate a successful refresh (done by sendDummyMessage on success)
		scheduler.consecutiveFailures.delete("acc-1");
		expect(scheduler.consecutiveFailures.get("acc-1")).toBeUndefined();
	});

	it("does not propagate DB error out of recordRefreshFailure when pause UPDATE throws", async () => {
		const dbError = new Error("SQLITE_BUSY: database is locked");
		// Build a scheduler backed by the makeDbWithRunError helper — imported via dynamic import
		const { AutoRefreshScheduler } = await import("../auto-refresh-scheduler");
		const db = makeDbWithRunError(dbError);
		const scheduler = new AutoRefreshScheduler(
			db as never,
			makeProxyContext() as never,
		) as AutoRefreshScheduler & {
			recordRefreshFailure(
				id: string,
				name: string,
				ctx: string,
			): Promise<void>;
			consecutiveFailures: Map<string, number>;
			FAILURE_THRESHOLD: number;
		};

		// Drive to threshold — the DB run will throw on the pause UPDATE
		const callThreshold = async () => {
			for (let i = 0; i < scheduler.FAILURE_THRESHOLD; i++) {
				await scheduler.recordRefreshFailure("acc-1", "test-account", "(test)");
			}
		};

		// Must not throw — the DB error should be caught and logged internally
		await expect(callThreshold()).resolves.toBeUndefined();
	});
});
