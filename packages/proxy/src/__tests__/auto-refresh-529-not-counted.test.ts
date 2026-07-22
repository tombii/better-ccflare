/**
 * Regression test: AutoRefreshScheduler must not count a 529 (overloaded_error)
 * probe response toward its consecutive-failure pause threshold.
 *
 * Production incident: a usage-throttled-but-otherwise-healthy account's
 * five_hour window resets, the scheduler probes it, and (before the
 * applyUsageThrottling probe-exemption fix in proxy.ts) gets back our own
 * synthetic 529 from createUsageThrottledResponse. sendDummyMessage treated
 * that 529 exactly like any other non-401 failure and counted it toward
 * FAILURE_THRESHOLD, eventually auto-pausing the account
 * (pause_reason='failure_threshold') even though nothing was actually broken.
 *
 * This test exercises sendDummyMessage's response-status handling directly
 * (mocking global fetch, since the method makes its own internal HTTP call)
 * as defense-in-depth alongside the proxy.ts-level throttle exemption tested
 * in auto-refresh-throttle-exemption.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import type { AutoRefreshScheduler } from "../auto-refresh-scheduler";

// ── helpers ───────────────────────────────────────────────────────────────────

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

function makeProxyContext() {
	return {
		runtime: { port: 8080, clientId: "test-client" },
		refreshInFlight: new Map(),
	};
}

type SendDummyMessageArg = {
	id: string;
	name: string;
	provider: string;
	refresh_token: string;
	access_token: string | null;
	expires_at: number | null;
	rate_limit_reset: number | null;
	custom_endpoint: string | null;
	paused: number;
	auto_pause_on_overage_enabled: number;
	pause_reason: string | null;
};

type TestableScheduler = AutoRefreshScheduler & {
	sendDummyMessage(accountRow: SendDummyMessageArg): Promise<boolean>;
	consecutiveFailures: Map<string, number>;
	FAILURE_THRESHOLD: number;
};

async function makeScheduler(
	db: ReturnType<typeof makeDb>,
): Promise<TestableScheduler> {
	const { AutoRefreshScheduler } = await import("../auto-refresh-scheduler");
	return new AutoRefreshScheduler(
		db as never,
		makeProxyContext() as never,
	) as TestableScheduler;
}

function makeAccountRow(
	overrides: Partial<SendDummyMessageArg> = {},
): SendDummyMessageArg {
	return {
		id: "acc-mb",
		name: "MB",
		provider: "anthropic",
		refresh_token: "refresh-token",
		access_token: "access-token",
		// Beyond the auto-refresh 401/expiry branches — not exercised on the
		// 529/500 failure paths, but kept realistic.
		expires_at: Date.now() + 3 * 60 * 60 * 1000,
		rate_limit_reset: null,
		custom_endpoint: null,
		paused: 0,
		auto_pause_on_overage_enabled: 0,
		pause_reason: null,
		...overrides,
	};
}

function jsonResponse(status: number, body: unknown): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}

let realFetch: typeof fetch;

beforeEach(() => {
	realFetch = globalThis.fetch;
});

afterEach(() => {
	globalThis.fetch = realFetch;
});

// ── tests ─────────────────────────────────────────────────────────────────────

describe("AutoRefreshScheduler.sendDummyMessage — 529 is not a counted failure", () => {
	it("does not increment consecutiveFailures on a 529 overloaded_error probe response", async () => {
		globalThis.fetch = mock(async () =>
			jsonResponse(529, {
				type: "error",
				error: {
					type: "overloaded_error",
					message: "Usage throttling is delaying requests for account(s): MB.",
				},
			}),
		) as unknown as typeof fetch;

		const db = makeDb();
		const scheduler = await makeScheduler(db);
		const accountRow = makeAccountRow();

		const result = await scheduler.sendDummyMessage(accountRow);

		expect(result).toBe(false);
		expect(scheduler.consecutiveFailures.get(accountRow.id)).toBeUndefined();
		const pauseCall = db.runCalls.find(
			([sql]) => sql.includes("paused = 1") && sql.includes("accounts"),
		);
		expect(pauseCall).toBeUndefined();
	});

	it("never pauses the account even after FAILURE_THRESHOLD consecutive 529 probe responses", async () => {
		globalThis.fetch = mock(async () =>
			jsonResponse(529, {
				type: "error",
				error: { type: "overloaded_error", message: "throttled" },
			}),
		) as unknown as typeof fetch;

		const db = makeDb();
		const scheduler = await makeScheduler(db);
		const accountRow = makeAccountRow();

		for (let i = 0; i < scheduler.FAILURE_THRESHOLD + 2; i++) {
			await scheduler.sendDummyMessage(accountRow);
		}

		expect(scheduler.consecutiveFailures.get(accountRow.id)).toBeUndefined();
		const pauseCall = db.runCalls.find(
			([sql, params]) =>
				sql.includes("paused = 1") &&
				Array.isArray(params) &&
				params[0] === accountRow.id,
		);
		expect(pauseCall).toBeUndefined();
	});

	it("control: a genuine (non-529) failure still counts and pauses at FAILURE_THRESHOLD", async () => {
		globalThis.fetch = mock(async () =>
			jsonResponse(500, {
				type: "error",
				error: { type: "api_error", message: "internal server error" },
			}),
		) as unknown as typeof fetch;

		const db = makeDb();
		const scheduler = await makeScheduler(db);
		const accountRow = makeAccountRow();

		for (let i = 0; i < scheduler.FAILURE_THRESHOLD; i++) {
			await scheduler.sendDummyMessage(accountRow);
		}

		expect(scheduler.consecutiveFailures.get(accountRow.id)).toBeUndefined();
		const pauseCall = db.runCalls.find(
			([sql, params]) =>
				sql.includes("paused = 1") &&
				Array.isArray(params) &&
				params[0] === accountRow.id,
		);
		// Counter is cleared by recordRefreshFailure immediately after the pause
		// UPDATE — its absence here (unlike the 529 tests) is only meaningful
		// together with the pause call actually having fired, asserted below.
		expect(pauseCall).toBeDefined();
	});

	it("control: a genuine failure counter is untouched by an intervening 529 (neither incremented nor reset)", async () => {
		const db = makeDb();
		const scheduler = await makeScheduler(db);
		const accountRow = makeAccountRow();

		globalThis.fetch = mock(async () =>
			jsonResponse(500, {
				type: "error",
				error: { type: "api_error", message: "internal server error" },
			}),
		) as unknown as typeof fetch;
		// One genuine failure below threshold.
		for (let i = 0; i < scheduler.FAILURE_THRESHOLD - 1; i++) {
			await scheduler.sendDummyMessage(accountRow);
		}
		expect(scheduler.consecutiveFailures.get(accountRow.id)).toBe(
			scheduler.FAILURE_THRESHOLD - 1,
		);

		// An intervening 529 must not touch the counter at all.
		globalThis.fetch = mock(async () =>
			jsonResponse(529, {
				type: "error",
				error: { type: "overloaded_error", message: "throttled" },
			}),
		) as unknown as typeof fetch;
		await scheduler.sendDummyMessage(accountRow);
		expect(scheduler.consecutiveFailures.get(accountRow.id)).toBe(
			scheduler.FAILURE_THRESHOLD - 1,
		);
	});
});
