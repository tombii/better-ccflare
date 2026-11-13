import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { existsSync, unlinkSync } from "node:fs";
import "@better-ccflare/core";
import { updateApiKeySpendLimit } from "@better-ccflare/cli-commands";
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
		const failure = spyOn(
			dbOps,
			"getApiKeySpendReconciliation",
		).mockRejectedValue(new Error("database unavailable"));
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

	it("maps the legacy PATCH to a week row and preserves model limits", async () => {
		await key();
		await dbOps.replaceApiKeyLimits(
			"target",
			[{ scopeModel: "opus", window: "day", limitUsd: 2, enforce: "warn" }],
			"rolling",
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
			window: "week",
			limitUsd: 40,
			enforce: "warn",
		});
		expect(rows.find((row) => row.scopeModel === "opus")).toBeDefined();
		await shim(request({ limitUsd: null }, "PATCH"), "target");
		expect(
			(await dbOps.getApiKeyLimits("target")).map((row) => row.scopeModel),
		).toEqual(["opus"]);
	});

	it("rejects legacy mode changes with other rows without partially updating the key", async () => {
		await key();
		const rows = [
			{ scopeModel: "opus", window: "day", limitUsd: 2, enforce: "warn" },
		] as const;
		await dbOps.replaceApiKeyLimits("target", [...rows], "calendar");
		const response = await createApiKeyUpdateSpendLimitHandler(dbOps)(
			request({ limitUsd: 5, limitWindow: "rolling_7d" }, "PATCH"),
			"target",
		);
		expect(response.status).toBe(409);
		expect(await response.text()).toContain("PUT");
		expect((await dbOps.getApiKey("target"))?.limitWindowMode).toBe("calendar");
		expect((await dbOps.getApiKey("target"))?.limitUsd).toBeNull();
		expect(await dbOps.getApiKeyLimits("target")).toHaveLength(1);
	});

	it("legacy updates and clearing only replace the matching key-wide window", async () => {
		await key();
		await dbOps.replaceApiKeyLimits(
			"target",
			[
				{ scopeModel: null, window: "week", limitUsd: 1, enforce: "block" },
				{ scopeModel: null, window: "month", limitUsd: 9, enforce: "block" },
			],
			"rolling",
		);
		await dbOps
			.getAdapter()
			.run(
				"UPDATE api_keys SET limit_window = 'rolling_7d', limit_usd = 1, limit_enforce = 'block' WHERE id = 'target'",
			);
		const shim = createApiKeyUpdateSpendLimitHandler(dbOps);
		expect(
			(
				await shim(
					request({ limitUsd: 3, limitWindow: "rolling_7d" }, "PATCH"),
					"target",
				)
			).status,
		).toBe(200);
		expect(
			(await dbOps.getApiKeyLimits("target")).find((r) => r.window === "month")
				?.limitUsd,
		).toBe(9);
		expect(
			(await dbOps.getApiKeyLimits("target")).find((r) => r.window === "week")
				?.limitUsd,
		).toBe(3);
		expect(
			(await shim(request({ limitUsd: null }, "PATCH"), "target")).status,
		).toBe(200);
		expect(
			(await dbOps.getApiKeyLimits("target")).map((r) => r.window),
		).toEqual(["month"]);
	});

	it("CLI legacy limits map every window, clear migrated weeks, and reject incompatible mode edits", async () => {
		await key();
		await updateApiKeySpendLimit(dbOps, "target", {
			limitUsd: 2,
			limitWindow: "rolling_7d",
			limitEnforce: "block",
		});
		expect(
			(await dbOps.getApiKeyLimits("target")).map((r) => r.window),
		).toEqual(["week"]);
		await updateApiKeySpendLimit(dbOps, "target", {
			limitUsd: 3,
			limitWindow: "rolling_30d",
			limitEnforce: "warn",
		});
		expect(
			(await dbOps.getApiKeyLimits("target")).map((r) => r.window),
		).toEqual(["month"]);
		expect((await dbOps.getApiKey("target"))?.limitWindowMode).toBe("rolling");
		await updateApiKeySpendLimit(dbOps, "target", {
			limitUsd: 4,
			limitWindow: "calendar_month",
			limitEnforce: "block",
		});
		expect((await dbOps.getApiKey("target"))?.limitWindowMode).toBe("calendar");
		await dbOps.replaceApiKeyLimits(
			"target",
			[{ scopeModel: "opus", window: "day", limitUsd: 1, enforce: "warn" }],
			"calendar",
		);
		await expect(
			updateApiKeySpendLimit(dbOps, "target", {
				limitUsd: 4,
				limitWindow: "rolling_7d",
				limitEnforce: "block",
			}),
		).rejects.toThrow("use PUT");
		await updateApiKeySpendLimit(dbOps, "target", null);
		expect((await dbOps.getApiKeyLimits("target"))[0]?.scopeModel).toBe("opus");
		expect((await dbOps.getApiKey("target"))?.limitWindowMode).toBe("calendar");
	});

	it("PUT drops stale legacy metadata before a later legacy clear", async () => {
		await key();
		await updateApiKeySpendLimit(dbOps, "target", {
			limitUsd: 2,
			limitWindow: "rolling_7d",
			limitEnforce: "block",
		});
		const put = createApiKeyLimitsPutHandler(dbOps);
		await put(
			request({
				mode: "calendar",
				limits: [
					{ scopeModel: null, window: "week", limitUsd: 10, enforce: "warn" },
				],
			}),
			"target",
		);
		expect((await dbOps.getApiKey("target"))?.limitWindow).toBeNull();
		await updateApiKeySpendLimit(dbOps, "target", null);
		expect((await dbOps.getApiKeyLimits("target"))[0]?.limitUsd).toBe(10);
	});

	it("preserves row ids and creation times when limits are saved again", async () => {
		await key();
		const put = createApiKeyLimitsPutHandler(dbOps);
		const row = {
			scopeModel: "opus",
			window: "day",
			limitUsd: 2,
			enforce: "warn",
		};
		await put(request({ mode: "calendar", limits: [row] }), "target");
		const [before] = await dbOps.getApiKeyLimits("target");
		await put(
			request({ mode: "calendar", limits: [row, { ...row, window: "hour" }] }),
			"target",
		);
		const after = (await dbOps.getApiKeyLimits("target")).find(
			(r) => r.window === "day",
		);
		expect(after?.id).toBe(before.id);
		expect(after?.createdAt).toBe(before.createdAt);
		await put(
			request({ mode: "calendar", limits: [{ ...row, limitUsd: 9 }] }),
			"target",
		);
		expect((await dbOps.getApiKeyLimits("target"))[0].id).toBe(before.id);
	});

	it("rejects disabled overrides", async () => {
		await key();
		const removed = await dbOps.createCombo("Removed");
		await dbOps.updateCombo(removed.id, { enabled: false });
		const patch = createApiKeyRoutingUpdateHandler(dbOps);
		expect(
			(
				await patch(
					request({ familyComboOverrides: { opus: removed.id } }, "PATCH"),
					"target",
				)
			).status,
		).toBe(400);
	});

	it("cleans only deleted combo references", async () => {
		await key();
		const removed = await dbOps.createCombo("Removed");
		const kept = await dbOps.createCombo("Kept");
		await dbOps.updateApiKeyRouting("target", {
			opus: removed.id,
			sonnet: kept.id,
		});
		await dbOps.deleteCombo(removed.id);
		expect((await dbOps.getApiKey("target"))?.familyComboOverrides).toEqual({
			sonnet: kept.id,
		});
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
	it("hides account identities and other keys' subscription totals from own-key usage", async () => {
		const own = await credential("own", "api-only");
		const admin = await credential("admin", "admin");
		const now = Date.now();
		await dbOps
			.getAdapter()
			.run(
				"INSERT INTO accounts (id, name, provider, created_at, plan_monthly_usd) VALUES (?, ?, ?, ?, ?)",
				["private-account-id", "private-account-name", "anthropic", now, 200],
			);
		for (const [id, apiKeyId, cost] of [
			["own-plan", "own", 2],
			["other-plan", "admin", 98],
		] as const) {
			await dbOps
				.getAdapter()
				.run(
					"INSERT INTO requests (id, timestamp, method, path, account_used, success, model, cost_usd, billing_type, api_key_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
					[
						id,
						now - 1000,
						"POST",
						"/v1/messages",
						"private-account-id",
						1,
						"claude-opus-4-6",
						cost,
						"plan",
						apiKeyId,
					],
				);
		}
		await dbOps.updateApiKeyRestrictions("own", {
			allowedAccounts: ["private-account-id"],
			allowedModels: null,
			allowedProviders: null,
		});
		const api = router();
		const ownResponse = await call(api, "/api/api-keys/own/usage", own);
		const body = await ownResponse?.json();
		expect(body.planValueUsd).toBe(2);
		expect(body.planCost.planCostUsd).toBeGreaterThan(0);
		const serialized = JSON.stringify(body);
		for (const hidden of [
			"private-account-id",
			"private-account-name",
			"accountPlanValueUsd",
			"planMonthlyUsd",
			"proratedPriceUsd",
		])
			expect(serialized).not.toContain(hidden);
		expect(body.accounts[0].accountName).toMatch(/^Account \d+$/);
		const adminResponse = await call(api, "/api/api-keys/own/usage", admin);
		const adminBody = await adminResponse?.json();
		expect(adminBody.accounts[0].accountId).toBe("private-account-id");
		expect(adminBody.planCost.accounts[0].accountPlanValueUsd).toBe(100);
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
