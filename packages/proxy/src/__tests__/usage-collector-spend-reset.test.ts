import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	mock,
	spyOn,
} from "bun:test";
import * as core from "@better-ccflare/core";
import {
	DatabaseFactory,
	type DatabaseOperations,
} from "@better-ccflare/database";
import type { RequestResponse } from "@better-ccflare/types";
import {
	ApiKeySpendCounter,
	getApiKeySpendCounter,
	resetApiKeySpendCounter,
} from "../handlers/api-key-spend";
import { UsageCollector } from "../usage-collector";
import type { StartMessage } from "../worker-messages";

const START = Date.parse("2026-11-13T12:00:00Z");
let db: DatabaseOperations;
let collector: UsageCollector | undefined;
const restarted: ApiKeySpendCounter[] = [];
beforeEach(async () => {
	resetApiKeySpendCounter();
	DatabaseFactory.reset();
	DatabaseFactory.initialize(":memory:");
	db = DatabaseFactory.getInstance();
	await db.createApiKey({
		id: "key",
		name: "budget",
		hashedKey: "fixture-hash",
		prefixLast8: "fixture",
		createdAt: START,
		isActive: true,
		role: "admin",
	});
});
afterEach(() => {
	collector?.dispose();
	collector = undefined;
	for (const counter of restarted) counter.dispose();
	restarted.length = 0;
	resetApiKeySpendCounter();
	DatabaseFactory.reset();
	mock.restore();
});

describe("usage cost recorded after a spend reset", () => {
	for (const mode of ["calendar", "rolling"] as const) {
		it(`${mode}: charges pricing finalized after reset while preserving stream latency and history`, async () => {
			const clock = spyOn(Date, "now").mockReturnValue(START);
			await db.replaceApiKeyLimits(
				"key",
				[
					{ scopeModel: null, window: "hour", limitUsd: 5, enforce: "block" },
					{ scopeModel: "opus", window: "day", limitUsd: 5, enforce: "block" },
				],
				mode,
			);
			const limits = await db.getApiKeyLimits("key");
			const counter = getApiKeySpendCounter(db);
			await counter.checkAndReserve(
				"key",
				"request",
				limits,
				mode,
				"opus",
				"claude-opus-4-6",
				2,
			);
			let finishPricing!: (cost: number) => void;
			spyOn(core, "estimateCostUSD").mockImplementation(
				() =>
					new Promise((resolve) => {
						finishPricing = resolve;
					}),
			);
			const writes: Array<() => Promise<void>> = [];
			let summary: RequestResponse | undefined;
			collector = new UsageCollector(
				db,
				{
					enqueue: (write: () => Promise<void>) => writes.push(write),
					canAcceptPayload: () => false,
					recordPayloadDrop: () => {},
				} as never,
				() => false,
				(value) => {
					summary = value;
				},
			);
			const start: StartMessage = {
				type: "start",
				messageId: "msg",
				requestId: "request",
				accountId: null,
				method: "POST",
				path: "/v1/messages",
				timestamp: START,
				requestHeaders: {},
				requestBody: null,
				project: null,
				responseStatus: 200,
				responseHeaders: {},
				isStream: false,
				providerName: "anthropic",
				accountBillingType: null,
				accountAutoPauseOnOverageEnabled: null,
				accountName: null,
				agentUsed: null,
				comboName: null,
				apiKeyId: "key",
				apiKeyName: "budget",
				retryAttempt: 0,
				failoverAttempts: 0,
				limitModel: "opus",
			};
			collector.handleStart(start);
			clock.mockReturnValue(START + 1_000);
			const finalizing = collector.handleEnd({
				type: "end",
				requestId: "request",
				success: true,
				responseBody: Buffer.from(
					JSON.stringify({
						model: "claude-opus-4-6",
						usage: { input_tokens: 1, output_tokens: 1 },
					}),
				).toString("base64"),
			});
			// Pricing is delayed after EOF, and still owns the request's reservation.
			await Promise.resolve();
			await Promise.resolve();
			expect(collector.hasPendingRequest("request")).toBe(true);
			clock.mockReturnValue(START + 2_000);
			await db.resetApiKeySpend("key", Date.now(), "operator");
			counter.applySpendReset("key", Date.now());
			for (const limit of limits)
				expect(
					(await counter.getLimitSnapshot("key", limit, mode)).spentUsd,
				).toBe(2);
			clock.mockReturnValue(START + 3_000);
			finishPricing(6);
			await finalizing;
			for (const limit of limits) {
				const current = await counter.getLimitSnapshot("key", limit, mode);
				expect(current.spentUsd).toBe(6);
				expect(current.exceeded).toBe(true);
			}
			expect(summary?.timestamp).toBe(new Date(START).toISOString());
			expect(summary?.responseTimeMs).toBe(1_000);
			// A further async-writer delay must not change the logical cost time.
			clock.mockReturnValue(START + 4_000);
			for (const write of writes) await write();
			expect(
				await db
					.getAdapter()
					.get(
						"SELECT timestamp,response_time_ms,spend_recorded_at,cost_usd FROM requests WHERE id='request'",
					),
			).toEqual({
				timestamp: START,
				response_time_ms: 1_000,
				spend_recorded_at: START + 3_000,
				cost_usd: 6,
			});
			await counter.reconcileActiveKeys();
			const fresh = new ApiKeySpendCounter(db);
			restarted.push(fresh);
			for (const limit of limits) {
				expect(
					(await counter.getLimitSnapshot("key", limit, mode, Date.now(), true))
						.spentUsd,
				).toBe(6);
				expect(
					(await fresh.getLimitSnapshot("key", limit, mode)).spentUsd,
				).toBe(6);
			}
			expect(
				await db
					.getAdapter()
					.get(
						"SELECT COUNT(*) AS requests,SUM(cost_usd) AS total FROM requests",
					),
			).toEqual({ requests: 1, total: 6 });
		});
	}
});
