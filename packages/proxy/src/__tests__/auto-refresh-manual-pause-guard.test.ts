/**
 * Regression test: the auto-refresh probe-selection query must respect
 * `pause_reason`, not just `auto_pause_on_overage_enabled`.
 *
 * Bug: a manually-paused account (pause_reason='manual') that also has the
 * auto-pause-on-overage *capability* enabled (auto_pause_on_overage_enabled=1)
 * was selected for probing every time its rate-limit window allowed it. Each
 * probe is a real POST /v1/messages force-routed to that account; when the
 * account is over a window limit it 429s, gets logged as model_fallback_429,
 * and is put on a short cooldown — then re-probed the moment the cooldown
 * expires. The result is an endless ~5-6 min loop of synthetic 429s against an
 * account the user disabled by hand.
 *
 * The auto-resume guard in sendDummyMessage only un-pauses accounts where
 * `auto_pause_on_overage_enabled=1 AND (pause_reason IS NULL OR pause_reason='overage')`,
 * so any other paused account would be probed forever yet never resumed. The
 * selection query must use the *same* criteria.
 *
 * Strategy: capture the SQL the scheduler issues (mock db), then execute that
 * exact SQL against a real in-memory SQLite DB seeded with one account per
 * pause scenario. This proves row-level filtering, not just string presence.
 */
import { Database } from "bun:sqlite";
import { beforeAll, describe, expect, it, mock } from "bun:test";

type QueryCall = { sql: string; params: unknown[] };

function makeDb(queryResult: unknown[] = []) {
	const queryCalls: QueryCall[] = [];
	return {
		query: mock(async (sql: string, params: unknown[]) => {
			queryCalls.push({ sql, params });
			return queryResult;
		}),
		run: mock(async () => {}),
		queryCalls,
	};
}

function makeProxyContext() {
	return {
		runtime: { port: 8080, clientId: "test-client" },
		refreshInFlight: new Map(),
	};
}

async function makeScheduler(db: ReturnType<typeof makeDb>) {
	const { AutoRefreshScheduler } = await import("../auto-refresh-scheduler");
	return new AutoRefreshScheduler(db as never, makeProxyContext() as never);
}

/**
 * Run the scheduler's eligibility query once and return the captured SQL +
 * params. The query returns [] from the mock, so no probes are sent.
 */
async function captureEligibilityQuery(): Promise<QueryCall> {
	const db = makeDb([]);
	const scheduler = await makeScheduler(db);
	await (
		scheduler as never as { checkAndRefresh(): Promise<void> }
	).checkAndRefresh();

	const mainQuery = db.queryCalls.find(
		(c) =>
			c.sql.includes("rate_limit_reset") &&
			c.sql.includes("auto_refresh_enabled"),
	);
	if (!mainQuery) {
		throw new Error("eligibility query not captured");
	}
	return mainQuery;
}

/**
 * Minimal in-memory accounts table holding just the columns the eligibility
 * query reads. Each row is an anthropic account with auto-refresh enabled and a
 * NULL rate_limit_reset (so the reset-window clause matches) and a NULL
 * rate_limited_until (so the cooldown guard passes) — isolating the
 * paused/pause_reason behaviour under test.
 */
function seedDb(): Database {
	const db = new Database(":memory:");
	db.run(`
		CREATE TABLE accounts (
			id TEXT PRIMARY KEY,
			name TEXT,
			provider TEXT,
			refresh_token TEXT,
			access_token TEXT,
			expires_at INTEGER,
			rate_limit_reset INTEGER,
			custom_endpoint TEXT,
			paused INTEGER,
			auto_pause_on_overage_enabled INTEGER,
			pause_reason TEXT,
			auto_refresh_enabled INTEGER,
			rate_limited_until INTEGER,
			requires_reauth INTEGER DEFAULT 0
		)
	`);

	const insert = db.prepare(`
		INSERT INTO accounts
			(id, name, provider, refresh_token, access_token, expires_at,
			 rate_limit_reset, custom_endpoint, paused,
			 auto_pause_on_overage_enabled, pause_reason, auto_refresh_enabled,
			 rate_limited_until)
		VALUES (?, ?, 'anthropic', 'rt', 'at', NULL, NULL, NULL, ?, ?, ?, 1, NULL)
	`);

	// name, paused, auto_pause_on_overage_enabled, pause_reason
	const rows: Array<[string, number, number, string | null]> = [
		["active", 0, 1, null], // not paused → eligible
		["overage-paused", 1, 1, "overage"], // overage auto-pause → eligible (resumable)
		["overage-null-reason", 1, 1, null], // overage pause, null reason → eligible (resumable)
		["manual-overage-on", 1, 1, "manual"], // THE BUG: manual pause, feature on → MUST be excluded
		["failure-threshold", 1, 1, "failure_threshold"], // auto-pause-fail → excluded
		["peak-hours-paused", 1, 1, "peak_hours"], // zai peak-hours auto-pause → excluded
		["manual-overage-off", 1, 0, "manual"], // manual pause, feature off → excluded (already was)
	];
	for (const [name, paused, overage, reason] of rows) {
		insert.run(name, name, paused, overage, reason);
	}
	return db;
}

function selectedNames(query: QueryCall): Set<string> {
	const db = seedDb();
	try {
		const now = Date.now();
		// The query binds exactly three `now` placeholders ([now, now, now]).
		const rows = db.query(query.sql).all(now, now, now) as Array<{
			name: string;
		}>;
		return new Set(rows.map((r) => r.name));
	} finally {
		db.close();
	}
}

describe("AutoRefreshScheduler — manual-pause probe guard", () => {
	// The eligibility SQL is identical across every scenario, so capture it (and
	// the set of accounts it selects) once rather than re-running the whole
	// scheduler per test.
	let names: Set<string>;

	beforeAll(async () => {
		const query = await captureEligibilityQuery();
		names = selectedNames(query);
	});

	it("excludes manually-paused accounts even when auto_pause_on_overage_enabled=1", () => {
		// The regression: a manual pause with the overage *feature* enabled must
		// NOT be probed, because the auto-resume guard would never un-pause it.
		expect(names.has("manual-overage-on")).toBe(false);
	});

	it("includes failure-threshold pauses (so they can self-recover, #262)", () => {
		// A failure_threshold pause is set by this scheduler after repeated refresh
		// failures. It must remain probe-eligible so a successful probe can clear it
		// — otherwise the account is stuck in API ERROR until a human clicks Force
		// Refresh. Re-probe frequency is throttled in shouldRefreshAccount, not here.
		expect(names.has("failure-threshold")).toBe(true);
	});

	it("excludes peak_hours pauses (zai peak-hours auto-pause)", () => {
		// checkPeakHoursPause sets pause_reason='peak_hours' on zai accounts; such
		// a pause is not overage, so it must never be probed even with the overage
		// feature flag enabled.
		expect(names.has("peak-hours-paused")).toBe(false);
	});

	it("still includes overage-paused accounts (so they auto-resume on window reset)", () => {
		expect(names.has("overage-paused")).toBe(true);
		// A null pause_reason is treated as overage by the resume guard, so it
		// must remain eligible too.
		expect(names.has("overage-null-reason")).toBe(true);
	});

	it("still includes non-paused accounts and excludes feature-off manual pauses", () => {
		expect(names.has("active")).toBe(true);
		expect(names.has("manual-overage-off")).toBe(false);
	});

	it("selection criteria match the auto-resume guard exactly", () => {
		// Paused rows the query selects must be precisely the rows the resume guard
		// would un-pause: overage (pause_reason NULL/'overage') and failure_threshold
		// (cleared on successful probe, #262). Anything else is a probe that can never
		// be resumed.
		const pausedSelected = [
			"overage-paused",
			"overage-null-reason",
			"manual-overage-on",
			"failure-threshold",
			"peak-hours-paused",
			"manual-overage-off",
		].filter((n) => names.has(n));
		expect(pausedSelected.sort()).toEqual(
			["failure-threshold", "overage-null-reason", "overage-paused"].sort(),
		);
	});
});

/**
 * #262: failure_threshold-paused accounts must be re-probed on a cooldown so
 * they can self-recover, but not hammered every 60s. The throttle lives in
 * shouldRefreshAccount (which consults lastFailureProbeAt).
 */
describe("AutoRefreshScheduler — failure_threshold re-probe cooldown", () => {
	const failureRow = {
		id: "acct-ft",
		name: "acct-ft",
		provider: "anthropic",
		refresh_token: "rt",
		access_token: "at",
		expires_at: null as number | null,
		rate_limit_reset: null as number | null,
		custom_endpoint: null as string | null,
		paused: 1,
		pause_reason: "failure_threshold" as string | null,
	};

	type SchedulerWithInternals = {
		shouldRefreshAccount(account: typeof failureRow, now: number): boolean;
		lastFailureProbeAt: Map<string, number>;
		lastRefreshResetTime: Map<string, number>;
		FAILURE_PROBE_COOLDOWN_MS: number;
	};

	async function makeSchedulerInternals(): Promise<SchedulerWithInternals> {
		const scheduler = await makeScheduler(makeDb([]));
		return scheduler as unknown as SchedulerWithInternals;
	}

	it("probes a failure_threshold account on the first cycle", async () => {
		const s = await makeSchedulerInternals();
		expect(s.shouldRefreshAccount(failureRow, Date.now())).toBe(true);
	});

	it("skips re-probing within the cooldown window", async () => {
		const s = await makeSchedulerInternals();
		const now = Date.now();
		// Simulate sendDummyMessage having recorded a probe just now.
		s.lastFailureProbeAt.set(failureRow.id, now);
		expect(s.shouldRefreshAccount(failureRow, now + 60_000)).toBe(false);
	});

	it("re-probes after the cooldown elapses", async () => {
		const s = await makeSchedulerInternals();
		const now = Date.now();
		s.lastFailureProbeAt.set(failureRow.id, now);
		const afterCooldown = now + s.FAILURE_PROBE_COOLDOWN_MS + 1;
		expect(s.shouldRefreshAccount(failureRow, afterCooldown)).toBe(true);
	});

	it("does not throttle non-failure_threshold accounts", async () => {
		const s = await makeSchedulerInternals();
		// A stale lastFailureProbeAt entry must not suppress a normal account.
		s.lastFailureProbeAt.set("other", Date.now());
		const activeRow = { ...failureRow, paused: 0, pause_reason: null };
		// First-time refresh (no lastRefreshResetTime entry) → true regardless.
		expect(s.shouldRefreshAccount(activeRow, Date.now())).toBe(true);
	});

	it("clears the cooldown path once a failure_threshold account is resumed (resume-then-reprobe)", async () => {
		// Greptile #263 (round 2): a stale lastFailureProbeAt entry under the
		// SAME id must not affect an account once it has been resumed
		// (paused=0, pause_reason cleared). After resume the account follows normal
		// window logic — the failure_threshold short-circuit no longer applies.
		const s = await makeSchedulerInternals();
		s.lastFailureProbeAt.set(failureRow.id, Date.now());
		const resumedRow = { ...failureRow, paused: 0, pause_reason: null };
		// First-time refresh (no lastRefreshResetTime) → true regardless of the
		// stale probe timestamp.
		expect(s.shouldRefreshAccount(resumedRow, Date.now())).toBe(true);
	});

	it("probes after cooldown even when a prior window is still active (long-running scheduler)", async () => {
		// Greptile #263: once the cooldown elapses, the re-probe must fire even if
		// lastRefreshResetTime is set and the current rate-limit window hasn't
		// expired — we're probing liveness, not waiting for a new window.
		const s = await makeSchedulerInternals();
		const now = Date.now();
		// Prior successful refresh recorded a reset time 2h in the future, and a
		// probe happened recently enough that the cooldown has now elapsed.
		const futureReset = now + 2 * 60 * 60 * 1000;
		s.lastRefreshResetTime.set(failureRow.id, now - 3 * 60 * 1000);
		s.lastFailureProbeAt.set(
			failureRow.id,
			now - s.FAILURE_PROBE_COOLDOWN_MS - 1,
		);
		const rowWithWindow = { ...failureRow, rate_limit_reset: futureReset };
		expect(s.shouldRefreshAccount(rowWithWindow, now)).toBe(true);
	});
});
