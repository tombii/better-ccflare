import { Database } from "bun:sqlite";
import { describe, expect, it, mock } from "bun:test";
import type { BunSqlAdapter } from "./adapters/bun-sql-adapter";
import { ensureSchema, runMigrations } from "./migrations";
import { ensureSchemaPg, migrateApiKeySpendResetPg } from "./migrations-pg";

describe("API key spend-reset migrations", () => {
	it("creates nullable reset metadata and adds it idempotently on SQLite upgrades", () => {
		const db = new Database(":memory:");
		try {
			ensureSchema(db);
			expect(
				(
					db.query("PRAGMA table_info(api_keys)").all() as Array<{
						name: string;
					}>
				).map((row) => row.name),
			).toContain("spend_reset_at");
			db.run("ALTER TABLE requests DROP COLUMN spend_recorded_at");
			db.run("ALTER TABLE api_keys DROP COLUMN spend_reset_at");
			db.run("ALTER TABLE api_keys DROP COLUMN spend_reset_by");
			runMigrations(db);
			runMigrations(db);
			expect(
				(
					db.query("PRAGMA table_info(requests)").all() as Array<{
						name: string;
					}>
				).map((row) => row.name),
			).toContain("spend_recorded_at");
			db.run(
				"INSERT INTO api_keys (id,name,hashed_key,prefix_last_8,created_at) VALUES ('k','k','h','last8',1)",
			);
			expect(
				db.query("SELECT spend_reset_at,spend_reset_by FROM api_keys").get(),
			).toEqual({ spend_reset_at: null, spend_reset_by: null });
			db.run("UPDATE api_keys SET spend_reset_at=123, spend_reset_by='admin'");
			runMigrations(db);
			expect(
				db.query("SELECT spend_reset_at,spend_reset_by FROM api_keys").get(),
			).toEqual({ spend_reset_at: 123, spend_reset_by: "admin" });
		} finally {
			db.close();
		}
	});
	it("includes PostgreSQL fresh schema and idempotent BIGINT/TEXT upgrade DDL", async () => {
		const unsafe = mock(async (_sql: string) => {});
		const adapter = { unsafe } as unknown as BunSqlAdapter;
		await ensureSchemaPg(adapter);
		await migrateApiKeySpendResetPg(adapter);
		await migrateApiKeySpendResetPg(adapter);
		const statements = unsafe.mock.calls.map((call) => call[0]);
		const table = statements.find((sql) =>
			sql.includes("CREATE TABLE IF NOT EXISTS api_keys ("),
		);
		expect(
			statements.find((sql) =>
				sql.includes("CREATE TABLE IF NOT EXISTS requests ("),
			),
		).toContain("spend_recorded_at BIGINT");
		expect(
			statements.filter((sql) =>
				sql.includes("ADD COLUMN IF NOT EXISTS spend_recorded_at BIGINT"),
			),
		).toHaveLength(2);
		expect(table).toContain("spend_reset_at BIGINT");
		expect(table).toContain("spend_reset_by TEXT");
		expect(
			statements.filter((sql) =>
				sql.includes("ADD COLUMN IF NOT EXISTS spend_reset_at BIGINT"),
			),
		).toHaveLength(2);
		expect(
			statements.filter((sql) =>
				sql.includes("ADD COLUMN IF NOT EXISTS spend_reset_by TEXT"),
			),
		).toHaveLength(2);
	});
});
