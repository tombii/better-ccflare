import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, unlinkSync } from "node:fs";
import {
	DatabaseFactory,
	type DatabaseOperations,
} from "@better-ccflare/database";
import {
	ApiKeySpendCounter,
	getApiKeySpendCounter,
	resetApiKeySpendCounter,
	SPEND_RESYNC_TTL_MS,
} from "@better-ccflare/proxy";
import { NodeCryptoUtils } from "@better-ccflare/types";
import { APIRouter } from "../../router";
import type { APIContext } from "../../types";
import { createApiKeyUsageHandler } from "../api-key-usage";
import {
	createApiKeyResetSpendHandler,
	createApiKeysListHandler,
} from "../api-keys";

const DB_PATH = `/tmp/api-key-reset-spend-${process.pid}.db`;
let dbOps: DatabaseOperations;
const counters: ApiKeySpendCounter[] = [];
function clean() {
	for (const suffix of ["", "-wal", "-shm"])
		if (existsSync(DB_PATH + suffix)) unlinkSync(DB_PATH + suffix);
}
beforeEach(async () => {
	clean();
	resetApiKeySpendCounter();
	DatabaseFactory.initialize(DB_PATH);
	dbOps = DatabaseFactory.getInstance();
	await dbOps.createApiKey({
		id: "target",
		name: "build key",
		hashedKey: "unused",
		prefixLast8: "unused",
		createdAt: Date.now(),
		isActive: true,
		role: "api-only",
	});
});
afterEach(async () => {
	for (const counter of counters.splice(0)) counter.dispose();
	await new Promise((resolve) => setTimeout(resolve, 50));
	resetApiKeySpendCounter();
	DatabaseFactory.reset();
	clean();
});
async function cost(id: string, timestamp: number, value = 6, responseMs = 0) {
	await dbOps
		.getAdapter()
		.run(
			"INSERT INTO requests (id,timestamp,response_time_ms,method,path,model,limit_model,cost_usd,api_key_id,success) VALUES (?,?,?,'POST','/v1/messages','claude-opus-4-6','opus',?,'target',1)",
			[id, timestamp, responseMs, value],
		);
}
async function limits(mode: "calendar" | "rolling") {
	await dbOps.replaceApiKeyLimits(
		"target",
		[
			{ scopeModel: null, window: "hour", limitUsd: 5, enforce: "block" },
			{ scopeModel: "opus", window: "day", limitUsd: 5, enforce: "block" },
			{
				scopeModel: "claude-opus-4-6",
				window: "week",
				limitUsd: 5,
				enforce: "block",
			},
			{ scopeModel: null, window: "month", limitUsd: 5, enforce: "warn" },
		],
		mode,
	);
	return dbOps.getApiKeyLimits("target");
}
describe("reset API key spend", () => {
	it("redacts reset actor on own-key usage while retaining it for admins", async () => {
		await dbOps.resetApiKeySpend(
			"target",
			Date.now(),
			"API key private-admin (admin-id)",
		);
		const handler = createApiKeyUsageHandler({ dbOps } as APIContext);
		const caller = {
			isAuthenticated: true,
			apiKeyId: "target",
			role: "api-only" as const,
		};
		const own = await (
			await handler("target", new URLSearchParams(), caller)
		).json();
		expect(own.apiKey.spendResetAt).toBeNumber();
		expect(own.apiKey).not.toHaveProperty("spendResetBy");
		const admin = await (
			await handler("target", new URLSearchParams(), {
				...caller,
				role: "admin",
			})
		).json();
		expect(admin.apiKey.spendResetBy).toBe("API key private-admin (admin-id)");
	});
	it("reports reservations separately from actual spend on API gauges", async () => {
		const rows = await limits("calendar");
		await getApiKeySpendCounter(dbOps).checkAndReserve(
			"target",
			"reserved",
			rows,
			"calendar",
			"opus",
			"claude-opus-4-6",
			2,
		);
		const response = await (await createApiKeysListHandler(dbOps)()).json();
		const key = response.data.find(
			(value: { id: string }) => value.id === "target",
		);
		expect(key.limits[0].spentUsd).toBe(0);
		expect(key.limits[0].reservedUsd).toBe(2);
	});

	for (const mode of ["calendar", "rolling"] as const) {
		it(`${mode}: unblocks immediately, counts new spend, preserves history and survives reconcile/restart`, async () => {
			const rows = await limits(mode);
			const now = Date.now();
			await cost("old", now - 5000);
			const usage = createApiKeyUsageHandler({ dbOps } as APIContext);
			const usageBefore = await (
				await usage("target", new URLSearchParams("range=24h"))
			).json();
			const counter = getApiKeySpendCounter(dbOps);
			expect(
				(await counter.getLimitSnapshot("target", rows[0], mode)).exceeded,
			).toBe(true);
			counter.record(
				"target",
				2,
				"claude-opus-4-6",
				now - 1000,
				"local-old",
				"opus",
			);
			const response = await createApiKeyResetSpendHandler(dbOps)(
				"build key",
				"admin tester",
			);
			expect(response.status).toBe(200);
			const { data } = await response.json();
			expect(data.spendResetBy).toBe("admin tester");
			expect(data.spendResetAt).toBeGreaterThanOrEqual(now);
			const usageAfter = await (
				await usage("target", new URLSearchParams("range=24h"))
			).json();
			expect(usageAfter.requests).toBe(usageBefore.requests);
			expect(usageAfter.totalCostUsd).toBe(usageBefore.totalCostUsd);
			expect(usageAfter.apiKey.spendResetAt).toBe(data.spendResetAt);
			expect(data.limits).toHaveLength(4);
			expect(
				data.limits.every((r: { spentUsd: number }) => r.spentUsd === 0),
			).toBe(true);
			const next = await counter.checkAndReserve(
				"target",
				"next",
				rows,
				mode,
				"opus",
				"claude-opus-4-6",
				1,
			);
			expect(next.every(({ snapshot }) => !snapshot.exceeded)).toBe(true);
			counter.releaseReservation("next");
			const fresh = new ApiKeySpendCounter(dbOps);
			counters.push(fresh);
			for (const row of rows)
				expect(
					(await fresh.getLimitSnapshot("target", row, mode)).spentUsd,
				).toBe(0);
			await counter.reconcileActiveKeys();
			for (const row of rows)
				expect(
					(
						await counter.getLimitSnapshot(
							"target",
							row,
							mode,
							Date.now() + SPEND_RESYNC_TTL_MS,
							true,
						)
					).spentUsd,
				).toBe(0);
			const newAt = Date.now();
			await cost("new", newAt);
			counter.record("target", 6, "claude-opus-4-6", newAt, "new", "opus");
			for (const row of rows)
				expect(
					(
						await counter.getLimitSnapshot(
							"target",
							row,
							mode,
							Date.now(),
							true,
						)
					).spentUsd,
				).toBe(6);
			expect(
				(
					await counter.checkAndReserve(
						"target",
						"blocked-again",
						rows,
						mode,
						"opus",
						"claude-opus-4-6",
						1,
					)
				).some(
					({ limit, snapshot }) =>
						limit.enforce === "block" && snapshot.exceeded,
				),
			).toBe(true);
			expect(
				await dbOps
					.getAdapter()
					.get(
						"SELECT COUNT(*) AS count, SUM(cost_usd) AS total FROM requests WHERE api_key_id='target'",
					),
			).toEqual({ count: 2, total: 12 });
			const listed = await (await createApiKeysListHandler(dbOps)()).json();
			expect(
				listed.data.find((key: { id: string }) => key.id === "target")
					.spendResetBy,
			).toBe("admin tester");
		});
	}
	it("drops reservations across reset and counts pre-reset requests completed after it", async () => {
		const rows = await limits("calendar");
		const counter = getApiKeySpendCounter(dbOps);
		await counter.checkAndReserve(
			"target",
			"inflight",
			rows,
			"calendar",
			"opus",
			"claude-opus-4-6",
			2,
		);
		const resetAt = Date.now();
		await dbOps.resetApiKeySpend("target", resetAt, "CLI");
		counter.applySpendReset("target", resetAt);
		expect(
			(await counter.getLimitSnapshot("target", rows[0], "calendar")).spentUsd,
		).toBe(0);
		await cost("inflight", resetAt - 5000, 4, 5000);
		counter.record("target", 4, "claude-opus-4-6", resetAt, "inflight", "opus");
		expect(
			(
				await counter.getLimitSnapshot(
					"target",
					rows[0],
					"calendar",
					Date.now(),
					true,
				)
			).spentUsd,
		).toBe(4);
	});
	it("filters the legacy aggregate and full-event paths without changing usage history", async () => {
		const rows = await limits("rolling");
		const now = Date.now();
		await cost("old", now - 5000);
		await cost("inflight", now - 3000, 2, 3000);
		await dbOps.resetApiKeySpend("target", now, "CLI");
		expect(
			(await dbOps.getApiKeySpendSince("target", now - 10_000)).totalUsd,
		).toBe(2);
		expect(
			(await dbOps.getApiKeySpendEventsSince("target", now - 10_000)).map(
				(event) => event.requestId,
			),
		).toEqual(["inflight"]);
		const fallback = new ApiKeySpendCounter({
			getApiKey: (id: string) => dbOps.getApiKey(id),
			getApiKeySpendEventsSince: (id: string, since: number) =>
				dbOps.getApiKeySpendEventsSince(id, since),
		} as DatabaseOperations);
		counters.push(fallback);
		expect(
			(await fallback.getLimitSnapshot("target", rows[0], "rolling")).spentUsd,
		).toBe(2);
	});
	it("clears only this key's active spend alerts", async () => {
		await limits("calendar");
		const timestamp = Date.now();
		for (const [id, type] of [
			["api_key_spend_limit:target:123", "api_key_spend_limit"],
			["api_key_spend_limit:target:child:123", "api_key_spend_limit"],
			["api_key_spend_limit:other:123", "api_key_spend_limit"],
			["other", "auth_failure"],
		]) {
			await dbOps
				.getAdapter()
				.run(
					"INSERT INTO alerts (id,timestamp,type,severity,title,message,acknowledged) VALUES (?, ?, ?, 'warning','test','test',0)",
					[id, timestamp, type],
				);
		}
		await dbOps.resetApiKeySpend("target", timestamp, "admin");
		expect(
			await dbOps
				.getAdapter()
				.query("SELECT id FROM alerts WHERE acknowledged=0 ORDER BY id"),
		).toEqual([{ id: "api_key_spend_limit:other:123" }, { id: "other" }]);
	});
	it("returns 403 for api-only keys and permits admin and dashboard sessions", async () => {
		await limits("calendar");
		const cryptoUtils = new NodeCryptoUtils();
		const keys: Record<string, string> = {};
		for (const role of ["admin", "api-only"] as const) {
			const plain = await cryptoUtils.generateApiKey();
			keys[role] = plain;
			await dbOps.createApiKey({
				id: role,
				name: role,
				hashedKey: await cryptoUtils.hashApiKey(plain),
				prefixLast8: plain.slice(-8),
				createdAt: Date.now(),
				isActive: true,
				role,
			});
		}
		const context = {
			db: dbOps.getAdapter(),
			dbOps,
			config: {
				getUsageThrottlingFiveHourEnabled: () => false,
				getUsageThrottlingWeeklyEnabled: () => false,
			},
		} as unknown as APIContext;
		const router = new APIRouter(context);
		const url = new URL("http://localhost/api/api-keys/target/reset-spend");
		expect(
			(
				await router.handleRequest(
					url,
					new Request(url, {
						method: "POST",
						headers: { "x-api-key": keys["api-only"] },
					}),
				)
			)?.status,
		).toBe(403);
		expect(
			(
				await router.handleRequest(
					url,
					new Request(url, {
						method: "POST",
						headers: { "x-api-key": keys.admin },
					}),
				)
			)?.status,
		).toBe(200);
		// The same bypass signal the dashboard uses; no API key identity is present.
		const auth = (
			router as unknown as {
				authService: { authenticateRequest: () => Promise<unknown> };
			}
		).authService;
		const original = auth.authenticateRequest;
		auth.authenticateRequest = async () => ({ isAuthenticated: true });
		try {
			expect(
				(await router.handleRequest(url, new Request(url, { method: "POST" })))
					?.status,
			).toBe(200);
		} finally {
			auth.authenticateRequest = original;
		}
	});
	it("supersedes an already-running reconciliation so old SQL cannot restore cleared spend", async () => {
		const rows = await limits("calendar");
		const counter = getApiKeySpendCounter(dbOps);
		await cost("old", Date.now() - 5000);
		await counter.getLimitSnapshot("target", rows[0], "calendar");
		const original = dbOps.getApiKeySpendReconciliation.bind(dbOps);
		let release!: (value: Awaited<ReturnType<typeof original>>) => void;
		let started!: () => void;
		const didStart = new Promise<void>((resolve) => {
			started = resolve;
		});
		dbOps.getApiKeySpendReconciliation = async (...args) => {
			const _result = await original(...args);
			started();
			return new Promise((resolve) => {
				release = resolve;
			});
		};
		const stale = counter.getLimitSnapshot(
			"target",
			rows[0],
			"calendar",
			Date.now(),
			true,
		);
		await didStart;
		const resetAt = Date.now();
		await dbOps.resetApiKeySpend("target", resetAt, "admin");
		counter.applySpendReset("target", resetAt);
		release({
			calendar: [
				{
					window: "hour",
					totals: [{ model: "opus", requestedModel: "opus", totalUsd: 6 }],
				},
			],
			events: [],
		});
		await expect(stale).rejects.toThrow("superseded");
		dbOps.getApiKeySpendReconciliation = original;
		expect(
			(await counter.getLimitSnapshot("target", rows[0], "calendar")).spentUsd,
		).toBe(0);
	});
	it("supersedes the legacy aggregate if reset occurs while its SQL is running", async () => {
		let release!: (value: {
			totalUsd: number;
			oldestMs: number | null;
		}) => void;
		let started!: () => void;
		const didStart = new Promise<void>((resolve) => {
			started = resolve;
		});
		let resetAt: number | null = null;
		let delay = true;
		const counter = new ApiKeySpendCounter({
			getApiKey: async () => ({ spendResetAt: resetAt }),
			getApiKeySpendSince: async () => {
				if (!delay) return { totalUsd: 0, oldestMs: null };
				started();
				return new Promise((resolve) => {
					release = resolve;
				});
			},
		} as unknown as DatabaseOperations);
		counters.push(counter);
		const limit = {
			limitUsd: 5,
			limitWindow: "rolling_30d",
			limitEnforce: "block",
		} as const;
		const stale = counter.getSnapshot("target", limit);
		await didStart;
		resetAt = Date.now();
		counter.applySpendReset("target", resetAt);
		delay = false;
		release({ totalUsd: 6, oldestMs: resetAt - 5000 });
		await expect(stale).rejects.toThrow("reset during reconciliation");
		expect((await counter.getSnapshot("target", limit)).spentUsd).toBe(0);
	});
	it("accepts CLI cache reload with its control secret, but never authorizes a reset with that secret", async () => {
		const rows = await limits("calendar");
		await cost("old", Date.now() - 5000);
		const counter = getApiKeySpendCounter(dbOps);
		await counter.getLimitSnapshot("target", rows[0], "calendar");
		const resetAt = Date.now();
		await dbOps.resetApiKeySpend("target", resetAt, "CLI");
		const router = new APIRouter({
			db: dbOps.getAdapter(),
			dbOps,
			config: {},
			localControlSecret: "test-control-secret",
		} as APIContext);
		for (const action of ["reset-spend", "reload-spend"]) {
			const url = new URL(`http://localhost/api/api-keys/target/${action}`);
			const response = await router.handleRequest(
				url,
				new Request(url, {
					method: "POST",
					headers: {
						"x-better-ccflare-local-control-secret": "test-control-secret",
					},
				}),
			);
			expect(response?.status).toBe(action === "reload-spend" ? 200 : 401);
		}
		expect((await dbOps.getApiKey("target"))?.spendResetAt).toBe(resetAt);
		expect(
			(await counter.getLimitSnapshot("target", rows[0], "calendar")).spentUsd,
		).toBe(0);
	});

	it("never regresses a persisted reset boundary or its actor when an older reset finishes later", async () => {
		const now = Date.now();
		await dbOps.resetApiKeySpend("target", now, "later admin");
		await dbOps.resetApiKeySpend("target", now - 1000, "earlier admin");
		const key = await dbOps.getApiKey("target");
		expect(key?.spendResetAt).toBe(now);
		expect(key?.spendResetBy).toBe("later admin");
	});

	for (const mode of ["calendar", "rolling"] as const)
		it(`${mode}: uses recorded cost time when pricing finishes after the reset`, async () => {
			const rows = await limits(mode);
			const now = Date.now();
			await cost("priced-later", now - 10_000, 3, 1000);
			await dbOps
				.getAdapter()
				.run(
					"UPDATE requests SET spend_recorded_at = ? WHERE id = 'priced-later'",
					[now],
				);
			await dbOps.resetApiKeySpend("target", now, "admin");
			const counter = new ApiKeySpendCounter(dbOps);
			counters.push(counter);
			for (const row of rows)
				expect(
					(await counter.getLimitSnapshot("target", row, mode)).spentUsd,
				).toBe(3);
			expect(
				(await dbOps.getApiKeySpendSince("target", now - 60_000)).totalUsd,
			).toBe(3);
			expect(
				(await dbOps.getApiKeySpendEventsSince("target", now - 60_000))[0]
					.timestamp,
			).toBe(now);
			expect(
				await dbOps
					.getAdapter()
					.get(
						"SELECT timestamp,response_time_ms FROM requests WHERE id='priced-later'",
					),
			).toEqual({ timestamp: now - 10_000, response_time_ms: 1000 });
		});
});
