import { Database } from "bun:sqlite";
import { afterEach, describe, expect, it } from "bun:test";
import { ensureSchema, runMigrations } from "./migrations";

function accountColumns(
	db: Database,
): Array<{ name: string; dflt_value: string | null }> {
	return db.prepare("PRAGMA table_info(accounts)").all() as Array<{
		name: string;
		dflt_value: string | null;
	}>;
}

describe("requires_reauth migration", () => {
	let db: Database;

	afterEach(() => {
		db.close();
	});

	it("creates requires_reauth with a false default for a fresh database", () => {
		db = new Database(":memory:");

		ensureSchema(db);
		runMigrations(db);

		const column = accountColumns(db).find(
			(candidate) => candidate.name === "requires_reauth",
		);
		expect(column?.dflt_value).toBe("0");

		db.run(
			"INSERT INTO accounts (id, name, created_at) VALUES ('fresh', 'fresh', 1)",
		);
		const row = db
			.query<{ requires_reauth: number }, []>(
				"SELECT requires_reauth FROM accounts WHERE id = 'fresh'",
			)
			.get();
		expect(row?.requires_reauth).toBe(0);
	});

	it("adds requires_reauth with a false default to an existing database", () => {
		db = new Database(":memory:");
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
				priority INTEGER DEFAULT 0
			)
		`);
		db.run(
			"INSERT INTO accounts (id, name, created_at) VALUES ('existing', 'existing', 1)",
		);

		runMigrations(db);

		expect(accountColumns(db).map((column) => column.name)).toContain(
			"requires_reauth",
		);
		const row = db
			.query<{ requires_reauth: number }, []>(
				"SELECT requires_reauth FROM accounts WHERE id = 'existing'",
			)
			.get();
		expect(row?.requires_reauth).toBe(0);
	});
});
