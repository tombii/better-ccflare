/**
 * The escalating backoff for probe failures the scheduler deliberately does not
 * count.
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
 * The wait is a ladder — 1m, 5m, 10m, 30m, 1h, 6h, 12h — because the two ends
 * want opposite things: a single blip should cost a minute, and an account that
 * has been failing all day should be asked twice a day. These tests pin the
 * climb, the ceiling, the reset on success, and the fact that the failures which
 * *are* counted keep going through the pause threshold untouched.
 */
import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import {
	clearAllProbeBackoff,
	isProbeBackedOff,
	PROBE_BACKOFF_PENALTY_THRESHOLD_MS,
} from "@better-ccflare/core";
import {
	AUTO_REFRESH_PROMPTS,
	autoRefreshPromptPoolStatus,
	claimAutoRefreshPrompt,
	PROMPT_COOLDOWN_MS,
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
	uncountedProbeFailures: Map<string, { at: number; streak: number }>;
	UNCOUNTED_FAILURE_BACKOFF_MS: readonly number[];
};

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

/** The rungs, spelled out here rather than read from the scheduler. */
const LADDER = [
	1 * MINUTE,
	5 * MINUTE,
	10 * MINUTE,
	30 * MINUTE,
	1 * HOUR,
	6 * HOUR,
	12 * HOUR,
];

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
		expires_at: Date.now() + 3 * HOUR,
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

/**
 * Where the account stands right now. Reading the recorded timestamp rather
 * than Date.now() keeps the assertions exact regardless of how long the probes
 * themselves took.
 */
function backoff(
	scheduler: TestableScheduler,
	accountRow: AccountRow,
): { at: number; streak: number } {
	const entry = scheduler.uncountedProbeFailures.get(accountRow.id);
	if (!entry) throw new Error("no uncounted failure recorded");
	return entry;
}

const realFetch = globalThis.fetch;

beforeEach(() => {
	globalThis.fetch = realFetch;
	resetAutoRefreshPromptPoolForTests();
	clearAllProbeBackoff();
});

afterEach(() => {
	globalThis.fetch = realFetch;
	resetAutoRefreshPromptPoolForTests();
	clearAllProbeBackoff();
});

describe("AutoRefreshScheduler — the uncounted-failure ladder", () => {
	it("holds the account off for a minute after a 529, which never pauses it", async () => {
		respondWith(529);
		const scheduler = await makeScheduler(makeDb());
		const accountRow = makeAccountRow();

		expect(await scheduler.sendDummyMessage(accountRow)).toBe(false);

		// The exemption is intact: a 529 still does not count toward the pause
		// threshold. Without the backoff that is exactly what left the account
		// eligible every 60s.
		expect(scheduler.consecutiveFailures.get(accountRow.id)).toBeUndefined();

		const { at, streak } = backoff(scheduler, accountRow);
		expect(streak).toBe(1);
		expect(scheduler.shouldRefreshAccount(accountRow, at + 30 * 1000)).toBe(
			false,
		);
		expect(scheduler.shouldRefreshAccount(accountRow, at + LADDER[0] + 1)).toBe(
			true,
		);
	});

	it("climbs one rung per consecutive failure", async () => {
		respondWith(529);
		const scheduler = await makeScheduler(makeDb());
		const accountRow = makeAccountRow();

		for (let streak = 1; streak <= LADDER.length; streak++) {
			await scheduler.sendDummyMessage(accountRow);

			const entry = backoff(scheduler, accountRow);
			expect(entry.streak).toBe(streak);

			// Just inside its own rung it waits; just outside it goes.
			const rung = LADDER[streak - 1];
			expect(
				scheduler.shouldRefreshAccount(accountRow, entry.at + rung - 1),
			).toBe(false);
			expect(
				scheduler.shouldRefreshAccount(accountRow, entry.at + rung + 1),
			).toBe(true);
		}
	});

	it("stops climbing at twelve hours instead of growing forever", async () => {
		respondWith(529);
		const scheduler = await makeScheduler(makeDb());
		const accountRow = makeAccountRow();

		// Well past the end of the ladder.
		for (let i = 0; i < LADDER.length + 5; i++) {
			await scheduler.sendDummyMessage(accountRow);
		}

		const { at, streak } = backoff(scheduler, accountRow);
		expect(streak).toBe(LADDER.length + 5);

		const top = LADDER[LADDER.length - 1];
		expect(top).toBe(12 * HOUR);
		expect(scheduler.shouldRefreshAccount(accountRow, at + top - MINUTE)).toBe(
			false,
		);
		expect(scheduler.shouldRefreshAccount(accountRow, at + top + MINUTE)).toBe(
			true,
		);
	});

	it("holds the account off when no response arrived at all", async () => {
		failBeforeResponse();
		const scheduler = await makeScheduler(makeDb());
		const accountRow = makeAccountRow();

		expect(await scheduler.sendDummyMessage(accountRow)).toBe(false);

		expect(backoff(scheduler, accountRow).streak).toBe(1);
		expect(scheduler.shouldRefreshAccount(accountRow, Date.now())).toBe(false);
	});

	it("drops back to the bottom rung after a probe that succeeds", async () => {
		const scheduler = await makeScheduler(makeDb());
		const accountRow = makeAccountRow();

		respondWith(529);
		for (let i = 0; i < 3; i++) {
			await scheduler.sendDummyMessage(accountRow);
		}
		expect(backoff(scheduler, accountRow).streak).toBe(3);

		respondWith(200);
		expect(await scheduler.sendDummyMessage(accountRow)).toBe(true);

		// A window that rolls over right after a good probe must be picked up on
		// the tick it happens, not up to a rung later.
		expect(scheduler.uncountedProbeFailures.has(accountRow.id)).toBe(false);
		expect(scheduler.shouldRefreshAccount(accountRow, Date.now())).toBe(true);

		// And a later blip costs a minute again — it does not resume the climb
		// from where the last bad spell ended.
		respondWith(529);
		await scheduler.sendDummyMessage(accountRow);
		const entry = backoff(scheduler, accountRow);
		expect(entry.streak).toBe(1);
		expect(
			scheduler.shouldRefreshAccount(accountRow, entry.at + LADDER[0] + 1),
		).toBe(true);
	});

	it("leaves counted failures on the pause threshold, with no backoff of their own", async () => {
		respondWith(500);
		const scheduler = await makeScheduler(makeDb());
		const accountRow = makeAccountRow();

		expect(await scheduler.sendDummyMessage(accountRow)).toBe(false);

		// A 500 is a real failure: it counts, and five of them pause the account.
		// That path already bounds itself, so it must not be slowed down here.
		expect(scheduler.consecutiveFailures.get(accountRow.id)).toBe(1);
		expect(scheduler.uncountedProbeFailures.has(accountRow.id)).toBe(false);
		expect(scheduler.shouldRefreshAccount(accountRow, Date.now())).toBe(true);
	});

	it("keeps one account's streak to itself", async () => {
		respondWith(529);
		const scheduler = await makeScheduler(makeDb());
		const throttled = makeAccountRow({ id: "acc-1" });
		const healthy = makeAccountRow({ id: "acc-2", name: "account-two" });

		await scheduler.sendDummyMessage(throttled);
		await scheduler.sendDummyMessage(throttled);

		expect(backoff(scheduler, throttled).streak).toBe(2);
		expect(scheduler.uncountedProbeFailures.has(healthy.id)).toBe(false);
		expect(scheduler.shouldRefreshAccount(throttled, Date.now())).toBe(false);
		expect(scheduler.shouldRefreshAccount(healthy, Date.now())).toBe(true);
	});
});

describe("AutoRefreshScheduler — what the ladder is protecting", () => {
	it("spends one prompt per uncounted failure, and cannot get it back", async () => {
		respondWith(529);
		const scheduler = await makeScheduler(makeDb());
		const accountRow = makeAccountRow();

		expect(autoRefreshPromptPoolStatus().free).toBe(
			AUTO_REFRESH_PROMPTS.length,
		);

		await scheduler.sendDummyMessage(accountRow);

		// The text was sent, so the prompt stays locked: this is the cost the
		// ladder exists to ration. At a probe a minute the pool would be dry in a
		// little over eight hours.
		expect(autoRefreshPromptPoolStatus().free).toBe(
			AUTO_REFRESH_PROMPTS.length - 1,
		);
	});

	it("matches the scheduler's own ladder, and keeps it climbing to a ceiling", async () => {
		const scheduler = await makeScheduler(makeDb());
		const ladder = scheduler.UNCOUNTED_FAILURE_BACKOFF_MS;

		expect([...ladder]).toEqual(LADDER);
		for (let i = 1; i < ladder.length; i++) {
			expect(ladder[i]).toBeGreaterThan(ladder[i - 1]);
		}

		// The rung a chronic failure settles on is what bounds the steady state,
		// because a claim is released after PROMPT_COOLDOWN_MS rather than held
		// forever: what has to fit in the pool is the probes alive inside one
		// 24-hour window, not every probe ever sent.
		const top = ladder[ladder.length - 1];
		expect(PROMPT_COOLDOWN_MS / top).toBeLessThan(AUTO_REFRESH_PROMPTS.length);
	});

	it("keeps a permanently failing account well inside the pool for a week", async () => {
		const scheduler = await makeScheduler(makeDb());
		const ladder = scheduler.UNCOUNTED_FAILURE_BACKOFF_MS;
		const start = 1_700_000_000_000;
		const week = 7 * 24 * HOUR;

		// Walk the ladder the way the scheduler would for an account that never
		// recovers, claiming a prompt per probe. Shortening the rungs or shrinking
		// the pool fails here instead of in production.
		let claims = 0;
		let streak = 0;
		for (let t = start; t < start + week; ) {
			expect(claimAutoRefreshPrompt(t).ok).toBe(true);
			claims++;
			streak++;
			t += ladder[Math.min(streak, ladder.length) - 1];
		}

		// A flat one-minute retry would have wanted 10,080 prompts for the same
		// week and dried the pool on the first day.
		expect(claims).toBeLessThan(30);
		expect(autoRefreshPromptPoolStatus(start + week).free).toBeGreaterThan(
			AUTO_REFRESH_PROMPTS.length - 10,
		);
	});
});

describe("AutoRefreshScheduler — the ladder's effect on the queue", () => {
	it("leaves the queue alone while the wait is still short", async () => {
		respondWith(529);
		const scheduler = await makeScheduler(makeDb());
		const accountRow = makeAccountRow();

		// The rungs below an hour: a blip, provider turbulence, nothing that says
		// anything about live traffic. The account keeps its place.
		for (let i = 0; i < 4; i++) {
			await scheduler.sendDummyMessage(accountRow);
			expect(LADDER[backoff(scheduler, accountRow).streak - 1]).toBeLessThan(
				PROBE_BACKOFF_PENALTY_THRESHOLD_MS,
			);
			expect(isProbeBackedOff(accountRow.id)).toBe(false);
		}
	});

	it("deprioritises the account once the wait reaches an hour", async () => {
		respondWith(529);
		const scheduler = await makeScheduler(makeDb());
		const accountRow = makeAccountRow();

		for (let i = 0; i < 5; i++) {
			await scheduler.sendDummyMessage(accountRow);
		}

		const { at, streak } = backoff(scheduler, accountRow);
		expect(LADDER[streak - 1]).toBe(PROBE_BACKOFF_PENALTY_THRESHOLD_MS);
		expect(isProbeBackedOff(accountRow.id)).toBe(true);

		// The penalty expires with the rung that earned it, not later.
		expect(isProbeBackedOff(accountRow.id, at + LADDER[streak - 1] + 1)).toBe(
			false,
		);
	});

	it("keeps the account deprioritised for as long as the top rung lasts", async () => {
		respondWith(529);
		const scheduler = await makeScheduler(makeDb());
		const accountRow = makeAccountRow();

		for (let i = 0; i < LADDER.length; i++) {
			await scheduler.sendDummyMessage(accountRow);
		}

		const { at } = backoff(scheduler, accountRow);
		expect(isProbeBackedOff(accountRow.id, at + 11 * HOUR)).toBe(true);
		expect(isProbeBackedOff(accountRow.id, at + 13 * HOUR)).toBe(false);
	});

	it("gives the account its place back on the first successful probe", async () => {
		const scheduler = await makeScheduler(makeDb());
		const accountRow = makeAccountRow();

		respondWith(529);
		for (let i = 0; i < 5; i++) {
			await scheduler.sendDummyMessage(accountRow);
		}
		expect(isProbeBackedOff(accountRow.id)).toBe(true);

		respondWith(200);
		expect(await scheduler.sendDummyMessage(accountRow)).toBe(true);

		// One good probe is enough — the account is not made to serve out the
		// remaining hours of a penalty it has already disproved.
		expect(isProbeBackedOff(accountRow.id)).toBe(false);
	});

	it("penalises only the account that failed", async () => {
		respondWith(529);
		const scheduler = await makeScheduler(makeDb());
		const throttled = makeAccountRow({ id: "acc-1" });
		const healthy = makeAccountRow({ id: "acc-2", name: "account-two" });

		for (let i = 0; i < 5; i++) {
			await scheduler.sendDummyMessage(throttled);
		}

		expect(isProbeBackedOff(throttled.id)).toBe(true);
		expect(isProbeBackedOff(healthy.id)).toBe(false);
	});
});
