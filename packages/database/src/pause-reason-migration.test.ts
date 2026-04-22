/**
 * Tests for the pause_reason migration backfill (issue #139).
 *
 * When the pause_reason column is first added by runMigrations():
 *  - Paused accounts with auto_pause_on_overage_enabled=1  → pause_reason='overage'
 *  - Paused accounts with auto_pause_on_overage_enabled=0  → pause_reason='manual'
 *  - Unpaused accounts                                      → pause_reason=NULL
 */
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { runMigrations } from "./migrations";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build an in-memory database that looks like a pre-pause_reason schema:
 * the accounts table exists but the pause_reason column is absent.
 */
function makePreMigrationDb(): Database {
	const db = new Database(":memory:");

	// Create the accounts table *without* pause_reason (simulates old schema)
	db.run(`
		CREATE TABLE accounts (
			id TEXT PRIMARY KEY,
			name TEXT NOT NULL,
			provider TEXT DEFAULT 'anthropic',
			api_key TEXT,
			refresh_token TEXT DEFAULT '',
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

interface PauseRow {
	id: string;
	paused: number;
	pause_reason: string | null;
}

function getAccount(db: Database, id: string): PauseRow {
	return db
		.query<PauseRow, [string]>(
			"SELECT id, paused, pause_reason FROM accounts WHERE id = ?",
		)
		.get(id) as PauseRow;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Database migration — pause_reason backfill (issue #139)", () => {
	let db: Database;

	beforeEach(() => {
		db = makePreMigrationDb();
	});

	afterEach(() => {
		db.close();
	});

	it("adds the pause_reason column during migration", () => {
		runMigrations(db);

		const cols = db.prepare("PRAGMA table_info(accounts)").all() as Array<{
			name: string;
		}>;
		const names = cols.map((c) => c.name);

		expect(names).toContain("pause_reason");
	});

	it("backfills pause_reason='overage' for paused accounts with auto_pause_on_overage_enabled=1", () => {
		db.run(`
			INSERT INTO accounts (id, name, created_at, paused, auto_pause_on_overage_enabled)
			VALUES ('overage-acc', 'overage-acc', ${Date.now()}, 1, 1)
		`);

		runMigrations(db);

		const row = getAccount(db, "overage-acc");
		expect(row.paused).toBe(1);
		expect(row.pause_reason).toBe("overage");
	});

	it("backfills pause_reason='manual' for paused accounts with auto_pause_on_overage_enabled=0", () => {
		db.run(`
			INSERT INTO accounts (id, name, created_at, paused, auto_pause_on_overage_enabled)
			VALUES ('manual-acc', 'manual-acc', ${Date.now()}, 1, 0)
		`);

		runMigrations(db);

		const row = getAccount(db, "manual-acc");
		expect(row.paused).toBe(1);
		expect(row.pause_reason).toBe("manual");
	});

	it("leaves pause_reason=NULL for unpaused accounts", () => {
		db.run(`
			INSERT INTO accounts (id, name, created_at, paused, auto_pause_on_overage_enabled)
			VALUES ('active-acc', 'active-acc', ${Date.now()}, 0, 1)
		`);

		runMigrations(db);

		const row = getAccount(db, "active-acc");
		expect(row.paused).toBe(0);
		expect(row.pause_reason).toBeNull();
	});

	it("handles mixed accounts in a single migration pass", () => {
		const now = Date.now();
		db.run(`
			INSERT INTO accounts (id, name, created_at, paused, auto_pause_on_overage_enabled)
			VALUES
				('overage-1', 'overage-1', ${now}, 1, 1),
				('manual-1',  'manual-1',  ${now}, 1, 0),
				('active-1',  'active-1',  ${now}, 0, 0),
				('active-2',  'active-2',  ${now}, 0, 1)
		`);

		runMigrations(db);

		const overage1 = getAccount(db, "overage-1");
		const manual1 = getAccount(db, "manual-1");
		const active1 = getAccount(db, "active-1");
		const active2 = getAccount(db, "active-2");

		expect(overage1.pause_reason).toBe("overage");
		expect(manual1.pause_reason).toBe("manual");
		expect(active1.pause_reason).toBeNull();
		expect(active2.pause_reason).toBeNull();
	});

	it("is idempotent — running migrations twice does not corrupt pause_reason", () => {
		const now = Date.now();
		db.run(`
			INSERT INTO accounts (id, name, created_at, paused, auto_pause_on_overage_enabled)
			VALUES ('overage-idem', 'overage-idem', ${now}, 1, 1)
		`);

		runMigrations(db);

		// Second run should be a no-op since the column already exists
		expect(() => runMigrations(db)).not.toThrow();

		const row = getAccount(db, "overage-idem");
		expect(row.pause_reason).toBe("overage");
	});

	it("treats accounts with NULL auto_pause_on_overage_enabled as 0 (COALESCE safety)", () => {
		const now = Date.now();
		// Insert without setting auto_pause_on_overage_enabled — defaults to 0
		db.run(`
			INSERT INTO accounts (id, name, created_at, paused)
			VALUES ('null-overage-acc', 'null-overage-acc', ${now}, 1)
		`);
		// Explicitly set to NULL to test COALESCE
		db.run(
			"UPDATE accounts SET auto_pause_on_overage_enabled = NULL WHERE id = 'null-overage-acc'",
		);

		runMigrations(db);

		const row = getAccount(db, "null-overage-acc");
		expect(row.paused).toBe(1);
		// COALESCE(NULL, 0) = 0 → treated as no overage flag → 'manual'
		expect(row.pause_reason).toBe("manual");
	});
});
