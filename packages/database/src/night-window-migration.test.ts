/**
 * Tests for the `accounts.night_window_enabled` column.
 *
 * The column must survive both accounts-table rebuilds (refresh_token NOT NULL
 * relaxation and account_tier removal), because the account_tier rebuild is a
 * `CREATE TABLE AS SELECT` over a column list that predates it. The setter
 * must persist, and a newly created account must default to disabled.
 */
import { Database } from "bun:sqlite";
import { afterAll, describe, expect, it } from "bun:test";
import "@better-ccflare/core";
import { cleanupTempDbs, tempDbPath } from "./__test-utils__/temp-db";
import type { BunSqlAdapter } from "./adapters/bun-sql-adapter";
import { DatabaseOperations } from "./database-operations";
import { ensureSchema, runMigrations } from "./migrations";

/**
 * A real DatabaseOperations over a temp DB file (the constructor opens a path,
 * not a handle, and runs the schema + migrations itself).
 */
async function makeDbOps(): Promise<DatabaseOperations> {
	const dbOps = new DatabaseOperations(tempDbPath("night-window"), {
		walMode: false,
	});
	// biome-ignore lint/suspicious/noExplicitAny: reach the private adapter to seed schema
	const adapter = (dbOps as any).adapter as BunSqlAdapter;
	// The constructor already ran ensureSchema + runMigrations on the file.
	await adapter.unsafe(
		"INSERT INTO accounts (id, name, provider, created_at) VALUES ('nw-1', 'nightly', 'sailresearch', 1)",
	);
	return dbOps;
}

afterAll(() => cleanupTempDbs());

function columnNames(db: Database): string[] {
	return (
		db.prepare("PRAGMA table_info(accounts)").all() as Array<{ name: string }>
	).map((c) => c.name);
}

/** A pre-night-window database whose refresh_token is still NOT NULL. */
function makeLegacyDb(withAccountTier: boolean): Database {
	const db = new Database(":memory:");
	db.run(`
		CREATE TABLE accounts (
			id TEXT PRIMARY KEY,
			name TEXT NOT NULL,
			provider TEXT DEFAULT 'anthropic',
			api_key TEXT,
			refresh_token TEXT NOT NULL,
			access_token TEXT,
			expires_at INTEGER,
			created_at INTEGER NOT NULL,
			last_used INTEGER,
			request_count INTEGER DEFAULT 0,
			total_requests INTEGER DEFAULT 0,
			priority INTEGER DEFAULT 0,
			consecutive_rate_limits INTEGER NOT NULL DEFAULT 0,
			requires_reauth INTEGER DEFAULT 0,
			last_manual_reauth_at INTEGER,
			request_transformer TEXT,
			custom_endpoint TEXT,
			billing_type TEXT,
			refresh_token_issued_at INTEGER,
			peak_hours_pause_enabled INTEGER NOT NULL DEFAULT 0,
			usage_pause_five_hour_threshold INTEGER,
			usage_pause_weekly_threshold INTEGER,
			usage_pause_five_hour_enabled INTEGER NOT NULL DEFAULT 0,
			usage_pause_weekly_enabled INTEGER NOT NULL DEFAULT 0${withAccountTier ? ",\n\t\t\taccount_tier TEXT" : ""}
		)
	`);
	return db;
}

describe("night_window_enabled migration", () => {
	it("is added by runMigrations on a legacy database", () => {
		const db = makeLegacyDb(false);
		runMigrations(db);
		expect(columnNames(db)).toContain("night_window_enabled");
	});

	it("survives the refresh_token rebuild and the account_tier rebuild", () => {
		const reference = new Database(":memory:");
		ensureSchema(reference);
		runMigrations(reference);
		const expected = columnNames(reference);
		expect(expected).toContain("night_window_enabled");

		const db = makeLegacyDb(true);
		db.prepare(
			"INSERT INTO accounts (id, name, provider, refresh_token, created_at, account_tier) VALUES (?, ?, ?, ?, ?, ?)",
		).run("legacy-1", "legacy", "anthropic", "rt", Date.now(), "pro");

		expect(() => runMigrations(db)).not.toThrow();
		// The account_tier rebuild recreates the table, so column order differs.
		expect(new Set(columnNames(db))).toEqual(new Set(expected));
	});

	it("defaults to disabled for a newly created account", async () => {
		const dbOps = await makeDbOps();
		try {
			expect((await dbOps.getAccount("nw-1"))?.night_window_enabled).toBe(
				false,
			);
		} finally {
			await dbOps.dispose();
		}
	});

	it("setNightWindowEnabled persists and reads back", async () => {
		const dbOps = await makeDbOps();
		try {
			await dbOps.setNightWindowEnabled("nw-1", true);
			expect((await dbOps.getAccount("nw-1"))?.night_window_enabled).toBe(true);

			await dbOps.setNightWindowEnabled("nw-1", false);
			expect((await dbOps.getAccount("nw-1"))?.night_window_enabled).toBe(
				false,
			);
		} finally {
			await dbOps.dispose();
		}
	});
});
