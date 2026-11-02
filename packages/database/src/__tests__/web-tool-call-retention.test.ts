/**
 * Retention + PostgreSQL DDL for `web_tool_calls`. The repository's
 * deleteOlderThan — the statement DatabaseOperations.cleanupOldRequests'
 * optional third pass runs — is exercised here against a real in-memory
 * SQLite DB; the table/index DDL is covered in
 * repositories/__tests__/web-tool-call.repository.test.ts.
 */
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { BunSqlAdapter } from "../adapters/bun-sql-adapter";
import { ensureSchema, runMigrations } from "../migrations";
import { WebToolCallRepository } from "../repositories/web-tool-call.repository";

const DAY = 24 * 60 * 60 * 1000;

function makeDb(): Database {
	const db = new Database(":memory:");
	ensureSchema(db);
	runMigrations(db);
	return db;
}

function insertAt(db: Database, id: string, timestamp: number): void {
	db.run(
		`INSERT INTO web_tool_calls (
			id, timestamp, tool, provider_kind, query_chars, latency_ms, status
		 ) VALUES (?, ?, 'web_search', 'tavily', 1, 1, 'ok')`,
		[id, timestamp],
	);
}

describe("web_tool_calls retention", () => {
	let db: Database;
	let repo: WebToolCallRepository;

	beforeEach(() => {
		db = makeDb();
		repo = new WebToolCallRepository(new BunSqlAdapter(db));
	});

	afterEach(() => {
		db.close();
	});

	it("deleteOlderThan removes only rows older than the cutoff", async () => {
		const now = Date.now();
		// Clock-relative ages keep this robust to a slow run; nothing is left
		// at "now", so a cutoff sampled later can never catch the fresh row.
		insertAt(db, "old", now - 10 * DAY);
		insertAt(db, "middle", now - 5 * DAY);
		insertAt(db, "fresh", now - 1 * DAY);

		const removed = await repo.deleteOlderThan(now - 7 * DAY);

		expect(removed).toBe(1);
		const left = await repo.listRecent(10);
		expect(left.map((c) => c.id).sort()).toEqual(["fresh", "middle"]);
	});

	it("deleteOlderThan returns 0 when nothing is old enough", async () => {
		insertAt(db, "fresh", Date.now() - 1 * DAY);
		expect(await repo.deleteOlderThan(Date.now() - 7 * DAY)).toBe(0);
		expect(await repo.countSince(0)).toBe(1);
	});
});

describe("createWebToolCallsTablePg (PostgreSQL DDL)", () => {
	it("emits CREATE TABLE + both indexes with BIGINT / nullable DOUBLE PRECISION", async () => {
		const { ensureSchemaPg } = await import("../migrations-pg");
		const statements: string[] = [];
		const adapter = {
			unsafe: async (sql: string) => {
				statements.push(sql.replace(/\s+/g, " ").trim());
			},
			run: async () => undefined,
			get: async () => null,
			query: async () => [],
			runWithChanges: async () => 0,
		};

		// ensureSchemaPg also runs migrations; only inspect web_tool_calls DDL.
		await ensureSchemaPg(adapter as never);

		const ddl = statements.filter((s) => s.includes("web_tool_calls"));
		const create = ddl.find((s) =>
			s.startsWith("CREATE TABLE IF NOT EXISTS web_tool_calls"),
		);
		expect(create).toBeDefined();
		expect(create).toContain("timestamp BIGINT NOT NULL");
		expect(create).toContain("query_chars BIGINT NOT NULL");
		expect(create).toContain("result_count BIGINT");
		expect(create).toContain("latency_ms BIGINT NOT NULL");
		// Placeholder only: nullable, no default, nothing computes or writes it.
		expect(create).toContain("estimated_cost_usd DOUBLE PRECISION )");
		expect(create).toContain("status TEXT NOT NULL");

		const indexes = ddl.filter((s) => s.startsWith("CREATE INDEX"));
		expect(indexes).toEqual([
			"CREATE INDEX IF NOT EXISTS idx_web_tool_calls_timestamp ON web_tool_calls(timestamp DESC)",
			"CREATE INDEX IF NOT EXISTS idx_web_tool_calls_kind_timestamp ON web_tool_calls(provider_kind, timestamp DESC)",
		]);
		// No bind placeholder in the DDL (it is executed via unsafe()).
		for (const s of ddl) expect(s).not.toContain("?");
	});
});
