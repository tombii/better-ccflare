import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { existsSync, unlinkSync } from "node:fs";
import "@better-ccflare/core";
import type { Config } from "@better-ccflare/config";
import {
	DatabaseFactory,
	type DatabaseOperations,
} from "@better-ccflare/database";
import { resetApiKeySpendCounter } from "@better-ccflare/proxy";
import { NodeCryptoUtils } from "@better-ccflare/types";
import { APIRouter } from "../../router";
import type { APIContext } from "../../types";
import {
	createApiKeyGetHandler,
	createApiKeyLimitsGetHandler,
	createApiKeyLimitsPutHandler,
	createApiKeyRoutingUpdateHandler,
	createApiKeysListHandler,
	createApiKeyUpdateSpendLimitHandler,
} from "../api-keys";

const PATH = `/tmp/api-key-limits-v2-http-${process.pid}.db`;
const HOUR = 3_600_000;
let dbOps: DatabaseOperations;

function clean() {
	for (const suffix of ["", "-wal", "-shm"])
		if (existsSync(PATH + suffix)) unlinkSync(PATH + suffix);
}
async function key(id = "target", name = "target-name", active = true) {
	await dbOps.createApiKey({
		id,
		name,
		hashedKey: "unused",
		prefixLast8: "unused",
		createdAt: Date.now(),
		role: "api-only",
		isActive: active,
	});
}
function request(body: unknown, method = "PUT") {
	return new Request("http://localhost/api/api-keys/target/limits", {
		method,
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
}

beforeEach(() => {
	clean();
	resetApiKeySpendCounter();
	DatabaseFactory.initialize(PATH);
	dbOps = DatabaseFactory.getInstance();
});
afterEach(async () => {
	await new Promise((resolve) => setTimeout(resolve, 50));
	DatabaseFactory.reset();
	resetApiKeySpendCounter();
	clean();
});

describe("API key multi-window management", () => {
	it("replaces limits and attaches per-scope spend and resets to GET/list", async () => {
		await key();
		const now = Date.now();
		await dbOps
			.getAdapter()
			.run(
				`INSERT INTO requests (id, timestamp, method, path, model, limit_model, cost_usd, api_key_id, success) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				[
					"r1",
					now - HOUR,
					"POST",
					"/v1/messages",
					"gpt-6.1-sol",
					"claude-opus-4-6",
					3,
					"target",
					1,
				],
			);
		const handler = createApiKeyLimitsPutHandler(dbOps);
		const response = await handler(
			request({
				mode: "rolling",
				limits: [
					{ scopeModel: null, window: "day", limitUsd: 20, enforce: "block" },
					{ scopeModel: "opus", window: "week", limitUsd: 10, enforce: "warn" },
					{
						scopeModel: "sonnet",
						window: "month",
						limitUsd: 5,
						enforce: "block",
					},
				],
			}),
			"target-name",
		);
		expect(response.status).toBe(200);
		const { data } = await response.json();
		expect(data.mode).toBe("rolling");
		expect(data.limits).toHaveLength(3);
		expect(
			data.limits.find(
				(r: { scopeModel: string | null }) => r.scopeModel === null,
			).spentUsd,
		).toBe(3);
		expect(
			data.limits.find(
				(r: { scopeModel: string | null }) => r.scopeModel === "opus",
			).spentUsd,
		).toBe(3);
		expect(
			data.limits.find(
				(r: { scopeModel: string | null }) => r.scopeModel === "sonnet",
			).spentUsd,
		).toBe(0);
		expect(
			data.limits.find(
				(r: { scopeModel: string | null }) => r.scopeModel === "opus",
			).resetsAt,
		).toBe(new Date(now - HOUR + 7 * 24 * HOUR).toISOString());
		const list = await (await createApiKeysListHandler(dbOps)()).json();
		expect(list.data[0].limits).toHaveLength(3);
		const cleared = await handler(
			request({ mode: "calendar", limits: [] }),
			"target",
		);
		expect(cleared.status).toBe(200);
		expect(
			(await (await createApiKeyLimitsGetHandler(dbOps)("target")).json()).data,
		).toEqual({ mode: "calendar", limits: [] });
	});

	it("reports unknown spend without losing rows when a counter reload fails", async () => {
		await key();
		await dbOps.replaceApiKeyLimits(
			"target",
			[{ scopeModel: null, window: "day", limitUsd: 2, enforce: "block" }],
			"calendar",
		);
		const failure = spyOn(dbOps, "getApiKeySpendEventsSince").mockRejectedValue(
			new Error("database unavailable"),
		);
		try {
			const response = await createApiKeyLimitsGetHandler(dbOps)("target");
			expect(response.status).toBe(200);
			const { data } = await response.json();
			expect(data.limits).toHaveLength(1);
			expect(data.limits[0].spentUsd).toBeUndefined();
		} finally {
			failure.mockRestore();
		}
	});

	it("reads a single key asynchronously by id or name and returns 404 for a miss", async () => {
		await key();
		await dbOps.replaceApiKeyLimits(
			"target",
			[{ scopeModel: null, window: "day", limitUsd: 2, enforce: "block" }],
			"calendar",
		);
		const get = createApiKeyGetHandler(dbOps);
		for (const identifier of ["target", "target-name"]) {
			const response = await get(identifier);
			const { data } = await response.json();
			expect(response.status).toBe(200);
			expect(data.id).toBe("target");
			expect(data.limits[0].spentUsd).toBe(0);
		}
		expect((await get("missing")).status).toBe(404);
	});

	it("validates the complete replacement before making any change", async () => {
		await key();
		const put = createApiKeyLimitsPutHandler(dbOps);
		const row = {
			scopeModel: null,
			window: "day",
			limitUsd: 5,
			enforce: "block",
		};
		await put(request({ mode: "calendar", limits: [row] }), "target");
		for (const body of [
			{ mode: "local", limits: [] },
			{ mode: "calendar", limits: {} },
			{ mode: "calendar", limits: [{ ...row, window: "year" }] },
			{ mode: "calendar", limits: [{ ...row, enforce: "ignore" }] },
			{ mode: "calendar", limits: [{ ...row, limitUsd: 0 }] },
			{ mode: "calendar", limits: [{ ...row, limitUsd: "5" }] },
			{ mode: "calendar", limits: [{ ...row, scopeModel: [] }] },
			{ mode: "calendar", limits: [{ ...row, scopeModel: " " }] },
			{ mode: "calendar", limits: [row, row] },
		]) {
			expect((await put(request(body), "target")).status).toBe(400);
		}
		expect(await dbOps.getApiKeyLimits("target")).toHaveLength(1);
		expect((await createApiKeyLimitsGetHandler(dbOps)("missing")).status).toBe(
			404,
		);
	});

	it("keeps the legacy PATCH as a month-row shim and preserves model limits", async () => {
		await key();
		await dbOps.replaceApiKeyLimits(
			"target",
			[{ scopeModel: "opus", window: "day", limitUsd: 2, enforce: "warn" }],
			"calendar",
		);
		const shim = createApiKeyUpdateSpendLimitHandler(dbOps);
		expect(
			(
				await shim(
					request(
						{ limitUsd: 40, limitWindow: "rolling_7d", limitEnforce: "warn" },
						"PATCH",
					),
					"target",
				)
			).status,
		).toBe(200);
		const rows = await dbOps.getApiKeyLimits("target");
		expect(rows.find((row) => row.scopeModel === null)).toMatchObject({
			window: "month",
			limitUsd: 40,
			enforce: "warn",
		});
		expect(rows.find((row) => row.scopeModel === "opus")).toBeDefined();
		await shim(request({ limitUsd: null }, "PATCH"), "target");
		expect(
			(await dbOps.getApiKeyLimits("target")).map((row) => row.scopeModel),
		).toEqual(["opus"]);
	});

	it("stores and clears routing overrides and rejects unknown combos/families", async () => {
		await key();
		const combo = await dbOps.createCombo("Codex");
		const patch = createApiKeyRoutingUpdateHandler(dbOps);
		const body = { familyComboOverrides: { opus: combo.id } };
		expect((await patch(request(body, "PATCH"), "target-name")).status).toBe(
			200,
		);
		expect((await dbOps.getApiKey("target"))?.familyComboOverrides).toEqual({
			opus: combo.id,
		});
		for (const familyComboOverrides of [
			{ opus: "missing" },
			{ other: combo.id },
			[],
			"bad",
			{ opus: null },
		]) {
			expect(
				(await patch(request({ familyComboOverrides }, "PATCH"), "target"))
					.status,
			).toBe(400);
		}
		expect((await patch(request({}, "PATCH"), "target")).status).toBe(400);
		await patch(request({ familyComboOverrides: null }, "PATCH"), "target");
		expect((await dbOps.getApiKey("target"))?.familyComboOverrides).toBeNull();
	});
});

describe("API key usage authorization", () => {
	async function credential(id: string, role: "admin" | "api-only") {
		const crypto = new NodeCryptoUtils();
		const plain = await crypto.generateApiKey();
		await dbOps.createApiKey({
			id,
			name: `${id} name`,
			hashedKey: await crypto.hashApiKey(plain),
			prefixLast8: plain.slice(-8),
			createdAt: Date.now(),
			role,
			isActive: true,
		});
		return plain;
	}
	function router() {
		return new APIRouter({
			dbOps,
			db: dbOps.getAdapter(),
			config: {
				getUsageThrottlingFiveHourEnabled: () => false,
				getUsageThrottlingWeeklyEnabled: () => false,
			} as unknown as Config,
			alertService: {
				listAlerts: async () => [],
				getUnacknowledgedCount: async () => 0,
				acknowledgeAlert: async () => true,
				acknowledgeAll: async () => {},
			},
		} as unknown as APIContext);
	}
	async function call(
		api: APIRouter,
		path: string,
		credential?: string,
		method = "GET",
		body?: unknown,
	) {
		const url = new URL(`http://localhost${path}`);
		return api.handleRequest(
			url,
			new Request(url, {
				method,
				headers: {
					...(credential ? { "x-api-key": credential } : {}),
					"Content-Type": "application/json",
				},
				...(body ? { body: JSON.stringify(body) } : {}),
			}),
		);
	}
	it("allows an API-only key to read only its own usage by id or encoded name", async () => {
		const own = await credential("own", "api-only");
		await key();
		const api = router();
		for (const identifier of ["own", "own%20name"]) {
			const response = await call(
				api,
				`/api/api-keys/${identifier}/usage`,
				own,
			);
			expect(response?.status).toBe(200);
			expect((await response?.json())?.canManage).toBe(false);
		}
		for (const identifier of ["target", "target-name"])
			expect(
				(await call(api, `/api/api-keys/${identifier}/usage`, own))?.status,
			).toBe(403);
		expect((await call(api, "/api/api-keys/own/usage"))?.status).toBe(401);
		expect((await call(api, "/api/api-keys/own/limits", own))?.status).toBe(
			401,
		);
		expect(
			(
				await call(api, "/api/api-keys/own/limits", own, "PUT", {
					mode: "rolling",
					limits: [],
				})
			)?.status,
		).toBe(401);
		expect(
			(
				await call(api, "/api/api-keys/own/routing", own, "PATCH", {
					familyComboOverrides: null,
				})
			)?.status,
		).toBe(401);
	});
	it("allows admins to inspect every key and manage limits/routing", async () => {
		const admin = await credential("admin", "admin");
		await key();
		const api = router();
		const usage = await call(api, "/api/api-keys/target-name/usage", admin);
		expect(usage?.status).toBe(200);
		expect((await call(api, "/api/api-keys/target-name", admin))?.status).toBe(
			200,
		);
		expect((await usage?.json())?.canManage).toBe(true);
		expect(
			(await call(api, "/api/api-keys/target/limits", admin))?.status,
		).toBe(200);
		expect(
			(
				await call(api, "/api/api-keys/target/limits", admin, "PUT", {
					mode: "rolling",
					limits: [
						{ window: "hour", scopeModel: null, limitUsd: 5, enforce: "block" },
					],
				})
			)?.status,
		).toBe(200);
		expect(
			(
				await call(api, "/api/api-keys/target/routing", admin, "PATCH", {
					familyComboOverrides: null,
				})
			)?.status,
		).toBe(200);
	});
	it("allows a dashboard without active API keys to inspect a key", async () => {
		await key("inactive", "inactive", false);
		const response = await call(router(), "/api/api-keys/inactive/usage");
		expect(response?.status).toBe(200);
		expect((await response?.json())?.canManage).toBe(true);
	});
});
