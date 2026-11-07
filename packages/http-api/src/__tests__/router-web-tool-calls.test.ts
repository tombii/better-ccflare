/**
 * Router-level tests for GET /api/web-tool-calls and .../summary.
 *
 * The handler tests in handlers/__tests__/web-tool-calls.test.ts call the
 * handlers directly, so they cannot see how router.ts wires them up. That is
 * precisely where a real break lived: the handlers were held in a
 * `private webToolCallHandlers` field that the routes reached through the
 * constructor local instead, so biome's noUnusedPrivateClassMembers pass
 * (in `bun run lint`) deleted the field and `tsc` then failed on the
 * assignment to it. Routing these two requests end-to-end pins the wiring.
 *
 * Uses the real DatabaseOperations rather than a stub: the routes hand it to
 * createWebToolCallHandlers as the store, so a stub would test the stub.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { Config } from "@better-ccflare/config";
import { DatabaseOperations } from "@better-ccflare/database";
import { APIRouter } from "../router";
import type { APIContext } from "../types";

describe("APIRouter — GET /api/web-tool-calls", () => {
	let dbOps: DatabaseOperations;
	let router: APIRouter;

	beforeEach(() => {
		dbOps = new DatabaseOperations(":memory:", { walMode: false });
		// No active API keys → auth disabled, keeping these tests on routing.
		Object.assign(dbOps, {
			countActiveApiKeys: async () => 0,
			getActiveApiKeys: async () => [],
		});
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
		router = new APIRouter({
			db: dbOps.getAdapter(),
			config,
			dbOps,
			alertService,
		} as unknown as APIContext);
	});

	afterEach(() => {
		dbOps.close();
	});

	async function get(path: string): Promise<Response | null> {
		const url = new URL(`http://localhost${path}`);
		return router.handleRequest(url, new Request(url));
	}

	it("serves the list route", async () => {
		const res = await get("/api/web-tool-calls");
		expect(res?.status).toBe(200);
		const body = (await res?.json()) as { success: boolean; data: unknown[] };
		expect(body.success).toBe(true);
		expect(Array.isArray(body.data)).toBe(true);
	});

	it("serves the summary route", async () => {
		const res = await get("/api/web-tool-calls/summary");
		expect(res?.status).toBe(200);
		const body = (await res?.json()) as { success: boolean; data: unknown[] };
		expect(body.success).toBe(true);
		expect(Array.isArray(body.data)).toBe(true);
	});
});
