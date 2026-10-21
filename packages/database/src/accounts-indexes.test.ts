/**
 * Index set on the `accounts` table (SQLite).
 *
 * The accounts table is rebuilt twice by runMigrations() on upgraded
 * databases (refresh_token NOT NULL -> nullable, and account_tier removal),
 * via `DROP TABLE accounts` + `CREATE TABLE accounts_new AS SELECT` + RENAME.
 * `DROP TABLE` takes every index with it and `AS SELECT` keeps no constraints,
 * so both rebuilds must leave a complete, working index set behind on the very
 * same startup. These tests pin that, plus the shape of the priority composite
 * that the rebuild blocks used to shadow with a single-column index.
 */
import { Database } from "bun:sqlite";
import { afterEach, describe, expect, it } from "bun:test";
import { ensureSchema, runMigrations } from "./migrations";
import { addPerformanceIndexes } from "./performance-indexes";

/**
 * The accounts indexes owned by addPerformanceIndexes() (performance-indexes.ts).
 * Every migrated database must have all of them — on a rebuilt table too.
 */
const ACCOUNTS_PERFORMANCE_INDEXES = [
	"idx_accounts_paused",
	"idx_accounts_name",
	"idx_accounts_rate_limited",
	"idx_accounts_session",
	"idx_accounts_request_count",
	"idx_accounts_priority",
] as const;

const EXPECTED_PRIORITY_COLUMNS = [
	{ name: "priority", desc: 1 },
	{ name: "request_count", desc: 1 },
	{ name: "last_used", desc: 0 },
];

/**
 * Indexes that only the two table rebuilds create (a fresh database never runs
 * a rebuild), so they are only asserted for upgraded databases.
 */
const REBUILD_ONLY_INDEXES = [
	"idx_accounts_id",
	"idx_accounts_provider",
	"idx_accounts_last_used",
] as const;

function indexSql(db: Database, name: string): string | null {
	const row = db
		.prepare(
			"SELECT sql FROM sqlite_master WHERE type='index' AND tbl_name='accounts' AND name = ?",
		)
		.get(name) as { sql: string | null } | null;
	return row?.sql ?? null;
}

function accountsIndexNames(db: Database): string[] {
	return (
		db
			.prepare(
				"SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='accounts' AND name NOT LIKE 'sqlite_autoindex%' ORDER BY name",
			)
			.all() as Array<{ name: string }>
	).map((r) => r.name);
}

function indexColumns(
	db: Database,
	name: string,
): Array<{
	name: string;
	desc: number;
}> {
	return (
		db.prepare(`PRAGMA index_xinfo(${name})`).all() as Array<{
			seqno: number;
			cid: number;
			key: number;
			name: string | null;
			desc: number;
		}>
	)
		.filter((c) => c.key === 1 && c.name !== null)
		.sort((a, b) => a.seqno - b.seqno)
		.map((c) => ({ name: c.name as string, desc: c.desc }));
}

function columnNames(db: Database): string[] {
	return (
		db.prepare("PRAGMA table_info(accounts)").all() as Array<{ name: string }>
	)
		.map((c) => c.name)
		.sort();
}

function queryPlan(db: Database, sql: string): string {
	return (
		db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all() as Array<{ detail: string }>
	)
		.map((r) => r.detail)
		.join("\n");
}

/**
 * Replace `accounts` with a legacy table (as older releases shipped it) so
 * runMigrations() exercises one or both table rebuilds.
 *
 * `refreshTokenNotNull` reproduces the pre-rebuild schema; `accountTier` adds
 * the column whose removal triggers the second rebuild. Dropping a column
 * instead is not an option: other tables (combo_slots, requests, …) reference
 * `accounts` once ensureSchema() has run.
 */
function simulateLegacyAccounts(
	db: Database,
	opts: { accountTier: boolean; refreshTokenNotNull: boolean },
): void {
	db.run("PRAGMA foreign_keys = OFF");
	db.run("DROP TABLE IF EXISTS accounts");
	db.run(`
		CREATE TABLE accounts (
			id TEXT PRIMARY KEY,
			name TEXT NOT NULL,
			provider TEXT DEFAULT 'anthropic',
			api_key TEXT,
			refresh_token TEXT ${opts.refreshTokenNotNull ? "NOT NULL" : ""},
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
			usage_pause_weekly_enabled INTEGER NOT NULL DEFAULT 0${opts.accountTier ? ",\n\t\t\taccount_tier TEXT" : ""}
		)
	`);
	db.run("PRAGMA foreign_keys = ON");
}

const DASHBOARD_LIST_SQL =
	"SELECT * FROM accounts ORDER BY priority DESC, request_count DESC LIMIT 10";

function expectAllAccountsIndexesPresent(db: Database): void {
	const names = accountsIndexNames(db);
	for (const name of [
		...ACCOUNTS_PERFORMANCE_INDEXES,
		...REBUILD_ONLY_INDEXES,
	]) {
		expect(names).toContain(name);
	}
}

describe("accounts index set (SQLite)", () => {
	let db: Database;

	const open = () => {
		db = new Database(":memory:");
		return db;
	};

	afterEach(() => {
		db.close();
	});

	it("fresh database gets the composite priority index, not the single-column one", () => {
		const db = open();
		ensureSchema(db);
		runMigrations(db);

		expect(indexColumns(db, "idx_accounts_priority")).toEqual(
			EXPECTED_PRIORITY_COLUMNS,
		);
		for (const name of ACCOUNTS_PERFORMANCE_INDEXES) {
			expect(indexSql(db, name)).not.toBeNull();
		}
	});

	it("refresh_token rebuild recreates the UNIQUE id index that CREATE TABLE AS SELECT drops", () => {
		const db = open();
		simulateLegacyAccounts(db, {
			accountTier: false,
			refreshTokenNotNull: true,
		});
		db.prepare(
			"INSERT INTO accounts (id, name, provider, refresh_token, created_at) VALUES (?, ?, ?, ?, ?)",
		).run("legacy-1", "legacy", "anthropic", "rt", Date.now());
		expect(() => runMigrations(db)).not.toThrow();

		const cols = db.prepare("PRAGMA table_info(accounts)").all() as Array<{
			name: string;
			notnull: number;
			pk: number;
		}>;
		expect(cols.find((c) => c.name === "refresh_token")?.notnull).toBe(0);
		// The rebuild's `CREATE TABLE accounts_new (…)` keeps the PRIMARY KEY,
		// so the unique index is redundant here — but it is re-created to match
		// the account_tier rebuild, which does lose the PK.
		expect(cols.find((c) => c.name === "id")?.pk).toBe(1);
		expect(indexSql(db, "idx_accounts_id") ?? "").toContain("UNIQUE");
		expect(() =>
			db
				.prepare(
					"INSERT INTO accounts (id, name, provider, created_at) VALUES (?, ?, ?, ?)",
				)
				.run("legacy-1", "dup", "anthropic", Date.now()),
		).toThrow();
	});

	it("upgraded legacy database has the full index set after a single startup", () => {
		const db = open();
		ensureSchema(db);
		// Simulate a pre-account_tier-removal database: the column exists, the
		// legacy single-column indexes exist, and the composite does not.
		db.prepare("ALTER TABLE accounts ADD COLUMN account_tier TEXT").run();
		db.run("CREATE INDEX idx_accounts_priority ON accounts(priority)");
		db.run("CREATE INDEX idx_accounts_name ON accounts(name)");
		db.run("CREATE UNIQUE INDEX idx_accounts_id ON accounts(id)");
		db.prepare(
			"INSERT INTO accounts (id, name, provider, created_at, account_tier) VALUES (?, ?, ?, ?, ?)",
		).run("legacy-1", "legacy", "anthropic", Date.now(), "pro");

		runMigrations(db);

		expectAllAccountsIndexesPresent(db);
		// The single-column index created before the rebuild must not survive.
		expect(indexColumns(db, "idx_accounts_priority")).toEqual(
			EXPECTED_PRIORITY_COLUMNS,
		);
		// Data survived the rebuild.
		expect(
			db.prepare("SELECT name FROM accounts WHERE id = ?").get("legacy-1"),
		).toEqual({ name: "legacy" });
		expect(
			(
				db.prepare("PRAGMA table_info(accounts)").all() as Array<{
					name: string;
				}>
			).map((c) => c.name),
		).not.toContain("account_tier");
	});

	it("account_tier rebuild re-creates every index that lived on the rebuilt table", () => {
		// A legacy database carrying only the legacy single-column indexes. The
		// account_tier rebuild drops the whole accounts table, and every index on
		// it with it. The end-of-migration pass must put the performance indexes
		// back before the transaction commits — otherwise they stay missing until
		// the next startup. (The UNIQUE (name, provider, endpoint) index cannot be
		// set up from here: it is created inside the migration before the
		// rebuild, so it is already on the table when the rebuild drops it.)
		const db = open();
		simulateLegacyAccounts(db, {
			accountTier: true,
			refreshTokenNotNull: false,
		});
		db.run("CREATE INDEX idx_accounts_priority ON accounts(priority)");
		db.run("CREATE INDEX idx_accounts_name ON accounts(name)");
		db.run("CREATE UNIQUE INDEX idx_accounts_id ON accounts(id)");
		db.prepare(
			"INSERT INTO accounts (id, name, provider, refresh_token, created_at, account_tier) VALUES (?, ?, ?, ?, ?, ?)",
		).run("legacy-1", "legacy", "anthropic", "rt", Date.now(), "pro");

		runMigrations(db);

		expectAllAccountsIndexesPresent(db);
		// The single-column index created before the rebuild must not survive.
		expect(indexColumns(db, "idx_accounts_priority")).toEqual(
			EXPECTED_PRIORITY_COLUMNS,
		);
		// Data survived the rebuild.
		expect(
			db.prepare("SELECT name FROM accounts WHERE id = ?").get("legacy-1"),
		).toEqual({ name: "legacy" });
		expect(
			(
				db.prepare("PRAGMA table_info(accounts)").all() as Array<{
					name: string;
				}>
			).map((c) => c.name),
		).not.toContain("account_tier");
	});

	it("legacy single-column priority index is replaced by the composite", () => {
		const db = open();
		ensureSchema(db);
		db.prepare("ALTER TABLE accounts ADD COLUMN account_tier TEXT").run();
		db.run("CREATE INDEX idx_accounts_priority ON accounts(priority)");

		runMigrations(db);

		expect(indexColumns(db, "idx_accounts_priority")).toHaveLength(3);
	});

	it("replaces a stale priority index on a database that needs no rebuild", () => {
		// The upgrade path the rebuild tests miss: no `account_tier`, so no
		// table rebuild runs and `IF NOT EXISTS` alone would leave the old
		// definition in place forever.
		for (const legacySql of [
			"CREATE INDEX idx_accounts_priority ON accounts(priority)",
			"CREATE INDEX idx_accounts_priority ON accounts(priority ASC, request_count DESC, last_used)",
		]) {
			const db = open();
			ensureSchema(db);
			db.run(legacySql);

			runMigrations(db);

			expect(indexColumns(db, "idx_accounts_priority")).toEqual(
				EXPECTED_PRIORITY_COLUMNS,
			);
			db.close();
		}
	});

	it("account_tier rebuild keeps every column, not a hardcoded subset", () => {
		// A fixed column list in the `CREATE TABLE AS SELECT` silently truncates
		// the table. Later stages of the same migration read those columns — the
		// dedup merge orders by refresh_token_issued_at — so a truncated table
		// turns a data-cleanup step into a startup failure.
		//
		// Reference: the same migration run without a rebuild. That is the
		// authoritative post-migration column set, and it never goes through the
		// buggy copy.
		const reference = open();
		ensureSchema(reference);
		runMigrations(reference);
		const expected = columnNames(reference);

		const db = open();
		ensureSchema(db);
		db.prepare("ALTER TABLE accounts ADD COLUMN account_tier TEXT").run();
		runMigrations(db);

		expect(columnNames(db)).toEqual(expected);
	});

	it("account_tier rebuild after the refresh_token rebuild keeps real columns, not literals", () => {
		// Both rebuilds on one database. The refresh_token rebuild already
		// used `CREATE TABLE ... AS SELECT`, so by the time the account_tier
		// rebuild runs, columns the migration snapshot still lists are gone.
		// Selecting a missing name yields a string literal, and Bun's SQLite
		// then creates a column literally named `"billing_type"` while
		// `billing_type` itself is lost.
		const reference = open();
		ensureSchema(reference);
		runMigrations(reference);
		const expected = columnNames(reference);

		const db = open();
		simulateLegacyAccounts(db, {
			accountTier: true,
			refreshTokenNotNull: true,
		});
		db.prepare(
			"INSERT INTO accounts (id, name, provider, refresh_token, created_at, billing_type, account_tier) VALUES (?, ?, ?, ?, ?, ?, ?)",
		).run("legacy-1", "legacy", "anthropic", "rt", Date.now(), "plan", "pro");

		expect(() => runMigrations(db)).not.toThrow();

		// No literal-named columns, and the full expected set.
		expect(columnNames(db).filter((n) => n.includes('"'))).toEqual([]);
		expect(columnNames(db)).toEqual(expected);
		// The row survived. Only identity is asserted: provider is rewritten by
		// a later migration and refresh-token columns are blanked by a legacy
		// VALUE migration, so neither reflects the first rebuild. What this
		// test guards is the column SET (above) — the failure mode it replaces
		// silently dropped whole columns and created literal-named ones.
		expect(
			db.prepare("SELECT id, name FROM accounts WHERE id = ?").get("legacy-1"),
		).toEqual({ id: "legacy-1", name: "legacy" });
	});

	it("legacy upgrade with a provider collision completes instead of throwing", () => {
		// Two rows that are unique under their old providers but collide once the
		// muse-spark -> meta rewrite runs. The rebuild drops the UNIQUE index
		// first, so the collision only surfaces at the end-of-migration
		// re-creation, which has to merge the duplicates rather than abort.
		const db = open();
		ensureSchema(db);
		db.prepare("ALTER TABLE accounts ADD COLUMN account_tier TEXT").run();
		const now = Date.now();
		const insert = db.prepare(
			"INSERT INTO accounts (id, name, provider, refresh_token, created_at, account_tier) VALUES (?, ?, ?, ?, ?, ?)",
		);
		insert.run("collide-1", "shared", "muse-spark", "rt1", now - 1000, "pro");
		insert.run("collide-2", "shared", "meta", "rt2", now, "pro");

		expect(() => runMigrations(db)).not.toThrow();

		const survivors = db
			.prepare("SELECT id, provider FROM accounts WHERE name = 'shared'")
			.all() as Array<{ id: string; provider: string }>;
		expect(survivors).toHaveLength(1);
		expect(survivors[0]?.provider).toBe("meta");
	});

	it("keeps the UNIQUE account index when the account_tier rebuild drops it", () => {
		// The uniqueness block runs before the rebuild, so the rebuild's DROP
		// TABLE removes the index it just created. Without the end-of-migration
		// re-run, duplicate accounts are accepted for a whole startup cycle.
		const db = open();
		ensureSchema(db);
		db.prepare("ALTER TABLE accounts ADD COLUMN account_tier TEXT").run();
		db.prepare(
			"INSERT INTO accounts (id, name, provider, refresh_token, created_at, account_tier) VALUES (?, ?, ?, ?, ?, ?)",
		).run("legacy-1", "dave", "anthropic", "rt", Date.now(), "pro");

		runMigrations(db);

		expect(
			db
				.prepare(
					`SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_accounts_unique_name_provider_endpoint'`,
				)
				.get(),
		).toBeDefined();
		// Constraint is live, not just present in sqlite_master. Use the
		// provider the surviving row actually carries: migrations rewrite a
		// legacy 'anthropic' provider to the console equivalent.
		const survivor = db
			.prepare("SELECT provider FROM accounts WHERE id = 'legacy-1'")
			.get() as { provider: string };
		expect(() =>
			db
				.prepare(
					"INSERT INTO accounts (id, name, provider, refresh_token, created_at) VALUES (?, ?, ?, ?, ?)",
				)
				.run("legacy-2", "dave", survivor.provider, "rt2", Date.now()),
		).toThrow();
	});

	it("dashboard list ORDER BY priority DESC, request_count DESC scans the composite without a temp b-tree", () => {
		const db = open();
		ensureSchema(db);
		for (let i = 0; i < 50; i++) {
			db.prepare(
				"INSERT INTO accounts (id, name, provider, created_at, priority, request_count) VALUES (?, ?, ?, ?, ?, ?)",
			).run(`a${i}`, `acct${i}`, "anthropic", i, i % 5, i);
		}
		runMigrations(db);

		const plan = queryPlan(db, DASHBOARD_LIST_SQL);
		expect(plan).toContain("idx_accounts_priority");
		// `(priority ASC, request_count DESC, last_used)` could only be scanned
		// backwards to priority DESC, which yields request_count ASC — so SQLite
		// sorted the second term. `(priority DESC, request_count DESC)` matches
		// the query's ordering exactly.
		expect(plan).not.toContain("TEMP B-TREE");
	});

	it("proves the legacy key order needed a temp b-tree", () => {
		const db = open();
		ensureSchema(db);
		db.run(
			"CREATE INDEX idx_accounts_priority ON accounts(priority ASC, request_count DESC, last_used)",
		);
		const plan = queryPlan(db, DASHBOARD_LIST_SQL);
		expect(plan).toContain("idx_accounts_priority");
		expect(plan).toContain("TEMP B-TREE");
	});

	it("ACCOUNTS_PERFORMANCE_INDEXES covers exactly what addPerformanceIndexes creates", () => {
		// Guard against a future index added to addPerformanceIndexes() without
		// being asserted here — the rebuild test is what proves it survives a
		// table rebuild.
		const db = open();
		ensureSchema(db);
		runMigrations(db);
		// addPerformanceIndexes() also indexes columns that only runMigrations()
		// adds (accounts.paused, …), so migrate first and then drop just the
		// accounts indexes it owns.
		for (const name of ACCOUNTS_PERFORMANCE_INDEXES) {
			db.run(`DROP INDEX ${name}`);
		}
		addPerformanceIndexes(db);
		expect(
			accountsIndexNames(db).filter(
				(n) => n !== "idx_accounts_unique_name_provider_endpoint",
			),
		).toEqual([...ACCOUNTS_PERFORMANCE_INDEXES].sort());
	});
});
