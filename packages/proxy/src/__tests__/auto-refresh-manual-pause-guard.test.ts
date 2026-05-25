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
import { describe, expect, it, mock } from "bun:test";

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
			rate_limited_until INTEGER
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
	it("excludes manually-paused accounts even when auto_pause_on_overage_enabled=1", async () => {
		const query = await captureEligibilityQuery();
		const names = selectedNames(query);

		// The regression: a manual pause with the overage *feature* enabled must
		// NOT be probed, because the auto-resume guard would never un-pause it.
		expect(names.has("manual-overage-on")).toBe(false);
	});

	it("excludes failure-threshold pauses", async () => {
		const query = await captureEligibilityQuery();
		const names = selectedNames(query);
		expect(names.has("failure-threshold")).toBe(false);
	});

	it("still includes overage-paused accounts (so they auto-resume on window reset)", async () => {
		const query = await captureEligibilityQuery();
		const names = selectedNames(query);
		expect(names.has("overage-paused")).toBe(true);
		// A null pause_reason is treated as overage by the resume guard, so it
		// must remain eligible too.
		expect(names.has("overage-null-reason")).toBe(true);
	});

	it("still includes non-paused accounts and excludes feature-off manual pauses", async () => {
		const query = await captureEligibilityQuery();
		const names = selectedNames(query);
		expect(names.has("active")).toBe(true);
		expect(names.has("manual-overage-off")).toBe(false);
	});

	it("selection criteria match the auto-resume guard exactly", async () => {
		// Paused rows the query selects must be precisely the rows the resume
		// guard (auto_pause_on_overage_enabled=1 AND pause_reason IN (NULL,'overage'))
		// would un-pause. Anything else is a probe that can never be resumed.
		const query = await captureEligibilityQuery();
		const names = selectedNames(query);
		const pausedSelected = [
			"overage-paused",
			"overage-null-reason",
			"manual-overage-on",
			"failure-threshold",
			"manual-overage-off",
		].filter((n) => names.has(n));
		expect(pausedSelected.sort()).toEqual(
			["overage-null-reason", "overage-paused"].sort(),
		);
	});
});
