/**
 * The cooldown for probe failures the scheduler deliberately does not count.
 *
 * Two outcomes never reach recordRefreshFailure: a 529 (overloaded/throttled,
 * exempted on purpose so a healthy-but-throttled account is not auto-paused)
 * and a request that never produced a response at all. Neither pauses the
 * account, so neither slows the next attempt down — the account is eligible
 * again on the following 60s tick, and stays that way for as long as the
 * condition lasts.
 *
 * That is not merely a wasted request. Every probe claims a prompt from the pool
 * shared by all accounts and locks it for 24 hours, and a prompt that has been
 * sent cannot be handed back. One account looping at a probe a minute would
 * therefore drain all 500 prompts in a little over eight hours and stop every
 * other account from refreshing until the locks expired.
 *
 * These tests pin the cooldown that closes that: the uncounted failures hold the
 * account off for FAILURE_PROBE_COOLDOWN_MS, a success clears it immediately,
 * and the failures that *are* counted keep going through the pause threshold
 * untouched.
 */
import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import {
	AUTO_REFRESH_PROMPTS,
	autoRefreshPromptPoolStatus,
	resetAutoRefreshPromptPoolForTests,
} from "../auto-refresh-prompt-pool";
import type { AutoRefreshScheduler } from "../auto-refresh-scheduler";

type AccountRow = {
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
	sendDummyMessage(accountRow: AccountRow): Promise<boolean>;
	shouldRefreshAccount(account: AccountRow, now: number): boolean;
	consecutiveFailures: Map<string, number>;
	lastUncountedProbeFailureAt: Map<string, number>;
	FAILURE_PROBE_COOLDOWN_MS: number;
};

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

function makeAccountRow(overrides: Partial<AccountRow> = {}): AccountRow {
	return {
		id: "acc-1",
		name: "account-one",
		provider: "anthropic",
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

async function makeScheduler(
	db: ReturnType<typeof makeDb>,
): Promise<TestableScheduler> {
	const { AutoRefreshScheduler } = await import("../auto-refresh-scheduler");
	return new AutoRefreshScheduler(
		db as never,
		{
			runtime: { port: 8080, clientId: "test-client" },
			refreshInFlight: new Map(),
			internalProbeSecret: "secret",
			dbOps: { recordUsageSnapshot: mock(async () => {}) },
		} as never,
	) as TestableScheduler;
}

/** Answer every probe with the given status. */
function respondWith(status: number): void {
	globalThis.fetch = mock(async () => {
		return new Response(JSON.stringify({ ok: status < 400 }), {
			status,
			headers: { "content-type": "application/json" },
		});
	}) as unknown as typeof fetch;
}

/** Fail every probe before a response exists. */
function failBeforeResponse(): void {
	globalThis.fetch = mock(async () => {
		throw new Error("connection refused");
	}) as unknown as typeof fetch;
}

const realFetch = globalThis.fetch;

beforeEach(() => {
	globalThis.fetch = realFetch;
	resetAutoRefreshPromptPoolForTests();
});

afterEach(() => {
	globalThis.fetch = realFetch;
	resetAutoRefreshPromptPoolForTests();
});

describe("AutoRefreshScheduler — cooldown after an uncounted probe failure", () => {
	it("holds the account off after a 529, which never pauses it", async () => {
		respondWith(529);
		const scheduler = await makeScheduler(makeDb());
		const accountRow = makeAccountRow();

		expect(await scheduler.sendDummyMessage(accountRow)).toBe(false);

		// The exemption is intact: a 529 still does not count toward the pause
		// threshold. Without the cooldown that is exactly what left the account
		// eligible every 60s.
		expect(scheduler.consecutiveFailures.get(accountRow.id)).toBeUndefined();

		const now = Date.now();
		expect(scheduler.shouldRefreshAccount(accountRow, now + 60_000)).toBe(
			false,
		);
	});

	it("lets the account through once the cooldown elapses", async () => {
		respondWith(529);
		const scheduler = await makeScheduler(makeDb());
		const accountRow = makeAccountRow();

		await scheduler.sendDummyMessage(accountRow);

		const after =
			Date.now() + scheduler.FAILURE_PROBE_COOLDOWN_MS + 60 * 60 * 1000;
		expect(scheduler.shouldRefreshAccount(accountRow, after)).toBe(true);
	});

	it("holds the account off when no response arrived at all", async () => {
		failBeforeResponse();
		const scheduler = await makeScheduler(makeDb());
		const accountRow = makeAccountRow();

		expect(await scheduler.sendDummyMessage(accountRow)).toBe(false);

		expect(scheduler.lastUncountedProbeFailureAt.has(accountRow.id)).toBe(true);
		expect(scheduler.shouldRefreshAccount(accountRow, Date.now())).toBe(false);
	});

	it("clears the cooldown on the first probe that succeeds", async () => {
		const scheduler = await makeScheduler(makeDb());
		const accountRow = makeAccountRow();

		respondWith(529);
		await scheduler.sendDummyMessage(accountRow);
		expect(scheduler.lastUncountedProbeFailureAt.has(accountRow.id)).toBe(true);

		respondWith(200);
		expect(await scheduler.sendDummyMessage(accountRow)).toBe(true);

		// A window that rolls over right after a good probe must be picked up on
		// the tick it happens, not up to a cooldown later.
		expect(scheduler.lastUncountedProbeFailureAt.has(accountRow.id)).toBe(
			false,
		);
		expect(scheduler.shouldRefreshAccount(accountRow, Date.now())).toBe(true);
	});

	it("leaves counted failures on the pause threshold, with no cooldown of their own", async () => {
		respondWith(500);
		const scheduler = await makeScheduler(makeDb());
		const accountRow = makeAccountRow();

		expect(await scheduler.sendDummyMessage(accountRow)).toBe(false);

		// A 500 is a real failure: it counts, and five of them pause the account.
		// That path already bounds itself, so it must not be slowed down here.
		expect(scheduler.consecutiveFailures.get(accountRow.id)).toBe(1);
		expect(scheduler.lastUncountedProbeFailureAt.has(accountRow.id)).toBe(
			false,
		);
		expect(scheduler.shouldRefreshAccount(accountRow, Date.now())).toBe(true);
	});

	it("keeps one account's cooldown to itself", async () => {
		respondWith(529);
		const scheduler = await makeScheduler(makeDb());
		const throttled = makeAccountRow({ id: "acc-1" });
		const healthy = makeAccountRow({ id: "acc-2", name: "account-two" });

		await scheduler.sendDummyMessage(throttled);

		expect(scheduler.shouldRefreshAccount(throttled, Date.now())).toBe(false);
		expect(scheduler.shouldRefreshAccount(healthy, Date.now())).toBe(true);
	});
});

describe("AutoRefreshScheduler — what the cooldown is protecting", () => {
	it("spends one prompt per uncounted failure, and cannot get it back", async () => {
		respondWith(529);
		const scheduler = await makeScheduler(makeDb());
		const accountRow = makeAccountRow();

		expect(autoRefreshPromptPoolStatus().free).toBe(
			AUTO_REFRESH_PROMPTS.length,
		);

		await scheduler.sendDummyMessage(accountRow);

		// The text was sent, so the prompt stays locked: this is the cost the
		// cooldown exists to ration. At a probe a minute the pool would be dry in
		// a little over eight hours.
		expect(autoRefreshPromptPoolStatus().free).toBe(
			AUTO_REFRESH_PROMPTS.length - 1,
		);
	});
});
