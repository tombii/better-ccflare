import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { BunSqlAdapter } from "../../adapters/bun-sql-adapter";
import { ensureSchema, runMigrations } from "../../migrations";
import { OAuthRepository } from "../oauth.repository";

describe("OAuthRepository - priority round-trip", () => {
	let db: Database;
	let repo: OAuthRepository;

	beforeEach(() => {
		// Fresh in-memory SQLite DB with the full schema applied.
		db = new Database(":memory:");
		ensureSchema(db);
		runMigrations(db);
		repo = new OAuthRepository(new BunSqlAdapter(db));
	});

	afterEach(() => {
		db.close();
	});

	it("persists and returns the priority value passed to createSession", async () => {
		const sessionId = "11111111-1111-1111-1111-111111111111";

		await repo.createSession(
			sessionId,
			"acct-priority-42",
			"verifier-string",
			"claude-oauth",
			undefined, // customEndpoint
			42, // priority
			10, // ttlMinutes
		);

		const session = await repo.getSession(sessionId);
		expect(session).not.toBeNull();
		expect(session?.priority).toBe(42);
		expect(session?.accountName).toBe("acct-priority-42");
		expect(session?.mode).toBe("claude-oauth");
	});

	it("defaults priority to 0 when omitted on createSession", async () => {
		const sessionId = "22222222-2222-2222-2222-222222222222";

		// Omit both priority and ttlMinutes — both have defaults.
		await repo.createSession(
			sessionId,
			"acct-default-priority",
			"verifier-string",
			"console",
		);

		const session = await repo.getSession(sessionId);
		expect(session).not.toBeNull();
		expect(session?.priority).toBe(0);
	});

	it("preserves a non-default priority alongside customEndpoint", async () => {
		const sessionId = "33333333-3333-3333-3333-333333333333";

		await repo.createSession(
			sessionId,
			"acct-with-endpoint",
			"verifier-string",
			"console",
			"https://example.com/api",
			75,
			10,
		);

		const session = await repo.getSession(sessionId);
		expect(session).not.toBeNull();
		expect(session?.priority).toBe(75);
		expect(session?.customEndpoint).toBe("https://example.com/api");
	});
});

describe("oauth_sessions tier-drop migration preserves constraints", () => {
	it("rebuilds the table with PRIMARY KEY, NOT NULL, and DEFAULT 0 constraints intact", () => {
		// Bootstrap an in-memory DB that looks like a legacy install:
		// modern schema + an extra `tier` column to trigger the tier-drop rebuild.
		const db = new Database(":memory:");
		try {
			ensureSchema(db);
			db.prepare(`ALTER TABLE oauth_sessions ADD COLUMN tier TEXT`).run();

			// Run migrations — this should detect the `tier` column and rebuild
			// oauth_sessions via the explicit CREATE TABLE + INSERT path.
			runMigrations(db);

			const columns = db
				.prepare("PRAGMA table_info(oauth_sessions)")
				.all() as Array<{
				name: string;
				notnull: number;
				// biome-ignore lint/suspicious/noExplicitAny: dflt_value can be string|number|null
				dflt_value: any;
				pk: number;
			}>;

			const byName = new Map(columns.map((c) => [c.name, c]));

			// tier is gone
			expect(byName.has("tier")).toBe(false);

			// id is the primary key
			const idCol = byName.get("id");
			expect(idCol).toBeDefined();
			expect(idCol?.pk).toBe(1);

			// priority is NOT NULL with default 0 (SQLite returns dflt_value as a string)
			const priorityCol = byName.get("priority");
			expect(priorityCol).toBeDefined();
			expect(priorityCol?.notnull).toBe(1);
			expect(Number(priorityCol?.dflt_value)).toBe(0);

			// All other constraint-bearing columns are still NOT NULL
			for (const colName of [
				"account_name",
				"verifier",
				"mode",
				"created_at",
				"expires_at",
			]) {
				const col = byName.get(colName);
				expect(col).toBeDefined();
				expect(col?.notnull).toBe(1);
			}
		} finally {
			db.close();
		}
	});
});
