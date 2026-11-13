import { Database } from "bun:sqlite";
import { describe, expect, it, mock } from "bun:test";
import { BunSqlAdapter } from "./adapters/bun-sql-adapter";
import { ensureSchema, runMigrations } from "./migrations";
import { ensureSchemaPg, migrateApiKeyLimitsPg } from "./migrations-pg";
import { ApiKeyRepository } from "./repositories/api-key.repository";

function legacyDb() {
	const db = new Database(":memory:");
	// Construct the pre-v2 table explicitly: fresh schema now includes mode.
	db.run(`CREATE TABLE api_keys (
  id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, hashed_key TEXT NOT NULL UNIQUE,
  prefix_last_8 TEXT NOT NULL, created_at INTEGER NOT NULL, last_used INTEGER,
  usage_count INTEGER DEFAULT 0, is_active INTEGER DEFAULT 1,
  role TEXT NOT NULL DEFAULT 'api-only', allowed_accounts TEXT, allowed_models TEXT,
  allowed_providers TEXT, limit_usd REAL, limit_window TEXT, limit_enforce TEXT
 )`);
	db.run(
		"INSERT INTO api_keys (id,name,hashed_key,prefix_last_8,created_at,limit_usd,limit_window,limit_enforce) VALUES ('a','a','h','abcdefgh',1,5,'calendar_month','warn'), ('b','b','h2','abcdefgh',1,8,'rolling_7d','block'), ('c','c','h3','abcdefgh',1,9,'rolling_30d','block')",
	);
	return db;
}
describe("multi-window key budget migration", () => {
	it("includes current budget tables and columns in SQLite fresh schema alone", () => {
		const db = new Database(":memory:");
		try {
			ensureSchema(db);
			const keyColumns = db
				.query("PRAGMA table_info(api_keys)")
				.all() as Array<{ name: string; dflt_value: string | null }>;
			expect(
				keyColumns.find((column) => column.name === "limit_window_mode")
					?.dflt_value,
			).toBe("'calendar'");
			expect(
				keyColumns.some((column) => column.name === "family_combo_overrides"),
			).toBe(true);
			const requestColumns = db
				.query("PRAGMA table_info(requests)")
				.all() as Array<{ name: string }>;
			expect(
				requestColumns.some((column) => column.name === "limit_model"),
			).toBe(true);
			const childColumns = db
				.query("PRAGMA table_info(api_key_limits)")
				.all() as Array<{ name: string }>;
			expect(childColumns.map((column) => column.name)).toEqual([
				"id",
				"api_key_id",
				"scope_model",
				"window",
				"limit_usd",
				"enforce",
				"created_at",
				"updated_at",
			]);
			const indexes = db
				.query("PRAGMA index_list(api_key_limits)")
				.all() as Array<{ name: string }>;
			expect(
				indexes.some((index) => index.name === "idx_api_key_limits_scope"),
			).toBe(true);
		} finally {
			db.close();
		}
	});
	it("includes current budget tables and columns in PostgreSQL fresh schema alone", async () => {
		const unsafe = mock(async (_sql: string) => {});
		await ensureSchemaPg({ unsafe } as unknown as BunSqlAdapter);
		const statements = unsafe.mock.calls.map((call) => call[0]);
		expect(
			statements.find((sql) =>
				sql.includes("CREATE TABLE IF NOT EXISTS api_keys ("),
			),
		).toContain("limit_window_mode TEXT NOT NULL DEFAULT 'calendar'");
		expect(
			statements.find((sql) =>
				sql.includes("CREATE TABLE IF NOT EXISTS api_keys ("),
			),
		).toContain("family_combo_overrides TEXT");
		expect(
			statements.find((sql) =>
				sql.includes("CREATE TABLE IF NOT EXISTS requests ("),
			),
		).toContain("limit_model TEXT");
		const table = statements.find((sql) =>
			sql.includes("CREATE TABLE IF NOT EXISTS api_key_limits ("),
		);
		expect(table).toContain("ON DELETE CASCADE");
		expect(table).toContain('"window" TEXT');
		expect(
			statements.find((sql) =>
				sql.includes(
					"CREATE UNIQUE INDEX IF NOT EXISTS idx_api_key_limits_scope",
				),
			),
		).toContain("COALESCE(scope_model, '')");
	});

	it("migrates legacy calendar and rolling limits and never resurrects a cleared row", () => {
		const db = legacyDb();
		try {
			runMigrations(db);
			expect(
				db
					.query(
						"SELECT api_key_id,scope_model,window,limit_usd,enforce FROM api_key_limits ORDER BY api_key_id",
					)
					.all(),
			).toEqual([
				{
					api_key_id: "a",
					scope_model: null,
					window: "month",
					limit_usd: 5,
					enforce: "warn",
				},
				{
					api_key_id: "b",
					scope_model: null,
					window: "week",
					limit_usd: 8,
					enforce: "block",
				},
				{
					api_key_id: "c",
					scope_model: null,
					window: "month",
					limit_usd: 9,
					enforce: "block",
				},
			]);
			expect(
				db.query("SELECT limit_window_mode FROM api_keys ORDER BY id").all(),
			).toEqual([
				{ limit_window_mode: "calendar" },
				{ limit_window_mode: "rolling" },
				{ limit_window_mode: "rolling" },
			]);
			db.run("DELETE FROM api_key_limits");
			runMigrations(db);
			expect(db.query("SELECT * FROM api_key_limits").all()).toEqual([]);
			expect(
				db.query("SELECT limit_usd FROM api_keys WHERE id='a'").get(),
			).toEqual({ limit_usd: 5 });
		} finally {
			db.close();
		}
	});
	it("enforces key-wide uniqueness and cascades deletion", () => {
		const db = legacyDb();
		try {
			runMigrations(db);
			expect(() =>
				db.run(
					"INSERT INTO api_key_limits (id,api_key_id,scope_model,window,limit_usd,enforce,created_at,updated_at) VALUES ('dup','a',NULL,'month',10,'block',1,1)",
				),
			).toThrow();
			db.run("PRAGMA foreign_keys=ON");
			db.run("DELETE FROM api_keys WHERE id='a'");
			expect(
				db.query("SELECT * FROM api_key_limits WHERE api_key_id='a'").all(),
			).toEqual([]);
		} finally {
			db.close();
		}
	});
	it("replaces rows atomically, defaults new keys to calendar, and supports the month shim", async () => {
		const db = legacyDb();
		try {
			runMigrations(db);
			const repo = new ApiKeyRepository(new BunSqlAdapter(db));
			await repo.replaceLimits(
				"a",
				[{ scopeModel: "opus", window: "day", limitUsd: 2, enforce: "block" }],
				"calendar",
			);
			expect((await repo.getLimits("a"))[0].scopeModel).toBe("opus");
			await expect(
				repo.replaceLimits(
					"a",
					[
						{ scopeModel: null, window: "hour", limitUsd: 1, enforce: "block" },
						{ scopeModel: null, window: "hour", limitUsd: 2, enforce: "warn" },
					],
					"rolling",
				),
			).rejects.toThrow();
			expect((await repo.findById("a"))?.limitWindowMode).toBe("calendar");
			expect((await repo.getLimits("a"))[0].window).toBe("day");
			await repo.updateSpendLimit("a", {
				limitUsd: 12,
				limitWindow: "calendar_month",
				limitEnforce: "warn",
			});
			expect(
				(await repo.getLimits("a")).map((row) => row.window).sort(),
			).toEqual(["day", "month"]);
			await repo.updateSpendLimit("a", null);
			expect((await repo.getLimits("a")).map((row) => row.window)).toEqual([
				"day",
			]);
			await repo.replaceLimits(
				"a",
				[{ scopeModel: "opus", window: "day", limitUsd: 2, enforce: "block" }],
				"calendar",
			);
			await repo.updateSpendLimit("a", null);
			expect((await repo.findById("a"))?.limitWindowMode).toBe("calendar");
		} finally {
			db.close();
		}
	});
	it("runs matching PostgreSQL DDL and backfills only before mode exists", async () => {
		let modeExists = false;
		const unsafe = mock(async (sql: string) => {
			if (sql.includes("ADD COLUMN IF NOT EXISTS limit_window_mode"))
				modeExists = true;
		});
		const get = mock(async () =>
			modeExists ? { column_name: "limit_window_mode" } : null,
		);
		const atomicStatements = mock(
			async (statements: Array<{ sql: string; params: unknown[] }>) => {
				for (const statement of statements) await unsafe(statement.sql);
			},
		);
		const adapter = {
			unsafe,
			get,
			atomicStatements,
		} as unknown as BunSqlAdapter;
		await migrateApiKeyLimitsPg(adapter);
		await migrateApiKeyLimitsPg(adapter);
		const statements = unsafe.mock.calls.map((call) => call[0]);
		expect(atomicStatements).toHaveBeenCalledTimes(2);
		expect(
			statements.filter((sql) => sql.includes("INSERT INTO api_key_limits")),
		).toHaveLength(1);
		expect(
			statements.find((sql) =>
				sql.includes("CREATE TABLE IF NOT EXISTS api_key_limits"),
			),
		).toContain("ON DELETE CASCADE");
		expect(
			statements.find((sql) => sql.includes("CREATE UNIQUE INDEX")),
		).toContain("COALESCE(scope_model, '')");
		expect(
			statements.find((sql) => sql.includes("INSERT INTO api_key_limits")),
		).toContain("rolling_7d");
		expect(
			statements.find((sql) =>
				sql.includes("ADD COLUMN IF NOT EXISTS limit_window_mode"),
			),
		).toContain("DEFAULT 'calendar'");
	});
});
