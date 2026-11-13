import { Database } from "bun:sqlite";
import { afterEach, describe, expect, it } from "bun:test";
import { ensureSchema, runMigrations } from "./migrations";

function apiKeyColumns(
	db: Database,
): Array<{ name: string; dflt_value: string | null; notnull: number }> {
	return db.prepare("PRAGMA table_info(api_keys)").all() as Array<{
		name: string;
		dflt_value: string | null;
		notnull: number;
	}>;
}

const RESTRICTION_COLUMNS = [
	"allowed_accounts",
	"allowed_models",
	"allowed_providers",
] as const;

describe("api_keys restriction columns migration", () => {
	let db: Database;

	afterEach(() => {
		db.close();
	});

	it("creates all three restriction columns on a fresh database", () => {
		db = new Database(":memory:");

		ensureSchema(db);
		runMigrations(db);

		const names = apiKeyColumns(db).map((column) => column.name);
		for (const column of RESTRICTION_COLUMNS) {
			expect(names).toContain(column);
		}
	});

	it("leaves the restriction columns NULL (unrestricted) for a new key", () => {
		db = new Database(":memory:");
		ensureSchema(db);
		runMigrations(db);

		db.run(
			"INSERT INTO api_keys (id, name, hashed_key, prefix_last_8, created_at, is_active) VALUES ('k1', 'fresh', 'h', '12345678', 1, 1)",
		);
		const row = db
			.query<
				{
					allowed_accounts: string | null;
					allowed_models: string | null;
					allowed_providers: string | null;
				},
				[]
			>(
				"SELECT allowed_accounts, allowed_models, allowed_providers FROM api_keys WHERE id = 'k1'",
			)
			.get();

		expect(row?.allowed_accounts).toBeNull();
		expect(row?.allowed_models).toBeNull();
		expect(row?.allowed_providers).toBeNull();
	});

	it("adds the restriction columns to an existing database without them", () => {
		db = new Database(":memory:");
		// The api_keys shape as it was before this migration (pre-`role` even,
		// so the role migration runs alongside — the same path a real upgrade
		// from an older install takes).
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
		for (const column of RESTRICTION_COLUMNS) {
			expect(names).toContain(column);
		}

		// An existing key stays unrestricted: NULL, never '[]' (deny-all).
		const row = db
			.query<
				{
					allowed_accounts: string | null;
					allowed_models: string | null;
					allowed_providers: string | null;
				},
				[]
			>(
				"SELECT allowed_accounts, allowed_models, allowed_providers FROM api_keys WHERE id = 'old'",
			)
			.get();
		expect(row?.allowed_accounts).toBeNull();
		expect(row?.allowed_models).toBeNull();
		expect(row?.allowed_providers).toBeNull();
	});

	it("declares the restriction columns nullable with no default", () => {
		db = new Database(":memory:");
		ensureSchema(db);
		runMigrations(db);

		for (const name of RESTRICTION_COLUMNS) {
			const column = apiKeyColumns(db).find(
				(candidate) => candidate.name === name,
			);
			expect(column).toBeDefined();
			// NULL must stay a representable value: it is what "unrestricted"
			// means, and a NOT NULL/default would collapse it into deny-all.
			expect(column?.notnull).toBe(0);
			expect(column?.dflt_value).toBeNull();
		}
	});

	it("is idempotent across repeated migration runs", () => {
		db = new Database(":memory:");
		ensureSchema(db);
		runMigrations(db);
		runMigrations(db);
		runMigrations(db);

		const names = apiKeyColumns(db).map((column) => column.name);
		for (const column of RESTRICTION_COLUMNS) {
			expect(names.filter((candidate) => candidate === column).length).toBe(1);
		}
	});

	it("preserves a stored restriction list across a re-run", () => {
		db = new Database(":memory:");
		ensureSchema(db);
		runMigrations(db);

		db.run(
			"INSERT INTO api_keys (id, name, hashed_key, prefix_last_8, created_at, is_active, allowed_accounts, allowed_models) VALUES ('k2', 'scoped', 'h2', '87654321', 1, 1, '[\"acc-1\"]', '[]')",
		);
		runMigrations(db);

		const row = db
			.query<
				{ allowed_accounts: string | null; allowed_models: string | null },
				[]
			>("SELECT allowed_accounts, allowed_models FROM api_keys WHERE id = 'k2'")
			.get();
		expect(row?.allowed_accounts).toBe('["acc-1"]');
		// Deny-all must survive as '[]' and never be normalised back to NULL.
		expect(row?.allowed_models).toBe("[]");
	});
});
