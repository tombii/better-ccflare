import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
	toWebToolCall,
	toWebToolCallSummary,
	type WebToolCallStatus,
} from "@better-ccflare/types";
import { BunSqlAdapter } from "../../adapters/bun-sql-adapter";
import { ensureSchema, runMigrations } from "../../migrations";
import { WebToolCallRepository } from "../web-tool-call.repository";

function makeDb(): Database {
	const db = new Database(":memory:");
	ensureSchema(db);
	runMigrations(db);
	return db;
}

function makeRepo(db: Database): WebToolCallRepository {
	return new WebToolCallRepository(new BunSqlAdapter(db));
}

/** Direct insert with a controlled timestamp, bypassing record(). */
function insertAt(
	db: Database,
	id: string,
	timestamp: number,
	row: {
		providerKind?: string | null;
		status?: WebToolCallStatus;
		resultCount?: number | null;
		latencyMs?: number;
	} = {},
): void {
	db.run(
		`INSERT INTO web_tool_calls (
			id, timestamp, tool, provider_id, provider_kind, account_id, project,
			query_text, query_chars, result_count, latency_ms, status,
			error_code
		 ) VALUES (?, ?, 'web_search', NULL, ?, NULL, NULL, 'q', 1, ?, ?, ?, NULL)`,
		[
			id,
			timestamp,
			row.providerKind ?? null,
			row.resultCount ?? null,
			row.latencyMs ?? 100,
			row.status ?? "ok",
		],
	);
}

describe("web_tool_calls schema", () => {
	it("exists with the expected columns after ensureSchema", () => {
		const db = new Database(":memory:");
		ensureSchema(db);
		const cols = (
			db.prepare("PRAGMA table_info(web_tool_calls)").all() as Array<{
				name: string;
			}>
		).map((c) => c.name);
		// estimated_cost_usd is a nullable placeholder (no default, no cost code).
		const costCol = (
			db.prepare("PRAGMA table_info(web_tool_calls)").all() as Array<{
				name: string;
				notnull: number;
				dflt_value: string | null;
			}>
		).find((c) => c.name === "estimated_cost_usd");
		expect(costCol).toMatchObject({ notnull: 0, dflt_value: null });
		expect(cols).toEqual([
			"id",
			"timestamp",
			"tool",
			"provider_id",
			"provider_kind",
			"account_id",
			"project",
			"query_text",
			"query_chars",
			"result_count",
			"latency_ms",
			"status",
			"error_code",
			"estimated_cost_usd",
		]);
		db.close();
	});

	it("has its two indexes after ensureSchema", () => {
		const db = new Database(":memory:");
		ensureSchema(db);
		const idx = (
			db
				.prepare(
					"SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'web_tool_calls'",
				)
				.all() as Array<{ name: string }>
		).map((r) => r.name);
		expect(idx).toContain("idx_web_tool_calls_timestamp");
		expect(idx).toContain("idx_web_tool_calls_kind_timestamp");
		db.close();
	});

	it("runMigrations is idempotent and leaves the table and indexes present", () => {
		const db = makeDb();
		runMigrations(db);
		runMigrations(db);
		const tables = db
			.prepare(
				"SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'web_tool_calls'",
			)
			.all();
		expect(tables).toHaveLength(1);
		const idx = db
			.prepare(
				"SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'web_tool_calls'",
			)
			.all();
		expect(idx.length).toBeGreaterThanOrEqual(2);
		db.close();
	});
});

describe("WebToolCallRepository", () => {
	let db: Database;
	let repo: WebToolCallRepository;

	beforeEach(() => {
		db = makeDb();
		repo = makeRepo(db);
	});

	afterEach(() => {
		db.close();
	});

	describe("record / listRecent", () => {
		it("round-trips a full row", async () => {
			const before = Date.now();
			await repo.record({
				tool: "web_search",
				providerId: "sp-1",
				providerKind: "tavily",
				accountId: "acc-1",
				project: "proj",
				queryText: "bun sqlite",
				queryChars: 10,
				resultCount: 3,
				latencyMs: 812,
				status: "ok",
				errorCode: null,
			});

			const calls = await repo.listRecent(10);
			expect(calls).toHaveLength(1);
			const call = calls[0];
			expect(call.id).toBeTruthy();
			expect(call.timestamp).toBeGreaterThanOrEqual(before);
			expect(call).toMatchObject({
				tool: "web_search",
				providerId: "sp-1",
				providerKind: "tavily",
				accountId: "acc-1",
				project: "proj",
				queryText: "bun sqlite",
				queryChars: 10,
				resultCount: 3,
				latencyMs: 812,
				status: "ok",
				errorCode: null,
			});
			// Cost is not populated by the repository — placeholder stays NULL.
			expect(call.estimatedCostUsd).toBeNull();
		});

		it("defaults optional fields for a fallthrough row (no provider)", async () => {
			await repo.record({
				tool: "web_search",
				queryChars: 4,
				latencyMs: 2,
				status: "fallthrough",
			});
			const [call] = await repo.listRecent(10);
			expect(call.providerId).toBeNull();
			expect(call.providerKind).toBeNull();
			expect(call.resultCount).toBeNull();
			expect(call.errorCode).toBeNull();
			expect(call.estimatedCostUsd).toBeNull();
		});

		it("records zero results as 0, not null", async () => {
			await repo.record({
				tool: "web_search",
				providerKind: "tavily",
				queryChars: 1,
				resultCount: 0,
				latencyMs: 5,
				status: "ok",
			});
			expect((await repo.listRecent(1))[0].resultCount).toBe(0);
		});

		it("lists newest first and honours the limit", async () => {
			insertAt(db, "a", 1_000);
			insertAt(db, "b", 3_000);
			insertAt(db, "c", 2_000);
			const calls = await repo.listRecent(2);
			expect(calls.map((c) => c.id)).toEqual(["b", "c"]);
		});
	});

	describe("listRecent filters", () => {
		beforeEach(() => {
			insertAt(db, "ok-tavily", 100, { providerKind: "tavily" });
			insertAt(db, "ok-exa", 200, { providerKind: "exa" });
			insertAt(db, "err-tavily", 300, {
				providerKind: "tavily",
				status: "error",
			});
			insertAt(db, "fallthrough", 400, { status: "fallthrough" });
		});

		it("filters by status", async () => {
			const calls = await repo.listRecent(10, { status: "error" });
			expect(calls.map((c) => c.id)).toEqual(["err-tavily"]);
		});

		it("filters by providerKind", async () => {
			const calls = await repo.listRecent(10, { providerKind: "tavily" });
			expect(calls.map((c) => c.id)).toEqual(["err-tavily", "ok-tavily"]);
		});

		it("filters by since", async () => {
			const calls = await repo.listRecent(10, { since: 300 });
			expect(calls.map((c) => c.id)).toEqual(["fallthrough", "err-tavily"]);
		});

		it("combines filters", async () => {
			const calls = await repo.listRecent(10, {
				status: "ok",
				providerKind: "tavily",
			});
			expect(calls.map((c) => c.id)).toEqual(["ok-tavily"]);
		});
	});

	describe("summary", () => {
		beforeEach(() => {
			// tavily/ok x2
			insertAt(db, "t1", 100, {
				providerKind: "tavily",
				resultCount: 5,
				latencyMs: 100,
			});
			insertAt(db, "t2", 200, {
				providerKind: "tavily",
				resultCount: 3,
				latencyMs: 300,
			});
			// tavily/error x1 (no results)
			insertAt(db, "t3", 300, {
				providerKind: "tavily",
				status: "error",
				latencyMs: 50,
			});
			// exa/ok x1
			insertAt(db, "e1", 400, {
				providerKind: "exa",
				resultCount: 10,
				latencyMs: 1000,
			});
			// old row, outside the window
			insertAt(db, "old", 10, {
				providerKind: "tavily",
				resultCount: 99,
				latencyMs: 9,
			});
		});

		it("groups by provider_kind + status with totals and averages", async () => {
			const rows = await repo.summary(100);
			const byKey = new Map(
				rows.map((r) => [`${r.providerKind}/${r.status}`, r]),
			);
			expect(rows).toHaveLength(3);

			const tavilyOk = byKey.get("tavily/ok");
			expect(tavilyOk).toMatchObject({
				callCount: 2,
				totalLatencyMs: 400,
				avgLatencyMs: 200,
				totalResults: 8,
			});
			expect(tavilyOk).not.toHaveProperty("totalEstimatedCostUsd");

			const tavilyErr = byKey.get("tavily/error");
			expect(tavilyErr).toMatchObject({
				callCount: 1,
				totalLatencyMs: 50,
				avgLatencyMs: 50,
				totalResults: 0,
			});

			const exaOk = byKey.get("exa/ok");
			expect(exaOk).toMatchObject({
				callCount: 1,
				totalResults: 10,
				avgLatencyMs: 1000,
			});
		});

		it("orders buckets by call count DESC", async () => {
			const rows = await repo.summary(0);
			expect(rows[0]).toMatchObject({
				providerKind: "tavily",
				status: "ok",
				callCount: 3, // includes the old row when the window is open
			});
		});

		it("returns an empty list when nothing matches", async () => {
			expect(await repo.summary(Number.MAX_SAFE_INTEGER)).toEqual([]);
		});
	});

	describe("countSince / deleteOlderThan", () => {
		beforeEach(() => {
			insertAt(db, "old1", 1_000);
			insertAt(db, "old2", 2_000);
			insertAt(db, "new1", 3_000);
			insertAt(db, "new2", 4_000);
		});

		it("counts rows at or after the cutoff", async () => {
			expect(await repo.countSince(3_000)).toBe(2);
			expect(await repo.countSince(0)).toBe(4);
		});

		it("deleteOlderThan returns the count and leaves newer rows", async () => {
			const removed = await repo.deleteOlderThan(3_000);
			expect(removed).toBe(2);
			const remaining = await repo.listRecent(10);
			expect(remaining.map((c) => c.id).sort()).toEqual(["new1", "new2"]);
		});

		it("deleteOlderThan returns 0 when nothing is old enough", async () => {
			expect(await repo.deleteOlderThan(0)).toBe(0);
			expect(await repo.countSince(0)).toBe(4);
		});
	});
});

/**
 * PostgreSQL returns BIGINT as strings (and AVG may come back as a numeric
 * string); SQLite alone cannot reproduce that shape, so the mappers are
 * exercised directly with driver-shaped values — same pattern as
 * `toSearchProvider` in search-provider.repository.test.ts.
 */
describe("toWebToolCall / toWebToolCallSummary — PostgreSQL driver shapes", () => {
	it("coerces every string integer column to a number", () => {
		const call = toWebToolCall({
			id: "w-1",
			timestamp: "1700000000000",
			tool: "web_search",
			provider_id: "sp-1",
			provider_kind: "tavily",
			account_id: null,
			project: null,
			query_text: "q",
			query_chars: "12",
			result_count: "0",
			latency_ms: "250",
			status: "ok",
			error_code: null,
			estimated_cost_usd: null,
		});

		expect(call.timestamp).toBe(1_700_000_000_000);
		expect(call.queryChars).toBe(12);
		expect(call.resultCount).toBe(0);
		expect(call.latencyMs).toBe(250);
		expect(call.estimatedCostUsd).toBeNull();
		expect(call.accountId).toBeNull();
		expect(call.errorCode).toBeNull();
	});

	it("keeps a null result_count null", () => {
		const call = toWebToolCall({
			id: "w-2",
			timestamp: "1",
			tool: "web_search",
			provider_id: null,
			provider_kind: null,
			account_id: null,
			project: null,
			query_text: null,
			query_chars: "0",
			result_count: null,
			latency_ms: "0",
			status: "fallthrough",
			error_code: null,
			estimated_cost_usd: null,
		});
		expect(call.resultCount).toBeNull();
		expect(call.status).toBe("fallthrough");
	});

	it("coerces a string-valued summary row (COUNT/SUM BIGINT, AVG numeric)", () => {
		const summary = toWebToolCallSummary({
			provider_kind: "tavily",
			status: "ok",
			call_count: "7",
			total_latency_ms: "1400",
			avg_latency_ms: "200.0000000000000000",
			total_results: "0",
		});
		expect(summary).toMatchObject({
			providerKind: "tavily",
			status: "ok",
			callCount: 7,
			totalLatencyMs: 1400,
			avgLatencyMs: 200,
			totalResults: 0,
		});
	});
});
