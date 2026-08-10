/**
 * Router-level tests for GET /api/sessions/:sessionId/account (#318).
 *
 * These cover behavior that lives in router.ts's dynamic dispatch itself
 * (not the handler): the percent-encoding decode guard, and that a
 * structurally-empty session segment reaches the handler as a clean 400
 * rather than falling through to the generic 404.
 *
 * Auth exemption for this path is covered separately in
 * services/__tests__/auth-service-session-account-exemption.test.ts; here
 * auth is left disabled (no API keys in the stub dbOps) so these tests stay
 * focused on routing/decode mechanics.
 */
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import "@better-ccflare/core";
import type { Config } from "@better-ccflare/config";
import {
	BunSqlAdapter,
	type DatabaseOperations,
	ensureSchema,
	runMigrations,
} from "@better-ccflare/database";
import { APIRouter } from "../router";
import type { APIContext } from "../types";

function makeDb(): Database {
	const db = new Database(":memory:");
	ensureSchema(db);
	runMigrations(db);
	return db;
}

describe("APIRouter — GET /api/sessions/:sessionId/account (#318)", () => {
	let db: Database;
	let router: APIRouter;

	beforeEach(() => {
		db = makeDb();
		const adapter = new BunSqlAdapter(db);
		const dbOps = {
			getAdapter: () => adapter,
			// No active API keys → auth disabled, isolating these tests to
			// routing/decode-guard behavior.
			countActiveApiKeys: async () => 0,
			getActiveApiKeys: async () => [],
			// createAccountsListHandler (called via the session-account route)
			// also reads session-window token stats — none in these fixtures.
			getStatsRepository: () => ({
				getSessionStats: async () => new Map(),
			}),
		} as unknown as DatabaseOperations;
		const config = {
			getUsageThrottlingFiveHourEnabled: () => false,
			getUsageThrottlingWeeklyEnabled: () => false,
		} as unknown as Config;
		const alertService = {
			listAlerts: async () => [],
			getUnacknowledgedCount: async () => 0,
			acknowledgeAlert: async () => true,
			acknowledgeAll: async () => {},
		};
		const context = {
			db: adapter,
			config,
			dbOps,
			alertService,
		} as unknown as APIContext;
		router = new APIRouter(context);
	});

	afterEach(() => {
		db.close();
	});

	it("returns a clean 400 for malformed percent-encoding in the session segment", async () => {
		const url = new URL("http://localhost/api/sessions/%/account");
		const req = new Request(url);
		const res = await router.handleRequest(url, req);
		expect(res).not.toBeNull();
		expect(res?.status).toBe(400);
	});

	it("returns a clean 400 for an empty session segment rather than a 404", async () => {
		const url = new URL("http://localhost/api/sessions//account");
		const req = new Request(url);
		const res = await router.handleRequest(url, req);
		expect(res).not.toBeNull();
		expect(res?.status).toBe(400);
	});

	it("resolves a known session end-to-end through the router", async () => {
		db.run(
			"INSERT INTO accounts (id, name, provider, created_at) VALUES (?, ?, ?, ?)",
			["acc-1", "Account One", "anthropic", Date.now()],
		);
		db.run(
			"INSERT INTO requests (id, timestamp, method, path, account_used, client_session_id) VALUES (?, ?, ?, ?, ?, ?)",
			["r1", 1000, "POST", "/v1/messages", "acc-1", "session-abc"],
		);

		const url = new URL("http://localhost/api/sessions/session-abc/account");
		const req = new Request(url);
		const res = await router.handleRequest(url, req);
		expect(res?.status).toBe(200);
		const body = (await res?.json()) as {
			status: string;
			account?: { id: string };
		};
		expect(body.status).toBe("known");
		expect(body.account?.id).toBe("acc-1");
	});

	it("does not match a POST to the same path (falls through to 404)", async () => {
		const url = new URL("http://localhost/api/sessions/session-abc/account");
		const req = new Request(url, { method: "POST" });
		const res = await router.handleRequest(url, req);
		expect(res).toBeNull();
	});
});
