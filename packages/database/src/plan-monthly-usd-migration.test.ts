/**
 * Tests for the accounts.plan_monthly_usd migration.
 *
 * plan_monthly_usd is the ACTUAL dollar price of the account's subscription
 * (NULL = unknown / not a paid plan). It is not the same thing as the
 * counterfactual plan_cost_usd computed per request.
 *
 * The interesting part of this migration is placement: runMigrations() contains
 * two legacy accounts-table rebuilds that copy a HARDCODED column list into an
 * `accounts_new` and drop the original —
 *   1. the "make refresh_token nullable" rebuild, and
 *   2. the `CREATE TABLE accounts_new AS SELECT ...` that removes account_tier.
 * A column added earlier in the same transaction is silently dropped by either
 * of them. The ADD COLUMN therefore runs last, against a freshly re-read
 * PRAGMA table_info(accounts). These tests pin that behaviour.
 */
import { Database } from "bun:sqlite";
import { afterEach, describe, expect, it } from "bun:test";
import { runMigrations } from "./migrations";

function accountsColumns(db: Database): string[] {
	return (
		db.prepare("PRAGMA table_info(accounts)").all() as Array<{ name: string }>
	).map((c) => c.name);
}

function planPriceColumnType(db: Database): string | undefined {
	return (
		db.prepare("PRAGMA table_info(accounts)").all() as Array<{
			name: string;
			type: string;
		}>
	).find((c) => c.name === "plan_monthly_usd")?.type;
}

function getPlanPrice(db: Database, id: string): number | null {
	const row = db
		.query<{ plan_monthly_usd: number | null }, [string]>(
			"SELECT plan_monthly_usd FROM accounts WHERE id = ?",
		)
		.get(id);
	return row ? row.plan_monthly_usd : null;
}

/**
 * A pre-migration accounts table WITHOUT plan_monthly_usd. `refresh_token` is
 * nullable here so the legacy rebuild does NOT fire — this is the plain
 * "existing database" upgrade path.
 */
function makeExistingDb(): Database {
	const db = new Database(":memory:");
	db.run(`
		CREATE TABLE accounts (
			id TEXT PRIMARY KEY,
			name TEXT NOT NULL,
			provider TEXT DEFAULT 'anthropic',
			api_key TEXT,
			refresh_token TEXT,
			access_token TEXT,
			expires_at INTEGER,
			created_at INTEGER NOT NULL,
			last_used INTEGER,
			request_count INTEGER DEFAULT 0,
			total_requests INTEGER DEFAULT 0,
			priority INTEGER DEFAULT 0,
			rate_limited_until INTEGER,
			session_start INTEGER,
			session_request_count INTEGER DEFAULT 0,
			paused INTEGER DEFAULT 0,
			rate_limit_reset INTEGER,
			rate_limit_status TEXT,
			rate_limit_remaining INTEGER,
			auto_fallback_enabled INTEGER DEFAULT 0,
			auto_refresh_enabled INTEGER DEFAULT 0,
			auto_pause_on_overage_enabled INTEGER DEFAULT 0,
			custom_endpoint TEXT,
			model_mappings TEXT,
			request_transformer TEXT,
			cross_region_mode TEXT,
			model_fallbacks TEXT,
			billing_type TEXT,
			pause_reason TEXT,
			requires_reauth INTEGER DEFAULT 0
		)
	`);
	return db;
}

/**
 * The legacy shape that triggers the "make refresh_token nullable" table
 * rebuild: refresh_token declared NOT NULL.
 */
function makeLegacyNotNullRefreshTokenDb(): Database {
	const db = new Database(":memory:");
	db.run(`
		CREATE TABLE accounts (
			id TEXT PRIMARY KEY,
			name TEXT NOT NULL,
			provider TEXT DEFAULT 'anthropic',
			api_key TEXT,
			refresh_token TEXT NOT NULL DEFAULT '',
			access_token TEXT,
			expires_at INTEGER,
			created_at INTEGER NOT NULL,
			last_used INTEGER,
			request_count INTEGER DEFAULT 0,
			total_requests INTEGER DEFAULT 0,
			priority INTEGER DEFAULT 0,
			rate_limited_until INTEGER,
			session_start INTEGER,
			session_request_count INTEGER DEFAULT 0,
			paused INTEGER DEFAULT 0,
			rate_limit_reset INTEGER,
			rate_limit_status TEXT,
			rate_limit_remaining INTEGER,
			auto_fallback_enabled INTEGER DEFAULT 0,
			custom_endpoint TEXT,
			auto_refresh_enabled INTEGER DEFAULT 0,
			model_mappings TEXT,
			request_transformer TEXT,
			cross_region_mode TEXT DEFAULT 'geographic',
			model_fallbacks TEXT
		)
	`);
	return db;
}

/**
 * The legacy shape that triggers the account_tier removal rebuild: an
 * account_tier column present on an otherwise current accounts table.
 */
function makeLegacyAccountTierDb(): Database {
	const db = makeExistingDb();
	db.run("ALTER TABLE accounts ADD COLUMN account_tier INTEGER DEFAULT 1");
	return db;
}

describe("Database migration — accounts.plan_monthly_usd", () => {
	let db: Database | null = null;

	afterEach(() => {
		db?.close();
		db = null;
	});

	it("creates the column on a fresh database", () => {
		db = new Database(":memory:");

		runMigrations(db);

		expect(accountsColumns(db)).toContain("plan_monthly_usd");
		expect(planPriceColumnType(db)).toBe("REAL");
	});

	it("adds the column to an existing database and preserves its rows", () => {
		db = makeExistingDb();
		db.run(`
			INSERT INTO accounts (id, name, created_at, billing_type)
			VALUES ('existing', 'existing', ${Date.now()}, 'plan')
		`);

		runMigrations(db);

		expect(accountsColumns(db)).toContain("plan_monthly_usd");
		const row = db
			.query<{ name: string; billing_type: string | null }, [string]>(
				"SELECT name, billing_type FROM accounts WHERE id = ?",
			)
			.get("existing");
		expect(row?.name).toBe("existing");
		expect(row?.billing_type).toBe("plan");
	});

	it("defaults to NULL for pre-existing rows", () => {
		db = makeExistingDb();
		db.run(`
			INSERT INTO accounts (id, name, created_at)
			VALUES ('no-price', 'no-price', ${Date.now()})
		`);

		runMigrations(db);

		expect(getPlanPrice(db, "no-price")).toBeNull();
	});

	it("defaults to NULL for rows inserted after the migration", () => {
		db = new Database(":memory:");
		runMigrations(db);

		db.run(`
			INSERT INTO accounts (id, name, created_at)
			VALUES ('fresh-row', 'fresh-row', ${Date.now()})
		`);

		expect(getPlanPrice(db, "fresh-row")).toBeNull();
	});

	it("survives the legacy refresh_token-nullable table rebuild", () => {
		db = makeLegacyNotNullRefreshTokenDb();
		db.run(`
			INSERT INTO accounts (id, name, created_at, refresh_token)
			VALUES ('legacy-rt', 'legacy-rt', ${Date.now()}, '')
		`);

		runMigrations(db);

		// The rebuild really did fire (refresh_token is nullable now)...
		const refreshTokenCol = (
			db.prepare("PRAGMA table_info(accounts)").all() as Array<{
				name: string;
				notnull: number;
			}>
		).find((c) => c.name === "refresh_token");
		expect(refreshTokenCol?.notnull).toBe(0);

		// ...and the column is still there afterwards.
		expect(accountsColumns(db)).toContain("plan_monthly_usd");
		expect(getPlanPrice(db, "legacy-rt")).toBeNull();
	});

	it("survives the legacy account_tier removal rebuild", () => {
		db = makeLegacyAccountTierDb();
		db.run(`
			INSERT INTO accounts (id, name, created_at, account_tier)
			VALUES ('legacy-tier', 'legacy-tier', ${Date.now()}, 5)
		`);

		runMigrations(db);

		// The rebuild really did fire (account_tier is gone)...
		expect(accountsColumns(db)).not.toContain("account_tier");
		// ...and the column is still there afterwards.
		expect(accountsColumns(db)).toContain("plan_monthly_usd");
		expect(getPlanPrice(db, "legacy-tier")).toBeNull();
	});

	it("stores and reads back a price, including 0", () => {
		db = new Database(":memory:");
		runMigrations(db);

		const now = Date.now();
		db.run(`
			INSERT INTO accounts (id, name, created_at) VALUES
				('paid', 'paid', ${now}),
				('free', 'free', ${now})
		`);
		db.run("UPDATE accounts SET plan_monthly_usd = 200.5 WHERE id = 'paid'");
		db.run("UPDATE accounts SET plan_monthly_usd = 0 WHERE id = 'free'");

		expect(getPlanPrice(db, "paid")).toBe(200.5);
		expect(getPlanPrice(db, "free")).toBe(0);
	});

	it("is idempotent — a second migration pass keeps the stored value", () => {
		db = makeExistingDb();
		db.run(`
			INSERT INTO accounts (id, name, created_at)
			VALUES ('idem', 'idem', ${Date.now()})
		`);

		runMigrations(db);
		db.run("UPDATE accounts SET plan_monthly_usd = 100 WHERE id = 'idem'");

		expect(() => {
			runMigrations(db as Database);
		}).not.toThrow();
		expect(getPlanPrice(db, "idem")).toBe(100);
	});
});
