import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import "@better-ccflare/core";
import { BunSqlAdapter } from "../../adapters/bun-sql-adapter";
import { ensureSchema, runMigrations } from "../../migrations";
import { StatsRepository } from "../stats.repository";

const createRepoWithRows = (rows: Array<Record<string, unknown>>) => {
	const adapter = {
		query: async () => rows,
	};

	// biome-ignore lint/suspicious/noExplicitAny: partial mock adapter object
	return new StatsRepository(adapter as any);
};

describe("getSessionStats cost aggregation", () => {
	it("should include planCostUsd and apiCostUsd in returned stats", async () => {
		const repo = createRepoWithRows([
			{
				account_used: "acc-1",
				requests: 3,
				input_tokens: 1000,
				cache_creation_input_tokens: 200,
				cache_read_input_tokens: 100,
				output_tokens: 500,
				plan_cost_usd: 1.23,
				api_cost_usd: 0.05,
			},
		]);

		const result = await repo.getSessionStats([
			{ id: "acc-1", session_start: 1000 },
		]);
		const stats = result.get("acc-1");

		expect(stats).toBeDefined();
		expect(stats?.planCostUsd).toBe(1.23);
		expect(stats?.apiCostUsd).toBe(0.05);
	});

	it("should default cost to 0 when plan and api costs are null", async () => {
		const repo = createRepoWithRows([
			{
				account_used: "acc-2",
				requests: 1,
				input_tokens: 100,
				cache_creation_input_tokens: 0,
				cache_read_input_tokens: 0,
				output_tokens: 50,
				plan_cost_usd: null,
				api_cost_usd: null,
			},
		]);

		const result = await repo.getSessionStats([
			{ id: "acc-2", session_start: 5000 },
		]);
		const stats = result.get("acc-2");

		expect(stats).toBeDefined();
		expect(stats?.planCostUsd).toBe(0);
		expect(stats?.apiCostUsd).toBe(0);
	});

	it("should return an empty map when accounts have no session start", async () => {
		const repo = new StatsRepository({
			query: async () => {
				throw new Error("query should not run when no sessions are active");
			},
			// biome-ignore lint/suspicious/noExplicitAny: partial mock adapter object
		} as any);

		const result = await repo.getSessionStats([
			{ id: "acc-3", session_start: null },
			{ id: "acc-4", session_start: null },
		]);

		expect(result.size).toBe(0);
	});
});

// ---------------------------------------------------------------------------
// WP11: the per-account session windows are joined through a thresholds CTE
// instead of being OR-chained together. These tests pin the semantics that
// the OR-chain used to provide.
// ---------------------------------------------------------------------------

describe("getSessionStats thresholds CTE", () => {
	let db: Database;

	beforeEach(() => {
		db = new Database(":memory:");
		ensureSchema(db);
		runMigrations(db);
	});

	afterEach(() => {
		db.close();
	});

	const insertRequest = (opts: {
		id: string;
		timestamp: number;
		accountUsed: string;
		inputTokens?: number;
		outputTokens?: number;
		costUsd?: number;
		billingType?: string;
	}) => {
		db.run(
			`INSERT INTO requests
				(id, timestamp, method, path, account_used, status_code, success,
				 response_time_ms, failover_attempts, input_tokens,
				 cache_read_input_tokens, cache_creation_input_tokens,
				 output_tokens, cost_usd, billing_type)
			 VALUES (?, ?, 'POST', '/v1/messages', ?, 200, 1, 100, 0, ?, 0, 0, ?, ?, ?)`,
			[
				opts.id,
				opts.timestamp,
				opts.accountUsed,
				opts.inputTokens ?? 0,
				opts.outputTokens ?? 0,
				opts.costUsd ?? 0,
				opts.billingType ?? "api",
			],
		);
	};

	const makeRepo = () => new StatsRepository(new BunSqlAdapter(db));

	it("applies each account's own session_start threshold", async () => {
		insertRequest({
			id: "r-a-old",
			timestamp: 500,
			accountUsed: "acc-a",
			inputTokens: 10,
			outputTokens: 5,
		});
		insertRequest({
			id: "r-a-in",
			timestamp: 1500,
			accountUsed: "acc-a",
			inputTokens: 20,
			outputTokens: 10,
		});
		// Same timestamp as acc-a's request, but acc-b's window starts later.
		insertRequest({
			id: "r-b-early",
			timestamp: 1500,
			accountUsed: "acc-b",
			inputTokens: 99,
			outputTokens: 99,
		});
		insertRequest({
			id: "r-b-in",
			timestamp: 2500,
			accountUsed: "acc-b",
			inputTokens: 30,
			outputTokens: 15,
		});
		// An account that is not part of the query at all.
		insertRequest({
			id: "r-c",
			timestamp: 2500,
			accountUsed: "acc-c",
			inputTokens: 1000,
			outputTokens: 1000,
		});

		const stats = await makeRepo().getSessionStats([
			{ id: "acc-a", session_start: 1000 },
			{ id: "acc-b", session_start: 2000 },
		]);

		// acc-a: only the request at/after its own threshold.
		expect(stats.get("acc-a")?.requests).toBe(1);
		expect(stats.get("acc-a")?.inputTokens).toBe(20);
		expect(stats.get("acc-a")?.outputTokens).toBe(10);
		// acc-b: the request at 1500 predates acc-b's window.
		expect(stats.get("acc-b")?.requests).toBe(1);
		expect(stats.get("acc-b")?.inputTokens).toBe(30);
		// Unrelated account is not reported.
		expect(stats.has("acc-c")).toBe(false);
	});

	it("does not double count when the same account is listed twice", async () => {
		insertRequest({
			id: "r-dup",
			timestamp: 1500,
			accountUsed: "acc-dup",
			inputTokens: 7,
			outputTokens: 3,
		});

		const stats = await makeRepo().getSessionStats([
			{ id: "acc-dup", session_start: 1000 },
			{ id: "acc-dup", session_start: 2000 },
		]);

		expect(stats.get("acc-dup")?.requests).toBe(1);
		expect(stats.get("acc-dup")?.inputTokens).toBe(7);
	});

	it("splits plan and api cost per account", async () => {
		insertRequest({
			id: "r-plan",
			timestamp: 1200,
			accountUsed: "acc-cost",
			costUsd: 1.5,
			billingType: "plan",
		});
		insertRequest({
			id: "r-api",
			timestamp: 1300,
			accountUsed: "acc-cost",
			costUsd: 0.25,
			billingType: "api",
		});

		const stats = await makeRepo().getSessionStats([
			{ id: "acc-cost", session_start: 1000 },
		]);

		expect(stats.get("acc-cost")?.requests).toBe(2);
		expect(stats.get("acc-cost")?.planCostUsd).toBeCloseTo(1.5, 6);
		expect(stats.get("acc-cost")?.apiCostUsd).toBeCloseTo(0.25, 6);
	});
});

describe("getSessionStats generated SQL", () => {
	const capture = async (isSQLite: boolean) => {
		const calls: Array<{ sql: string; params: unknown[] }> = [];
		const adapter = {
			isSQLite,
			query: async (sql: string, params: unknown[] = []) => {
				calls.push({ sql, params });
				return [];
			},
		};
		// biome-ignore lint/suspicious/noExplicitAny: partial mock adapter object
		const repo = new StatsRepository(adapter as any);
		await repo.getSessionStats([
			{ id: "acc-1", session_start: 1000 },
			{ id: "acc-2", session_start: 2000 },
		]);
		return calls[0];
	};

	for (const isSQLite of [true, false]) {
		it(`joins thresholds instead of OR-chaining them (isSQLite=${isSQLite})`, async () => {
			const call = await capture(isSQLite);

			expect(call).toBeDefined();
			// The account predicates are joined, not OR-ed.
			expect(call.sql).not.toMatch(/OR\s*\(?\s*account_used/i);
			// The only OR left in the statement is the billing_type NULL check
			// inside the api_cost_usd CASE expression.
			expect(call.sql.match(/\bOR\b/gi) ?? []).toHaveLength(1);
			expect(call.sql).toMatch(/WITH\s+thresholds\b/i);
			expect(call.sql).toMatch(/JOIN\s+thresholds\b/i);
			// One bind pair per account.
			expect(call.params).toEqual(["acc-1", 1000, "acc-2", 2000]);
		});
	}

	it("casts the threshold column for the target dialect", async () => {
		const sqlite = await capture(true);
		const postgres = await capture(false);

		expect(sqlite.sql).toContain("CAST(? AS INTEGER)");
		expect(postgres.sql).toContain("CAST(? AS BIGINT)");
	});

	it("plans as an index seek per threshold on SQLite", async () => {
		const db = new Database(":memory:");
		try {
			ensureSchema(db);
			runMigrations(db);
			const { sql } = await capture(true);
			const plan = db
				.query(`EXPLAIN QUERY PLAN ${sql}`)
				.all("acc-1", 1000, "acc-2", 2000) as Array<{ detail: string }>;
			const details = plan.map((row) => row.detail).join("\n");

			// (Whether SQLite reports this as a covering index depends on the
			// timestamp binding type handed to the driver; either is a seek.)
			expect(details).toMatch(
				/SEARCH r USING (COVERING )?INDEX idx_requests_account_timestamp \(account_used=\? AND timestamp>\?\)/,
			);
			// A multi-index OR would surface as "MULTI-INDEX OR" instead.
			expect(details).not.toContain("MULTI-INDEX OR");
			expect(details).not.toContain("SCAN r");
		} finally {
			db.close();
		}
	});

	it("does not run a query for an empty active list", async () => {
		let called = false;
		const adapter = {
			isSQLite: true,
			query: async () => {
				called = true;
				return [];
			},
		};
		// biome-ignore lint/suspicious/noExplicitAny: partial mock adapter object
		const repo = new StatsRepository(adapter as any);

		const result = await repo.getSessionStats([
			{ id: "acc-1", session_start: null },
		]);

		expect(result.size).toBe(0);
		expect(called).toBe(false);
	});
});
