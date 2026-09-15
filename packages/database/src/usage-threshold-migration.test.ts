/**
 * Tests for the usage-pause threshold columns added by runMigrations().
 *
 * The interesting case is a legacy database whose `refresh_token` is still
 * NOT NULL. runMigrations() rebuilds the accounts table to relax that column,
 * copying a fixed column list into the replacement table — so a column added
 * before the rebuild is dropped when the new table takes over, and every later
 * query naming it fails with "no such column". These columns must therefore
 * survive that path, with the account rows intact.
 */
import { Database } from "bun:sqlite";
import { afterEach, describe, expect, it } from "bun:test";
import { runMigrations } from "./migrations";

/** A database from before the thresholds existed, with refresh_token nullable. */
function makeModernDb(): Database {
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
			cross_region_mode TEXT,
			model_fallbacks TEXT,
			billing_type TEXT
		)
	`);
	return db;
}

/** The same, but with the legacy NOT NULL refresh_token that forces a rebuild. */
function makeLegacyDb(): Database {
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
			auto_refresh_enabled INTEGER DEFAULT 0,
			auto_pause_on_overage_enabled INTEGER DEFAULT 0,
			custom_endpoint TEXT,
			model_mappings TEXT,
			cross_region_mode TEXT,
			model_fallbacks TEXT,
			billing_type TEXT
		)
	`);
	return db;
}

function columnNames(db: Database): string[] {
	return (
		db.prepare("PRAGMA table_info(accounts)").all() as Array<{
			name: string;
		}>
	).map((col) => col.name);
}

describe("usage-pause threshold columns", () => {
	let db: Database | null = null;

	afterEach(() => {
		db?.close();
		db = null;
	});

	it("adds both columns to a database that has never seen them", () => {
		db = makeModernDb();

		runMigrations(db);

		expect(columnNames(db)).toContain("usage_pause_five_hour_threshold");
		expect(columnNames(db)).toContain("usage_pause_weekly_threshold");
	});

	it("survives the legacy refresh_token rebuild, which drops columns added before it", () => {
		db = makeLegacyDb();
		db.run(
			`INSERT INTO accounts (id, name, created_at, refresh_token) VALUES ('acc-1', 'legacy', ?, 'tok')`,
			[Date.now()],
		);

		runMigrations(db);

		expect(columnNames(db)).toContain("usage_pause_five_hour_threshold");
		expect(columnNames(db)).toContain("usage_pause_weekly_threshold");
		// The query shape the account repository uses must not throw.
		expect(
			db
				.query(
					"SELECT usage_pause_five_hour_threshold, usage_pause_weekly_threshold FROM accounts WHERE id = ?",
				)
				.get("acc-1"),
		).toStrictEqual({
			usage_pause_five_hour_threshold: null,
			usage_pause_weekly_threshold: null,
		});
	});

	it("defaults to NULL, so existing accounts keep their current behaviour", () => {
		db = makeModernDb();
		db.run(
			`INSERT INTO accounts (id, name, created_at) VALUES ('acc-1', 'existing', ?)`,
			[Date.now()],
		);

		runMigrations(db);

		expect(
			db
				.query(
					"SELECT usage_pause_five_hour_threshold AS fiveHour, usage_pause_weekly_threshold AS weekly FROM accounts WHERE id = ?",
				)
				.get("acc-1"),
		).toStrictEqual({ fiveHour: null, weekly: null });
	});

	it("switches an existing threshold on, since setting one used to mean it was in force", () => {
		// A database from the revision that had the percentages but not yet the
		// on/off flags.
		db = makeModernDb();
		db.run(
			"ALTER TABLE accounts ADD COLUMN usage_pause_five_hour_threshold INTEGER",
		);
		db.run(
			"ALTER TABLE accounts ADD COLUMN usage_pause_weekly_threshold INTEGER",
		);
		db.run(
			`INSERT INTO accounts (id, name, created_at, usage_pause_five_hour_threshold) VALUES ('acc-set', 'had-threshold', ?, 80)`,
			[Date.now()],
		);
		db.run(
			`INSERT INTO accounts (id, name, created_at) VALUES ('acc-unset', 'no-threshold', ?)`,
			[Date.now()],
		);

		runMigrations(db);

		expect(
			db
				.query(
					"SELECT usage_pause_five_hour_threshold AS pct, usage_pause_five_hour_enabled AS five, usage_pause_weekly_enabled AS week FROM accounts WHERE id = ?",
				)
				.get("acc-set"),
		).toStrictEqual({ pct: 80, five: 1, week: 0 });
		expect(
			db
				.query(
					"SELECT usage_pause_five_hour_enabled AS five, usage_pause_weekly_enabled AS week FROM accounts WHERE id = ?",
				)
				.get("acc-unset"),
		).toStrictEqual({ five: 0, week: 0 });
	});

	it("defaults the enabled flags to off for a database that never had a threshold", () => {
		db = makeModernDb();
		db.run(
			`INSERT INTO accounts (id, name, created_at) VALUES ('acc-1', 'fresh', ?)`,
			[Date.now()],
		);

		runMigrations(db);

		expect(
			db
				.query(
					"SELECT usage_pause_five_hour_enabled AS five, usage_pause_weekly_enabled AS week FROM accounts WHERE id = ?",
				)
				.get("acc-1"),
		).toStrictEqual({ five: 0, week: 0 });
	});

	it("leaves a switched-off window off on later runs, percentage and all", () => {
		// The backfill exists for the one run that adds the flags. After that,
		// `enabled = 0` with a percentage still stored is a deliberate "off" —
		// re-running it would switch the window back on behind its owner and
		// pause the account unexpectedly.
		db = makeModernDb();

		runMigrations(db);
		db.run(
			`INSERT INTO accounts (id, name, created_at, usage_pause_five_hour_threshold, usage_pause_five_hour_enabled) VALUES ('acc-off', 'switched-off', ?, 80, 0)`,
			[Date.now()],
		);

		runMigrations(db);

		expect(
			db
				.query(
					"SELECT usage_pause_five_hour_threshold AS pct, usage_pause_five_hour_enabled AS on_ FROM accounts WHERE id = ?",
				)
				.get("acc-off"),
		).toStrictEqual({ pct: 80, on_: 0 });
	});

	it("is idempotent across repeated runs", () => {
		db = makeModernDb();

		runMigrations(db);
		db.run(
			`INSERT INTO accounts (id, name, created_at, usage_pause_five_hour_threshold) VALUES ('acc-1', 'kept', ?, 80)`,
			[Date.now()],
		);
		runMigrations(db);

		expect(
			db
				.query(
					"SELECT usage_pause_five_hour_threshold AS fiveHour FROM accounts WHERE id = ?",
				)
				.get("acc-1"),
		).toStrictEqual({ fiveHour: 80 });
	});
});
