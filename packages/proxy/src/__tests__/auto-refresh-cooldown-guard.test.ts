/**
 * Tests for the SQL cooldown guard added to AutoRefreshScheduler in PR #200 (bug 1).
 *
 * The eligibility query must skip accounts whose rate_limited_until is still in
 * the future, and must include accounts where rate_limited_until IS NULL or has
 * already passed.
 *
 * Strategy: capture the SQL string passed to db.query() and assert the clause and
 * parameter array are correct — no real DB required.
 */
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
	return new AutoRefreshScheduler(
		db as never,
		makeProxyContext() as never,
	) as InstanceType<typeof AutoRefreshScheduler> & {
		checkAndRefresh(): Promise<void>;
	};
}

describe("AutoRefreshScheduler — SQL cooldown guard (PR #200 bug 1)", () => {
	it("eligibility query contains the rate_limited_until guard clause", async () => {
		const db = makeDb([]);
		const scheduler = await makeScheduler(db);

		await (
			scheduler as never as { checkAndRefresh(): Promise<void> }
		).checkAndRefresh();

		// The main eligibility query selects multiple columns (id, name, provider, …)
		// and includes rate_limit_reset — distinguishable from the cleanup query
		// which only selects `id`.
		const mainQuery = db.queryCalls.find(
			(c) =>
				c.sql.includes("rate_limit_reset") &&
				c.sql.includes("auto_refresh_enabled"),
		);
		expect(mainQuery).toBeDefined();
		expect(mainQuery?.sql).toContain(
			"rate_limited_until IS NULL OR rate_limited_until <=",
		);
	});

	it("eligibility query passes now as the third parameter (rate_limited_until guard)", async () => {
		const db = makeDb([]);
		const scheduler = await makeScheduler(db);

		const before = Date.now();
		await (
			scheduler as never as { checkAndRefresh(): Promise<void> }
		).checkAndRefresh();
		const after = Date.now();

		const mainQuery = db.queryCalls.find(
			(c) =>
				c.sql.includes("rate_limit_reset") &&
				c.sql.includes("auto_refresh_enabled"),
		);
		expect(mainQuery).toBeDefined();

		// Parameter array must have 3 elements: [now, now, now]
		// position [2] is the third 'now' used by the rate_limited_until <= ? guard
		expect(Array.isArray(mainQuery?.params)).toBe(true);
		expect(mainQuery?.params.length).toBe(3);

		const thirdParam = mainQuery?.params[2] as number;
		expect(thirdParam).toBeGreaterThanOrEqual(before);
		expect(thirdParam).toBeLessThanOrEqual(after);
	});

	it("all three parameters are the same timestamp value", async () => {
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
		expect(mainQuery).toBeDefined();

		const [p0, p1, p2] = mainQuery?.params as number[];
		// All three bind values must be the same 'now' snapshot
		expect(p0).toBe(p1);
		expect(p1).toBe(p2);
	});
});

describe("AutoRefreshScheduler — cooldown guard scenarios", () => {
	it("account with rate_limited_until IS NULL is included (eligible)", async () => {
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
		expect(mainQuery).toBeDefined();
		// The clause must allow NULL — verified by the IS NULL branch in the SQL
		expect(mainQuery?.sql).toContain("rate_limited_until IS NULL");
	});

	it("account with rate_limited_until in the past is included (eligible)", async () => {
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
		expect(mainQuery).toBeDefined();
		// <= ? allows rows where rate_limited_until <= now (i.e. past timestamps)
		expect(mainQuery?.sql).toContain("rate_limited_until <=");
	});

	it("account with rate_limited_until in the future is excluded (skipped)", async () => {
		// The SQL guard `rate_limited_until IS NULL OR rate_limited_until <= ?`
		// is a WHERE clause, so rows with rate_limited_until > now are excluded
		// at the DB level.  We verify the clause uses <=, not <, so an account
		// whose cooldown expired at exactly 'now' is also eligible.
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
		expect(mainQuery).toBeDefined();
		// The guard must be `<= ?` (not `< ?`) so boundary accounts are included
		expect(mainQuery?.sql).toMatch(/rate_limited_until <= \?/);
		// And the full OR clause must be present to exclude strictly-future values
		expect(mainQuery?.sql).toMatch(
			/rate_limited_until IS NULL OR rate_limited_until <= \?/,
		);
	});
});
