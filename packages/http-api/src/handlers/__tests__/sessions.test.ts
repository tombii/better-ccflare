/**
 * Tests for GET /api/sessions/:sessionId/account — issue #318, reduced scope
 * per the maintainer's comment: a DB-backed lookup (session → last-serving
 * account from `requests`) only, no live in-memory strategy path.
 *
 * The handler resolves the most recent `requests` row carrying the given
 * `client_session_id` with a non-null `account_used`, then reuses
 * `createAccountsListHandler` (the exact handler backing GET /api/accounts)
 * to serialize the account — so the returned `account` is byte-for-byte what
 * /api/accounts would return for that id, not a parallel serialization.
 */
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
// Side-effect import: load @better-ccflare/core before @better-ccflare/types
// (types/agent.ts runtime-imports core while core/strategy.ts imports types —
// a pre-existing cycle that crashes when types is evaluated first). Mirrors
// packages/database/src/repositories/__tests__/stats-no-account-binding.test.ts.
import "@better-ccflare/core";
import type { Config } from "@better-ccflare/config";
import {
	BunSqlAdapter,
	type DatabaseOperations,
	ensureSchema,
	runMigrations,
} from "@better-ccflare/database";
import { createAccountsListHandler } from "../accounts";
import { createSessionAccountHandler } from "../sessions";

function makeDb(): Database {
	const db = new Database(":memory:");
	ensureSchema(db);
	runMigrations(db);
	return db;
}

function insertAccount(
	db: Database,
	row: { id: string; name: string; provider?: string },
) {
	db.run(
		"INSERT INTO accounts (id, name, provider, created_at) VALUES (?, ?, ?, ?)",
		[row.id, row.name, row.provider ?? "anthropic", Date.now()],
	);
}

function insertRequest(
	db: Database,
	row: {
		id: string;
		timestamp: number;
		accountUsed: string | null;
		clientSessionId: string | null;
	},
) {
	db.run(
		"INSERT INTO requests (id, timestamp, method, path, account_used, client_session_id) VALUES (?, ?, ?, ?, ?, ?)",
		[
			row.id,
			row.timestamp,
			"POST",
			"/v1/messages",
			row.accountUsed,
			row.clientSessionId,
		],
	);
}

/** Minimal Config stub — createAccountsListHandler only calls these two
 * methods (usage-throttle display flags), confirmed by reading its body. */
function makeConfig(): Config {
	return {
		getUsageThrottlingFiveHourEnabled: () => false,
		getUsageThrottlingWeeklyEnabled: () => false,
	} as unknown as Config;
}

describe("createSessionAccountHandler", () => {
	let db: Database;
	let adapter: BunSqlAdapter;
	let dbOps: DatabaseOperations;
	let accountsHandler: () => Promise<Response>;

	beforeEach(() => {
		db = makeDb();
		adapter = new BunSqlAdapter(db);
		// createAccountsListHandler uses dbOps.getAdapter() plus
		// dbOps.getStatsRepository().getSessionStats() (session-window token
		// stats for providers with session-based limits — none in these
		// fixtures, so an empty Map is a faithful stub) — confirmed by reading
		// the handler body. A minimal stub is enough to genuinely exercise the
		// real serialization logic.
		dbOps = {
			getAdapter: () => adapter,
			getStatsRepository: () => ({
				getSessionStats: async () => new Map(),
			}),
		} as unknown as DatabaseOperations;
		accountsHandler = createAccountsListHandler(dbOps, makeConfig());
	});

	afterEach(() => {
		db.close();
	});

	it("resolves the most recent serving account for a known session", async () => {
		insertAccount(db, { id: "acc-1", name: "Account One" });
		insertRequest(db, {
			id: "r1",
			timestamp: 1000,
			accountUsed: "acc-1",
			clientSessionId: "session-abc",
		});

		const handler = createSessionAccountHandler(adapter, accountsHandler);
		const res = await handler("session-abc");
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			status: string;
			account?: { id: string; name: string };
		};
		expect(body.status).toBe("known");
		expect(body.account?.id).toBe("acc-1");
		expect(body.account?.name).toBe("Account One");
	});

	it("returns the exact same account shape /api/accounts returns", async () => {
		insertAccount(db, { id: "acc-1", name: "Account One" });
		insertRequest(db, {
			id: "r1",
			timestamp: 1000,
			accountUsed: "acc-1",
			clientSessionId: "session-abc",
		});

		const listRes = await accountsHandler();
		const list = (await listRes.json()) as Array<Record<string, unknown>>;
		const expected = list.find((a) => a.id === "acc-1");

		const handler = createSessionAccountHandler(adapter, accountsHandler);
		const res = await handler("session-abc");
		const body = (await res.json()) as { account?: Record<string, unknown> };

		expect(body.account).toEqual(expected);
	});

	it("breaks a millisecond timestamp tie by insertion order (rowid), not arbitrarily", async () => {
		insertAccount(db, { id: "acc-first", name: "First Account" });
		insertAccount(db, { id: "acc-second", name: "Second Account" });
		// Two requests in the SAME millisecond: ORDER BY timestamp alone leaves
		// the rows tied and SQLite may return either. The `rowid DESC`
		// tiebreaker pins the later-inserted (= later-served) row.
		insertRequest(db, {
			id: "r-tie-1",
			timestamp: 5000,
			accountUsed: "acc-first",
			clientSessionId: "session-tie",
		});
		insertRequest(db, {
			id: "r-tie-2",
			timestamp: 5000,
			accountUsed: "acc-second",
			clientSessionId: "session-tie",
		});

		const handler = createSessionAccountHandler(adapter, accountsHandler);
		const res = await handler("session-tie");
		const body = (await res.json()) as {
			status: string;
			account?: { id: string };
		};
		expect(body.status).toBe("known");
		expect(body.account?.id).toBe("acc-second");
	});

	it("resolves to the account from the most recent request row (most-recent-row-wins)", async () => {
		insertAccount(db, { id: "acc-old", name: "Old Account" });
		insertAccount(db, { id: "acc-new", name: "New Account" });
		insertRequest(db, {
			id: "r1",
			timestamp: 1000,
			accountUsed: "acc-old",
			clientSessionId: "session-abc",
		});
		insertRequest(db, {
			id: "r2",
			timestamp: 2000,
			accountUsed: "acc-new",
			clientSessionId: "session-abc",
		});

		const handler = createSessionAccountHandler(adapter, accountsHandler);
		const res = await handler("session-abc");
		const body = (await res.json()) as { account?: { id: string } };
		expect(body.account?.id).toBe("acc-new");
	});

	it("returns unknown for a session that was never recorded", async () => {
		const handler = createSessionAccountHandler(adapter, accountsHandler);
		const res = await handler("never-seen-session");
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body).toEqual({ status: "unknown" });
	});

	it("returns unknown when the serving account has since been removed", async () => {
		insertRequest(db, {
			id: "r1",
			timestamp: 1000,
			accountUsed: "acc-deleted",
			clientSessionId: "session-abc",
		});
		// No matching row in `accounts` — account was removed after serving.

		const handler = createSessionAccountHandler(adapter, accountsHandler);
		const res = await handler("session-abc");
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body).toEqual({ status: "unknown" });
	});

	it("returns unknown when the only recorded request has a null account_used", async () => {
		insertRequest(db, {
			id: "r1",
			timestamp: 1000,
			accountUsed: null,
			clientSessionId: "session-abc",
		});

		const handler = createSessionAccountHandler(adapter, accountsHandler);
		const res = await handler("session-abc");
		const body = await res.json();
		expect(body).toEqual({ status: "unknown" });
	});

	it("returns 400 for an empty session id", async () => {
		const handler = createSessionAccountHandler(adapter, accountsHandler);
		const res = await handler("");
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error: string };
		expect(body.error).toBeTruthy();
	});

	it("returns 400 for a whitespace-only session id", async () => {
		const handler = createSessionAccountHandler(adapter, accountsHandler);
		const res = await handler("   ");
		expect(res.status).toBe(400);
	});

	it("bounds an oversized session id the same way the write path does (200 chars)", async () => {
		// Mirrors CLIENT_SESSION_ID_MAX_LEN / sanitizeClientSessionId in
		// packages/database/src/repositories/request.repository.ts: the write
		// path truncates to 200 chars before persisting, so a >200-char id
		// stored as its first-200-chars prefix.
		const longId = "s".repeat(250);
		const truncated = longId.slice(0, 200);
		insertAccount(db, { id: "acc-1", name: "Account One" });
		insertRequest(db, {
			id: "r1",
			timestamp: 1000,
			accountUsed: "acc-1",
			clientSessionId: truncated,
		});

		const handler = createSessionAccountHandler(adapter, accountsHandler);
		// Query with the full (untruncated) 250-char id, as a caller who saw
		// the original long id might.
		const res = await handler(longId);
		const body = (await res.json()) as {
			status: string;
			account?: { id: string };
		};
		expect(body.status).toBe("known");
		expect(body.account?.id).toBe("acc-1");
	});
});
