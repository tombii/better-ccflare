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
