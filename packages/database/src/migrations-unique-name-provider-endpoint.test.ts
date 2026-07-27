import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { ensureSchema, runMigrations } from "../src/migrations";

/**
 * Migration tests for `idx_accounts_unique_name_provider_endpoint` — the DB
 * constraint that closes the Greptile P1 race in account add paths.
 *
 * What this proves:
 *   (a) The migration is idempotent — running `runMigrations` twice does
 *       not re-create the index or fail.
 *   (b) The migration COLLAPSES pre-existing duplicates to the oldest row
 *       per tuple (min rowid) before creating the UNIQUE index. Without
 *       this dedup, the CREATE UNIQUE INDEX step would fail on tables
 *       that already have duplicates — i.e. the wild. This is the
 *       load-bearing step.
 *   (c) After migration, the constraint actually rejects a bare INSERT
 *       of a tuple that already exists, and the error message matches
 *       the pattern the http-api handlers' `isUniqueConstraintError`
 *       recognises.
 *   (d) NEGATIVE CONTROL: an attempt to CREATE UNIQUE INDEX without the
 *       dedup step FAILS on seeded duplicates — proves the dedup is the
 *       step that makes the constraint enforceable on legacy data.
 */
describe("Database Migrations — UNIQUE index on (name, provider, COALESCE(custom_endpoint,''))", () => {
	let db: Database;

	beforeEach(() => {
		db = new Database(":memory:");
	});

	afterEach(() => {
		db.close();
	});

	it("creates the UNIQUE index on a fresh schema with no rows", () => {
		ensureSchema(db);
		runMigrations(db);

		const idx = db
			.prepare(
				`SELECT name, sql FROM sqlite_master WHERE type = 'index' AND name = 'idx_accounts_unique_name_provider_endpoint'`,
			)
			.get() as { name: string; sql: string } | undefined;
		expect(idx).toBeDefined();
		expect(idx?.sql).toContain("UNIQUE INDEX");
		expect(idx?.sql).toContain("COALESCE(custom_endpoint, '')");
	});

	it("is idempotent — running runMigrations twice does not throw", () => {
		ensureSchema(db);
		runMigrations(db);
		expect(() => runMigrations(db)).not.toThrow();

		const idxCount = db
			.prepare(
				`SELECT COUNT(*) as n FROM sqlite_master WHERE type = 'index' AND name = 'idx_accounts_unique_name_provider_endpoint'`,
			)
			.get() as { n: number };
		expect(idxCount.n).toBe(1);
	});

	it("collapses pre-existing duplicate rows (oldest wins) and creates the index", () => {
		// Seed a schema that already has the `custom_endpoint` column AND
		// contains duplicate rows that violate the future constraint. This
		// is the on-disk state of a pre-migration production DB.
		ensureSchema(db);
		// Add the custom_endpoint column that `runMigrations` would add
		// (mirrors the schema state at the point where the migration
		// kicks in).
		db.exec(`ALTER TABLE accounts ADD COLUMN custom_endpoint TEXT`);

		const now = Date.now();
		db.prepare(
			`INSERT INTO accounts (id, name, provider, refresh_token, access_token, created_at, custom_endpoint)
			 VALUES (?, ?, ?, ?, ?, ?, ?)`,
		).run("alpha-1", "alpha", "anthropic", "r1", "a1", now - 3000, null);
		db.prepare(
			`INSERT INTO accounts (id, name, provider, refresh_token, access_token, created_at, custom_endpoint)
			 VALUES (?, ?, ?, ?, ?, ?, ?)`,
		).run("alpha-2", "alpha", "anthropic", "r2", "a2", now - 1000, null);
		db.prepare(
			`INSERT INTO accounts (id, name, provider, refresh_token, access_token, created_at, custom_endpoint)
			 VALUES (?, ?, ?, ?, ?, ?, ?)`,
		).run("beta-1", "beta", "openai-compatible", "r3", "a3", now - 2000, "https://x");
		db.prepare(
			`INSERT INTO accounts (id, name, provider, refresh_token, access_token, created_at, custom_endpoint)
			 VALUES (?, ?, ?, ?, ?, ?, ?)`,
		).run("beta-2", "beta", "openai-compatible", "r4", "a4", now - 500, "https://x");

		// rowid reflects insertion order; the first-inserted row gets the
		// smallest rowid within the table.
		runMigrations(db);

		const alpha = db
			.prepare(
				`SELECT id FROM accounts WHERE name = 'alpha' AND provider = 'anthropic'`,
			)
			.all() as Array<{ id: string }>;
		expect(alpha).toHaveLength(1);
		expect(alpha[0]?.id).toBe("alpha-1"); // oldest kept

		const beta = db
			.prepare(
				`SELECT id FROM accounts WHERE name = 'beta' AND provider = 'openai-compatible' AND custom_endpoint = 'https://x'`,
			)
			.all() as Array<{ id: string }>;
		expect(beta).toHaveLength(1);
		expect(beta[0]?.id).toBe("beta-1"); // oldest kept

		// The UNIQUE index is now in place.
		const idx = db
			.prepare(
				`SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_accounts_unique_name_provider_endpoint'`,
			)
			.get();
		expect(idx).toBeDefined();
	});

	it("rejects a bare INSERT of a tuple that already exists (constraint active)", () => {
		ensureSchema(db);
		runMigrations(db);

		db.prepare(
			`INSERT INTO accounts (id, name, provider, refresh_token, access_token, created_at)
			 VALUES (?, ?, ?, ?, ?, ?)`,
		).run("seed", "alpha", "anthropic", "r", "a", Date.now());

		let caught: unknown;
		try {
			db.prepare(
				`INSERT INTO accounts (id, name, provider, refresh_token, access_token, created_at)
				 VALUES (?, ?, ?, ?, ?, ?)`,
			).run("dup", "alpha", "anthropic", "r", "a", Date.now());
		} catch (e) {
			caught = e;
		}

		expect(caught).toBeInstanceOf(Error);
		expect((caught as Error).message).toContain("UNIQUE constraint failed");

		// Only the original row persisted.
		const rows = db
			.prepare(`SELECT id FROM accounts WHERE name = 'alpha'`)
			.all() as Array<{ id: string }>;
		expect(rows).toHaveLength(1);
		expect(rows[0]?.id).toBe("seed");
	});

	it("NEGATIVE CONTROL: CREATE UNIQUE INDEX WITHOUT dedup FAILS on seeded duplicates", () => {
		// This is the negative control — proves the dedup step is the
		// reason the migration succeeds on legacy data. Bypassing the
		// dedup must fail on the very same seeded state the dedup step
		// would have collapsed.
		ensureSchema(db);
		// Add the custom_endpoint column that the migration adds so the
		// UNIQUE-index expression is well-formed.
		db.exec(`ALTER TABLE accounts ADD COLUMN custom_endpoint TEXT`);

		const now = Date.now();
		db.prepare(
			`INSERT INTO accounts (id, name, provider, refresh_token, access_token, created_at, custom_endpoint)
			 VALUES (?, ?, ?, ?, ?, ?, NULL)`,
		).run("alpha-1", "alpha", "anthropic", "r", "a", now);
		db.prepare(
			`INSERT INTO accounts (id, name, provider, refresh_token, access_token, created_at, custom_endpoint)
			 VALUES (?, ?, ?, ?, ?, ?, NULL)`,
		).run("alpha-2", "alpha", "anthropic", "r", "a", now);

		let caught: unknown;
		try {
			// Mirror the index creation in runMigrations but skip the
			// DELETE-by-rowid step the migration runs first.
			db.exec(
				`CREATE UNIQUE INDEX idx_accounts_unique_name_provider_endpoint
				 ON accounts(name, provider, COALESCE(custom_endpoint, ''))`,
			);
		} catch (e) {
			caught = e;
		}

		expect(caught).toBeInstanceOf(Error);
		expect((caught as Error).message).toMatch(
			/UNIQUE constraint failed/,
		);
	});

	it("treats NULL and '' custom_endpoint as the same tuple", () => {
		// Mirrors the COALESCE semantics the pre-check uses, so two
		// Anthropic console accounts (NULL or empty custom_endpoint)
		// collide as expected.
		ensureSchema(db);
		runMigrations(db);

		db.prepare(
			`INSERT INTO accounts (id, name, provider, refresh_token, access_token, created_at, custom_endpoint)
			 VALUES (?, ?, ?, ?, ?, ?, NULL)`,
		).run("seed", "alpha", "anthropic", "r", "a", Date.now());

		let caught: unknown;
		try {
			db.prepare(
				`INSERT INTO accounts (id, name, provider, refresh_token, access_token, created_at, custom_endpoint)
				 VALUES (?, ?, ?, ?, ?, ?, '')`,
			).run("dup", "alpha", "anthropic", "r", "a", Date.now());
		} catch (e) {
			caught = e;
		}

		expect(caught).toBeInstanceOf(Error);
		expect((caught as Error).message).toContain("UNIQUE constraint failed");
	});
});