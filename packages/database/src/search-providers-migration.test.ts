import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { ensureSchema, runMigrations } from "./migrations";
import { ensureSchemaPg } from "./migrations-pg";

const EXPECTED_COLUMNS = [
	"id",
	"provider",
	"label",
	"api_key",
	"priority",
	"enabled",
	"max_results",
	"extra_config",
	"status",
	"status_message",
	"status_checked_at",
	"cooldown_until",
	"created_at",
	"updated_at",
];

const EXPECTED_INDEXES = [
	"idx_search_providers_priority",
	"idx_search_providers_label",
];

function tableColumns(db: Database, table: string): string[] {
	return (
		db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
	).map((c) => c.name);
}

function tableIndexes(db: Database, table: string): string[] {
	return (
		db.prepare(`PRAGMA index_list(${table})`).all() as Array<{ name: string }>
	).map((i) => i.name);
}

describe("search_providers migration (SQLite)", () => {
	let db: Database;

	beforeEach(() => {
		db = new Database(":memory:");
	});

	afterEach(() => {
		db.close();
	});

	it("a fresh database has the table with every expected column", () => {
		ensureSchema(db);
		runMigrations(db);
		expect(tableColumns(db, "search_providers")).toEqual(EXPECTED_COLUMNS);
	});

	it("a fresh database has the priority and unique-label indexes", () => {
		ensureSchema(db);
		runMigrations(db);
		const indexes = tableIndexes(db, "search_providers");
		for (const expected of EXPECTED_INDEXES) {
			expect(indexes).toContain(expected);
		}
		// The label index is UNIQUE.
		const labelIndex = db
			.prepare(
				`SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'idx_search_providers_label'`,
			)
			.get() as { sql: string } | null;
		expect(labelIndex?.sql ?? "").toMatch(/CREATE UNIQUE INDEX/i);
	});

	it("applies the column defaults", () => {
		ensureSchema(db);
		runMigrations(db);
		db.run(
			`INSERT INTO search_providers (id, provider, label, created_at, updated_at)
			 VALUES ('sp1', 'tavily', 'defaults', 1, 1)`,
		);
		const row = db
			.prepare(
				`SELECT priority, enabled, max_results, status FROM search_providers WHERE id = 'sp1'`,
			)
			.get() as {
			priority: number;
			enabled: number;
			max_results: number;
			status: string;
		};
		expect(row).toEqual({
			priority: 0,
			enabled: 1,
			max_results: 10,
			status: "unknown",
		});
	});

	it("is idempotent — running migrations twice keeps the table and any data", () => {
		ensureSchema(db);
		runMigrations(db);
		db.run(
			`INSERT INTO search_providers (id, provider, label, created_at, updated_at)
			 VALUES ('sp1', 'tavily', 'kept', 1, 1)`,
		);

		expect(() => runMigrations(db)).not.toThrow();

		expect(tableColumns(db, "search_providers")).toEqual(EXPECTED_COLUMNS);
		const count = db
			.prepare(`SELECT COUNT(*) AS n FROM search_providers`)
			.get() as { n: number };
		expect(count.n).toBe(1);
	});

	it("adds the table to a pre-existing database that lacks it", () => {
		// Simulate an install created before search_providers existed: full
		// schema + migrations, then drop the table and its indexes.
		ensureSchema(db);
		runMigrations(db);
		db.run("DROP TABLE search_providers");
		expect(tableColumns(db, "search_providers")).toEqual([]);

		runMigrations(db);

		expect(tableColumns(db, "search_providers")).toEqual(EXPECTED_COLUMNS);
		const indexes = tableIndexes(db, "search_providers");
		for (const expected of EXPECTED_INDEXES) {
			expect(indexes).toContain(expected);
		}
	});
});

describe("search_providers migration (PostgreSQL, static)", () => {
	const source = fs.readFileSync(
		path.join(__dirname, "migrations-pg.ts"),
		"utf8",
	);

	it("ensureSchemaPg calls the shared search_providers DDL", () => {
		const fnStart = source.indexOf("export async function ensureSchemaPg");
		const fnEnd = source.indexOf("\nexport ", fnStart + 1);
		const body = source.slice(fnStart, fnEnd);
		expect(body).toContain("createSearchProvidersTablePg(adapter)");
	});

	it("runMigrationsPg re-creates the table for existing installs", () => {
		const fnStart = source.indexOf("export async function runMigrationsPg");
		const body = source.slice(fnStart);
		expect(body).toContain("createSearchProvidersTablePg(adapter)");
	});

	it("declares the table with BIGINT timestamps and INTEGER enabled", () => {
		const start = source.indexOf("async function createSearchProvidersTablePg");
		expect(start).toBeGreaterThan(-1);
		const body = source.slice(start, source.indexOf("\n}", start));

		for (const col of EXPECTED_COLUMNS) {
			expect(body).toMatch(new RegExp(`\\b${col}\\b`));
		}
		for (const col of [
			"created_at",
			"updated_at",
			"status_checked_at",
			"cooldown_until",
		]) {
			expect(body).toMatch(new RegExp(`\\b${col}\\s+BIGINT`));
		}
		expect(body).toMatch(/\benabled\s+INTEGER\s+NOT NULL DEFAULT 1/);
		expect(body).toMatch(/\bpriority\s+INTEGER\b/);
		expect(body).toMatch(/\bmax_results\s+INTEGER\b/);

		for (const idx of EXPECTED_INDEXES) {
			expect(body).toContain(idx);
		}
		expect(body).toContain(
			"CREATE UNIQUE INDEX IF NOT EXISTS idx_search_providers_label",
		);
	});

	it("ensureSchemaPg emits the search_providers DDL when driven by a fake adapter", async () => {
		const statements: string[] = [];
		const adapter = {
			unsafe: async (sql: string) => {
				statements.push(sql);
			},
			// biome-ignore lint/suspicious/noExplicitAny: fake adapter for testing
		} as any;

		await ensureSchemaPg(adapter);

		const joined = statements.join("\n");
		expect(joined).toContain("CREATE TABLE IF NOT EXISTS search_providers");
		expect(joined).toContain("idx_search_providers_priority");
		expect(joined).toContain("idx_search_providers_label");
	});
});
