/**
 * The scheduler must not probe an account whose usage window is already
 * exhausted.
 *
 * Production incident, 2026-09-15. A Codex account's WEEKLY window was at 100%
 * with four days left to run, while its five-hour window sat empty. The
 * scheduler probed it every minute for ten hours. Two things let it:
 *
 * - The account's `rate_limit_reset` (the five-hour window) was in the past, so
 *   the eligibility SQL and shouldRefreshAccount both said "new window, go".
 * - `rate_limited_until` could never hold it: applyRateLimitCooldown clamps
 *   every ordinary 429 bench to min(resetTime, now + backoff) on a 30s→5min
 *   ramp, so even a correctly parsed four-day reset only benches the account
 *   for minutes at a time.
 *
 * The long exclusion of an exhausted account is the usage-aware strategy's job
 * — isUsageExhausted over the poller's snapshot — and the scheduler is the one
 * caller that bypasses it, because the selector's usage-cap gate is deliberately
 * opened for forced probes. So the scheduler has to apply the same check itself.
 *
 * These tests call the private shouldRefreshAccount through a testable cast,
 * the way auto-refresh-uncounted-failure-cooldown.test.ts does.
 */
import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { logBus } from "@better-ccflare/logger";
import { usageCache } from "@better-ccflare/providers";
import type { LogEvent } from "@better-ccflare/types";
import type { AutoRefreshScheduler } from "../auto-refresh-scheduler";

// ── helpers ───────────────────────────────────────────────────────────────────

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
	shouldRefreshAccount(account: AccountRow, now: number): boolean;
	usageExhaustedAnnouncedFor: Map<string, number>;
	lastFailureProbeAt: Map<string, number>;
	clearAccountTracking(accountId: string): void;
};

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

const ACCOUNT_ID = "acc-codex";

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
		} as never,
	) as TestableScheduler;
}

function makeAccountRow(overrides: Partial<AccountRow> = {}): AccountRow {
	return {
		id: ACCOUNT_ID,
		name: "Codex",
		provider: "codex",
		refresh_token: "refresh-token",
		access_token: "access-token",
		expires_at: Date.now() + 3 * HOUR,
		// The five-hour window has rolled over — this is exactly what made the
		// account look refreshable every single minute.
		rate_limit_reset: Date.now() - HOUR,
		custom_endpoint: null,
		paused: 0,
		auto_pause_on_overage_enabled: 0,
		pause_reason: null,
		...overrides,
	};
}

/** The shape the Codex/Anthropic usage poller caches: flat windows with ISO resets. */
function snapshot(
	windows: Record<string, { util: number; resetsAt: number | null }>,
) {
	const out: Record<string, unknown> = {};
	for (const [name, { util, resetsAt }] of Object.entries(windows)) {
		out[name] = {
			utilization: util,
			resets_at: resetsAt === null ? null : new Date(resetsAt).toISOString(),
		};
	}
	return out;
}

/** The weekly window is spent; the five-hour one is wide open. */
function exhaustedWeekly(now: number) {
	return snapshot({
		five_hour: { util: 0, resetsAt: now + HOUR },
		seven_day: { util: 100, resetsAt: now + 4 * DAY },
	});
}

/** Collect the INFO lines the scheduler puts on the log bus during `fn`. */
async function infoLines(fn: () => void | Promise<void>): Promise<string[]> {
	const lines: string[] = [];
	const listener = (event: LogEvent) => {
		if (event.level === "INFO") lines.push(event.msg);
	};
	logBus.on("log", listener);
	try {
		await fn();
	} finally {
		logBus.off("log", listener);
	}
	return lines;
}

afterEach(() => {
	usageCache.delete(ACCOUNT_ID);
});

beforeEach(() => {
	usageCache.delete(ACCOUNT_ID);
});

// ── tests ─────────────────────────────────────────────────────────────────────

describe("AutoRefreshScheduler.shouldRefreshAccount — an exhausted usage window", () => {
	it("skips a codex account whose weekly window is spent, even on its first probe", async () => {
		const now = Date.now();
		const scheduler = await makeScheduler(makeDb());
		usageCache.set(ACCOUNT_ID, exhaustedWeekly(now) as never);

		// Without the snapshot this account is a textbook "First-time refresh".
		expect(scheduler.shouldRefreshAccount(makeAccountRow(), now)).toBe(false);
	});

	it("probes the same account once the cache has no snapshot for it", async () => {
		const now = Date.now();
		const scheduler = await makeScheduler(makeDb());

		expect(scheduler.shouldRefreshAccount(makeAccountRow(), now)).toBe(true);
	});

	it("probes when a 100% reading pairs with a reset that has already passed", async () => {
		const now = Date.now();
		const scheduler = await makeScheduler(makeDb());
		// The poller lags by up to ten minutes: a stale 100% whose window has
		// since rolled over must not bench the account forever.
		usageCache.set(
			ACCOUNT_ID,
			snapshot({
				five_hour: { util: 0, resetsAt: now + HOUR },
				seven_day: { util: 100, resetsAt: now - HOUR },
			}) as never,
		);

		expect(scheduler.shouldRefreshAccount(makeAccountRow(), now)).toBe(true);
	});

	it("probes at 99% — the rule is exhaustion, not near-exhaustion", async () => {
		const now = Date.now();
		const scheduler = await makeScheduler(makeDb());
		usageCache.set(
			ACCOUNT_ID,
			snapshot({
				five_hour: { util: 0, resetsAt: now + HOUR },
				seven_day: { util: 99, resetsAt: now + 4 * DAY },
			}) as never,
		);

		expect(scheduler.shouldRefreshAccount(makeAccountRow(), now)).toBe(true);
	});

	it("applies to anthropic accounts and to the five-hour window too", async () => {
		const now = Date.now();
		const scheduler = await makeScheduler(makeDb());
		usageCache.set(
			ACCOUNT_ID,
			snapshot({
				five_hour: { util: 100, resetsAt: now + 2 * HOUR },
				seven_day: { util: 40, resetsAt: now + 4 * DAY },
			}) as never,
		);

		expect(
			scheduler.shouldRefreshAccount(
				makeAccountRow({ provider: "anthropic", name: "Fabian" }),
				now,
			),
		).toBe(false);
	});

	it("probes a zai account whose winning window has already reset", async () => {
		// Greptile P1 on PR #468: the gate used to take zai's utilization from
		// max(time_limit, tokens_limit, tokens_limit_weekly) but its reset from
		// the winning TOKEN window only. A stale 100% time_limit whose reset has
		// passed then paired with a future tokens_limit reset, so the staleness
		// guard could not clear it and valid probes stayed suppressed until an
		// unrelated window reset.
		const now = Date.now();
		const scheduler = await makeScheduler(makeDb());
		usageCache.set(ACCOUNT_ID, {
			time_limit: {
				used: 100,
				remaining: 0,
				percentage: 100,
				resetAt: now - HOUR,
				type: "time_limit",
			},
			tokens_limit: {
				used: 40,
				remaining: 60,
				percentage: 40,
				resetAt: now + 2 * HOUR,
				type: "tokens_limit",
			},
			tokens_limit_weekly: null,
		} as never);

		expect(
			scheduler.shouldRefreshAccount(
				makeAccountRow({ provider: "zai", name: "Zai" }),
				now,
			),
		).toBe(true);
	});

	it("also skips the 10-minute liveness re-probe of a failure_threshold pause", async () => {
		const now = Date.now();
		const scheduler = await makeScheduler(makeDb());
		const account = makeAccountRow({ pause_reason: "failure_threshold" });

		// That branch returns true unconditionally once its cooldown has elapsed,
		// and its "success" is what auto-resumed the account in the incident.
		expect(scheduler.shouldRefreshAccount(account, now)).toBe(true);

		usageCache.set(ACCOUNT_ID, exhaustedWeekly(now) as never);
		expect(scheduler.shouldRefreshAccount(account, now)).toBe(false);
	});

	it("does not write to the database or touch any counter", async () => {
		const now = Date.now();
		const db = makeDb();
		const scheduler = await makeScheduler(db);
		usageCache.set(ACCOUNT_ID, exhaustedWeekly(now) as never);

		scheduler.shouldRefreshAccount(makeAccountRow(), now);

		expect(db.runCalls).toHaveLength(0);
		expect(scheduler.lastFailureProbeAt.has(ACCOUNT_ID)).toBe(false);
	});
});

describe("AutoRefreshScheduler — announcing an exhausted window", () => {
	it("says it once per reset rather than once per minute for four days", async () => {
		const now = Date.now();
		const scheduler = await makeScheduler(makeDb());
		usageCache.set(ACCOUNT_ID, exhaustedWeekly(now) as never);
		const account = makeAccountRow();

		const lines = await infoLines(() => {
			for (let i = 0; i < 5; i++) {
				scheduler.shouldRefreshAccount(account, now + i * 60_000);
			}
		});

		const announcements = lines.filter((line) =>
			line.includes("usage window is exhausted"),
		);
		expect(announcements).toHaveLength(1);
		expect(announcements[0]).toContain("Codex");
		expect(announcements[0]).toContain("(100%)");
		expect(announcements[0]).toContain(new Date(now + 4 * DAY).toISOString());
	});

	it("says it again when the account is exhausted into a different window", async () => {
		const now = Date.now();
		const scheduler = await makeScheduler(makeDb());
		const account = makeAccountRow();

		usageCache.set(ACCOUNT_ID, exhaustedWeekly(now) as never);
		await infoLines(() => scheduler.shouldRefreshAccount(account, now));

		usageCache.set(
			ACCOUNT_ID,
			snapshot({
				five_hour: { util: 0, resetsAt: now + HOUR },
				seven_day: { util: 100, resetsAt: now + 11 * DAY },
			}) as never,
		);
		const lines = await infoLines(() =>
			scheduler.shouldRefreshAccount(account, now),
		);

		expect(
			lines.filter((line) => line.includes("usage window is exhausted")),
		).toHaveLength(1);
	});

	it("forgets what it announced when the account's tracking is cleared", async () => {
		const now = Date.now();
		const scheduler = await makeScheduler(makeDb());
		usageCache.set(ACCOUNT_ID, exhaustedWeekly(now) as never);

		scheduler.shouldRefreshAccount(makeAccountRow(), now);
		expect(scheduler.usageExhaustedAnnouncedFor.has(ACCOUNT_ID)).toBe(true);

		scheduler.clearAccountTracking(ACCOUNT_ID);
		expect(scheduler.usageExhaustedAnnouncedFor.has(ACCOUNT_ID)).toBe(false);
	});
});
