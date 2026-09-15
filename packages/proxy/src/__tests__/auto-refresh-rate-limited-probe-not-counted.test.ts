/**
 * Regression test: a probe the proxy refused because the account is
 * rate-limited must not count toward the consecutive-failure pause threshold.
 *
 * Production incident, 2026-09-15. A Codex account had its weekly usage window
 * exhausted (100%, four days to go) while its five-hour window was empty. Every
 * auto-refresh probe came back as the proxy's own 503 ("All accounts failed"),
 * because the only account the probe was allowed to use was benched. Five of
 * those in a row counted as failures and paused the account with
 * pause_reason='failure_threshold'; the 10-minute liveness re-probe was then
 * served by a DIFFERENT account, read as a success, and auto-resumed the Codex
 * account — a cycle that ran for ten hours and 329 probes.
 *
 * A benched account is not a broken endpoint. The scheduler already has a
 * home for a failure it deliberately does not count: recordUncountedProbeFailure,
 * which holds the next probe off on an escalating ladder instead of counting
 * toward a pause that would be wrong anyway.
 *
 * Exercises sendDummyMessage's response-status handling directly (mocking
 * global fetch, since the method makes its own internal HTTP call), modelled on
 * auto-refresh-529-not-counted.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { resetAutoRefreshPromptPoolForTests } from "../auto-refresh-prompt-pool";
import type { AutoRefreshScheduler } from "../auto-refresh-scheduler";

// ── helpers ───────────────────────────────────────────────────────────────────

type RateLimitRow = {
	rate_limited_until: number | null;
	rate_limited_reason: string | null;
};

/**
 * `rateLimitRows` is what the post-failure re-read of the account returns;
 * every other SELECT answers empty, so routing on the SQL text also proves the
 * scheduler asks the question it is supposed to ask.
 */
function makeDb(rateLimitRows: RateLimitRow[] = [], throwOnSelect = false) {
	const runCalls: Array<[string, unknown[]]> = [];
	const queryCalls: Array<[string, unknown[]]> = [];
	return {
		run: mock(async (sql: string, params: unknown[]) => {
			runCalls.push([sql, params]);
		}),
		query: mock(async (sql: string, params: unknown[] = []) => {
			queryCalls.push([sql, params]);
			if (sql.includes("rate_limited_until") && sql.includes("FROM accounts")) {
				if (throwOnSelect) throw new Error("database is locked");
				return rateLimitRows;
			}
			return [];
		}),
		runCalls,
		queryCalls,
	};
}

function makeProxyContext() {
	return {
		runtime: { port: 8080, clientId: "test-client" },
		refreshInFlight: new Map(),
		internalProbeSecret: "secret",
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
	uncountedProbeFailures: Map<string, { at: number; streak: number }>;
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
		id: "acc-codex",
		name: "Codex",
		provider: "codex",
		refresh_token: "refresh-token",
		access_token: "access-token",
		expires_at: Date.now() + 3 * 60 * 60 * 1000,
		rate_limit_reset: null,
		custom_endpoint: null,
		paused: 0,
		auto_pause_on_overage_enabled: 0,
		pause_reason: null,
		...overrides,
	};
}

/** What the proxy answers a probe for an account it has no route for. */
function respondPoolExhausted(): void {
	globalThis.fetch = mock(
		async () =>
			new Response(
				JSON.stringify({
					type: "error",
					error: {
						type: "api_error",
						message: "All accounts failed to handle the request",
					},
				}),
				{
					status: 503,
					statusText: "Service Unavailable",
					headers: { "content-type": "application/json" },
				},
			),
	) as unknown as typeof fetch;
}

function pauseCallFor(
	db: ReturnType<typeof makeDb>,
	accountId: string,
): [string, unknown[]] | undefined {
	return db.runCalls.find(
		([sql, params]) =>
			sql.includes("paused = 1") &&
			Array.isArray(params) &&
			params[0] === accountId,
	);
}

const HOUR = 60 * 60 * 1000;

let realFetch: typeof fetch;

beforeEach(() => {
	realFetch = globalThis.fetch;
	resetAutoRefreshPromptPoolForTests();
});

afterEach(() => {
	globalThis.fetch = realFetch;
	resetAutoRefreshPromptPoolForTests();
});

// ── tests ─────────────────────────────────────────────────────────────────────

describe("AutoRefreshScheduler.sendDummyMessage — a refusal while rate-limited is not counted", () => {
	it("does not increment consecutiveFailures when the account is benched", async () => {
		respondPoolExhausted();
		const db = makeDb([
			{
				rate_limited_until: Date.now() + HOUR,
				rate_limited_reason: "model_fallback_429",
			},
		]);
		const scheduler = await makeScheduler(db);
		const accountRow = makeAccountRow();

		const result = await scheduler.sendDummyMessage(accountRow);

		expect(result).toBe(false);
		expect(scheduler.consecutiveFailures.get(accountRow.id)).toBeUndefined();
		expect(pauseCallFor(db, accountRow.id)).toBeUndefined();
	});

	it("holds the next probe off on the uncounted-failure ladder instead", async () => {
		respondPoolExhausted();
		const db = makeDb([
			{
				rate_limited_until: Date.now() + HOUR,
				rate_limited_reason: "model_fallback_429",
			},
		]);
		const scheduler = await makeScheduler(db);
		const accountRow = makeAccountRow();

		await scheduler.sendDummyMessage(accountRow);

		// Not counted means never paused, which on its own would leave the account
		// eligible again on the very next 60s tick — this is what stops the loop.
		expect(scheduler.uncountedProbeFailures.get(accountRow.id)?.streak).toBe(1);
	});

	it("never pauses the account however many refusals it collects", async () => {
		respondPoolExhausted();
		const db = makeDb([
			{
				rate_limited_until: Date.now() + HOUR,
				rate_limited_reason: "model_fallback_429",
			},
		]);
		const scheduler = await makeScheduler(db);
		const accountRow = makeAccountRow();

		for (let i = 0; i < scheduler.FAILURE_THRESHOLD + 2; i++) {
			await scheduler.sendDummyMessage(accountRow);
		}

		expect(scheduler.consecutiveFailures.get(accountRow.id)).toBeUndefined();
		expect(pauseCallFor(db, accountRow.id)).toBeUndefined();
	});

	it("re-reads the account's own rate-limit state rather than trusting the row it was handed", async () => {
		respondPoolExhausted();
		const db = makeDb([
			{
				rate_limited_until: Date.now() + HOUR,
				rate_limited_reason: "model_fallback_429",
			},
		]);
		const scheduler = await makeScheduler(db);
		const accountRow = makeAccountRow();

		await scheduler.sendDummyMessage(accountRow);

		const select = db.queryCalls.find(([sql]) =>
			sql.includes("rate_limited_until"),
		);
		expect(select).toBeDefined();
		expect(select?.[1]).toEqual([accountRow.id]);
	});

	it("control: a failure with no bench on the account still counts", async () => {
		respondPoolExhausted();
		const db = makeDb([
			{ rate_limited_until: null, rate_limited_reason: null },
		]);
		const scheduler = await makeScheduler(db);
		const accountRow = makeAccountRow();

		await scheduler.sendDummyMessage(accountRow);

		expect(scheduler.consecutiveFailures.get(accountRow.id)).toBe(1);
		expect(scheduler.uncountedProbeFailures.has(accountRow.id)).toBe(false);
	});

	it("control: a bench that has already expired still counts", async () => {
		respondPoolExhausted();
		const db = makeDb([
			{
				rate_limited_until: Date.now() - HOUR,
				rate_limited_reason: "rate_limit_429",
			},
		]);
		const scheduler = await makeScheduler(db);
		const accountRow = makeAccountRow();

		await scheduler.sendDummyMessage(accountRow);

		expect(scheduler.consecutiveFailures.get(accountRow.id)).toBe(1);
	});

	it("control: no row at all still counts", async () => {
		respondPoolExhausted();
		const db = makeDb([]);
		const scheduler = await makeScheduler(db);
		const accountRow = makeAccountRow();

		await scheduler.sendDummyMessage(accountRow);

		expect(scheduler.consecutiveFailures.get(accountRow.id)).toBe(1);
	});

	it("control: a database hiccup on the re-read must not skip the accounting", async () => {
		respondPoolExhausted();
		const db = makeDb([], true);
		const scheduler = await makeScheduler(db);
		const accountRow = makeAccountRow();

		await scheduler.sendDummyMessage(accountRow);

		expect(scheduler.consecutiveFailures.get(accountRow.id)).toBe(1);
	});

	it("control: a 529 is still handled by its own branch, without the re-read", async () => {
		globalThis.fetch = mock(
			async () =>
				new Response(
					JSON.stringify({
						type: "error",
						error: { type: "overloaded_error", message: "throttled" },
					}),
					{ status: 529, headers: { "content-type": "application/json" } },
				),
		) as unknown as typeof fetch;
		const db = makeDb([]);
		const scheduler = await makeScheduler(db);
		const accountRow = makeAccountRow();

		await scheduler.sendDummyMessage(accountRow);

		expect(scheduler.consecutiveFailures.get(accountRow.id)).toBeUndefined();
		expect(
			db.queryCalls.find(([sql]) => sql.includes("rate_limited_until")),
		).toBeUndefined();
	});
});
