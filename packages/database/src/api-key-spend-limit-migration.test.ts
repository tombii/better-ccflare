/**
 * The three spend-limit columns on api_keys, on a fresh database and on one
 * upgraded from an older shape.
 *
 * The invariant every case here is about: NULL on `limit_usd` means NO LIMIT,
 * and no migration, default or re-run is allowed to turn it into anything
 * else. A key that acquires a budget it never asked for would start refusing
 * requests after an upgrade.
 */
import { Database } from "bun:sqlite";
import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { ensureSchema, runMigrations } from "./migrations";

function apiKeyColumns(db: Database): Array<{
	name: string;
	type: string;
	dflt_value: string | null;
	notnull: number;
}> {
	return db.prepare("PRAGMA table_info(api_keys)").all() as Array<{
		name: string;
		type: string;
		dflt_value: string | null;
		notnull: number;
	}>;
}

const LIMIT_COLUMNS = ["limit_usd", "limit_window", "limit_enforce"] as const;

interface StoredLimit {
	limit_usd: number | null;
	limit_window: string | null;
	limit_enforce: string | null;
}

function storedLimit(db: Database, id: string): StoredLimit | null {
	return (
		(db
			.query<StoredLimit, [string]>(
				"SELECT limit_usd, limit_window, limit_enforce FROM api_keys WHERE id = ?",
			)
			.get(id) as StoredLimit | null) ?? null
	);
}

describe("api_keys spend-limit columns migration", () => {
	let db: Database;

	afterEach(() => {
		db.close();
	});

	it("creates all three limit columns on a fresh database", () => {
		db = new Database(":memory:");
		ensureSchema(db);
		runMigrations(db);

		const names = apiKeyColumns(db).map((column) => column.name);
		for (const column of LIMIT_COLUMNS) {
			expect(names).toContain(column);
		}
	});

	it("leaves the limit columns NULL (no limit) for a new key", () => {
		db = new Database(":memory:");
		ensureSchema(db);
		runMigrations(db);

		db.run(
			"INSERT INTO api_keys (id, name, hashed_key, prefix_last_8, created_at, is_active) VALUES ('k1', 'fresh', 'h', '12345678', 1, 1)",
		);

		expect(storedLimit(db, "k1")).toEqual({
			limit_usd: null,
			limit_window: null,
			limit_enforce: null,
		});
	});

	it("adds the limit columns to an existing database without them", () => {
		db = new Database(":memory:");
		// The api_keys shape as it was before this migration — pre-`role` and
		// pre-restrictions, so the whole chain runs, which is the path a real
		// upgrade from an older install takes.
		db.run(`
			CREATE TABLE api_keys (
				id TEXT PRIMARY KEY,
				name TEXT NOT NULL UNIQUE,
				hashed_key TEXT NOT NULL UNIQUE,
				prefix_last_8 TEXT NOT NULL,
				created_at INTEGER NOT NULL,
				last_used INTEGER,
				usage_count INTEGER DEFAULT 0,
				is_active INTEGER DEFAULT 1
			)
		`);
		db.run(
			"INSERT INTO api_keys (id, name, hashed_key, prefix_last_8, created_at, is_active) VALUES ('old', 'legacy', 'h', '12345678', 1, 1)",
		);

		runMigrations(db);

		const names = apiKeyColumns(db).map((column) => column.name);
		for (const column of LIMIT_COLUMNS) {
			expect(names).toContain(column);
		}
		// The one thing that must never happen on an upgrade: an existing key
		// coming out with a budget.
		expect(storedLimit(db, "old")).toEqual({
			limit_usd: null,
			limit_window: null,
			limit_enforce: null,
		});
	});

	it("declares the limit columns nullable with no default", () => {
		db = new Database(":memory:");
		ensureSchema(db);
		runMigrations(db);

		for (const name of LIMIT_COLUMNS) {
			const column = apiKeyColumns(db).find(
				(candidate) => candidate.name === name,
			);
			expect(column).toBeDefined();
			expect(column?.notnull).toBe(0);
			expect(column?.dflt_value).toBeNull();
		}
	});

	it("declares limit_usd as REAL so fractional dollars survive", () => {
		db = new Database(":memory:");
		ensureSchema(db);
		runMigrations(db);

		const column = apiKeyColumns(db).find((c) => c.name === "limit_usd");
		expect(column?.type.toUpperCase()).toBe("REAL");

		db.run(
			"INSERT INTO api_keys (id, name, hashed_key, prefix_last_8, created_at, is_active, limit_usd) VALUES ('k9', 'frac', 'h9', '99999999', 1, 1, 12.5)",
		);
		expect(storedLimit(db, "k9")?.limit_usd).toBe(12.5);
	});

	it("is idempotent across repeated migration runs", () => {
		db = new Database(":memory:");
		ensureSchema(db);
		runMigrations(db);
		runMigrations(db);
		runMigrations(db);

		const names = apiKeyColumns(db).map((column) => column.name);
		for (const column of LIMIT_COLUMNS) {
			expect(names.filter((candidate) => candidate === column).length).toBe(1);
		}
	});

	it("preserves a stored limit across a re-run", () => {
		db = new Database(":memory:");
		ensureSchema(db);
		runMigrations(db);

		db.run(
			"INSERT INTO api_keys (id, name, hashed_key, prefix_last_8, created_at, is_active, limit_usd, limit_window, limit_enforce) VALUES ('k2', 'budgeted', 'h2', '87654321', 1, 1, 50.0, 'calendar_month', 'warn')",
		);
		runMigrations(db);

		expect(storedLimit(db, "k2")).toEqual({
			limit_usd: 50,
			limit_window: "calendar_month",
			limit_enforce: "warn",
		});
	});

	it("survives the legacy accounts-table rebuilds untouched", () => {
		// Two rebuild paths in runMigrations copy a HARDCODED column list into
		// an accounts_new and drop the original, which silently loses any
		// column added to `accounts` before them. Both rebuild `accounts`, not
		// `api_keys`, so the api_keys columns cannot be affected — this pins
		// that, by forcing the account_tier rebuild to run and checking the
		// api_keys columns are still there afterwards.
		db = new Database(":memory:");
		ensureSchema(db);
		runMigrations(db);
		db.run("ALTER TABLE accounts ADD COLUMN account_tier TEXT");
		db.run(
			"INSERT INTO api_keys (id, name, hashed_key, prefix_last_8, created_at, is_active, limit_usd, limit_window, limit_enforce) VALUES ('k3', 'kept', 'h3', '11112222', 1, 1, 25.0, 'rolling_7d', 'block')",
		);

		runMigrations(db);

		const names = apiKeyColumns(db).map((column) => column.name);
		for (const column of LIMIT_COLUMNS) {
			expect(names).toContain(column);
		}
		expect(storedLimit(db, "k3")).toEqual({
			limit_usd: 25,
			limit_window: "rolling_7d",
			limit_enforce: "block",
		});
	});
});

describe("spend-limit columns — SQLite/PostgreSQL parity", () => {
	// The PostgreSQL port cannot be run here (no live PG server), so it is
	// checked as source text — the same static-parity approach migrations-pg
	// .test.ts already uses for every other column.
	const PG_SOURCE = fs.readFileSync(
		path.join(__dirname, "migrations-pg.ts"),
		"utf-8",
	);

	it("declares every limit column in ensureSchemaPg's CREATE TABLE", () => {
		const createBlock = PG_SOURCE.slice(
			PG_SOURCE.indexOf("CREATE TABLE IF NOT EXISTS api_keys"),
		).slice(0, 1200);
		for (const column of LIMIT_COLUMNS) {
			expect(createBlock).toContain(column);
		}
	});

	it("adds every limit column in runMigrationsPg's columnsToAdd", () => {
		for (const column of LIMIT_COLUMNS) {
			expect(PG_SOURCE).toContain(`ALTER TABLE api_keys ADD COLUMN ${column} `);
		}
	});

	it("gives the PG columns no NOT NULL and no DEFAULT either", () => {
		// Same reason as SQLite: NULL is what "no limit" means, and a default
		// would hand every pre-existing key a budget on upgrade.
		for (const column of LIMIT_COLUMNS) {
			const idx = PG_SOURCE.indexOf(
				`ALTER TABLE api_keys ADD COLUMN ${column} `,
			);
			expect(idx).toBeGreaterThan(-1);
			const statement = PG_SOURCE.slice(idx, PG_SOURCE.indexOf('"', idx));
			expect(statement).not.toContain("NOT NULL");
			expect(statement).not.toContain("DEFAULT");
		}
	});
});
