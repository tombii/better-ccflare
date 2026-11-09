/**
 * Router wiring: GET /api/combos/flow is a static route that shares its
 * prefix with the dynamic /api/combos/:id handler. It must be matched first —
 * otherwise "flow" is read as a combo id. This test also shows that
 * /api/combos/:id still works for a real id.
 */
import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, it } from "bun:test";
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

describe("APIRouter /api/combos/flow routing", () => {
	let router: APIRouter;
	let getComboCalls: string[];

	beforeEach(() => {
		const db = new Database(":memory:");
		ensureSchema(db);
		runMigrations(db);
		const adapter = new BunSqlAdapter(db);
		getComboCalls = [];
		const dbOps = {
			getAdapter: () => adapter,
			listCombos: async () => [],
			getComboSlots: async () => [],
			getFamilyAssignments: async () => [],
			getAllAccounts: async () => [],
			getComboRoutingAggregates: async () => [],
			countActiveApiKeys: async () => 0,
			getActiveApiKeys: async () => [],
			onRequestsDeleted: () => () => {},
			getCombo: async (id: string) => {
				getComboCalls.push(id);
				return null;
			},
		} as unknown as DatabaseOperations;
		const context = {
			db: adapter,
			config: {
				getCombosEnabled: () => true,
				getForceAccountModel: () => false,
			} as unknown as Config,
			dbOps,
			alertService: {},
		} as unknown as APIContext;
		router = new APIRouter(context);
	});

	const get = async (path: string) => {
		const url = new URL(`http://localhost${path}`);
		return router.handleRequest(url, new Request(url));
	};

	it("serves the flow payload for /api/combos/flow without treating it as an id", async () => {
		const res = await get("/api/combos/flow");
		expect(res?.status).toBe(200);
		const body = (await res?.json()) as {
			success: boolean;
			data: { families: unknown[]; combos: unknown[] };
		};
		expect(body.success).toBe(true);
		expect(body.data.families).toHaveLength(4);
		expect(body.data.combos).toEqual([]);
		expect(getComboCalls).toEqual([]);
	});

	it("still routes a real id to GET /api/combos/:id", async () => {
		const res = await get("/api/combos/abc-123");
		expect(res?.status).toBe(404);
		expect(getComboCalls).toEqual(["abc-123"]);
	});
});
