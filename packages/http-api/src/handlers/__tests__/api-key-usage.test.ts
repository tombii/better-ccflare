import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, unlinkSync } from "node:fs";
// Side-effect import: load @better-ccflare/core before @better-ccflare/types.
// types/agent.ts runtime-imports core while core/strategy.ts imports types, a
// pre-existing cycle that crashes when types is the first module evaluated.
import "@better-ccflare/core";
import type { DatabaseOperations } from "@better-ccflare/database";
import { DatabaseFactory } from "@better-ccflare/database";
import { resetApiKeySpendCounter } from "@better-ccflare/proxy";
import type { ApiKeyUsageResponse } from "@better-ccflare/types";
import { calendarMonthFraction } from "../../services/api-key-usage-range";
import type { APIContext } from "../../types";
import { createApiKeyUsageHandler } from "../api-key-usage";

const TEST_DB_PATH = `${process.env.TMPDIR || "/tmp"}/test-api-key-usage.db`;

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

describe("createApiKeyUsageHandler", () => {
	let dbOps: DatabaseOperations;
	let handler: (
		keyIdOrName: string,
		searchParams: URLSearchParams,
	) => Promise<Response>;
	let now: number;

	function cleanupDbFiles() {
		for (const suffix of ["", "-wal", "-shm"]) {
			try {
				const p = `${TEST_DB_PATH}${suffix}`;
				if (existsSync(p)) unlinkSync(p);
			} catch {
				// best-effort cleanup
			}
		}
	}

	beforeEach(() => {
		cleanupDbFiles();
		resetApiKeySpendCounter();
		DatabaseFactory.initialize(TEST_DB_PATH);
		dbOps = DatabaseFactory.getInstance();
		now = Date.now();
		handler = createApiKeyUsageHandler({ dbOps } as unknown as APIContext);
	});

	afterEach(() => {
		// Close BEFORE unlinking: deleting the file under an open connection
		// makes close()'s `PRAGMA wal_checkpoint(TRUNCATE)` fail with
		// SQLITE_IOERR_VNODE, which surfaces as an unhandled error between
		// tests and can leave the next beforeEach unable to open the database.
		DatabaseFactory.reset();
		resetApiKeySpendCounter();
		cleanupDbFiles();
	});

	async function seedKey(id: string, name: string): Promise<void> {
		await dbOps.getAdapter().run(
			`INSERT INTO api_keys (id, name, hashed_key, prefix_last_8, created_at, usage_count, is_active, role)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
			[id, name, `hash-${id}`, "abcd1234", now - 30 * DAY, 0, 1, "admin"],
		);
	}

	async function seedAccount(
		id: string,
		name: string,
		planMonthlyUsd: number | null,
	): Promise<void> {
		await dbOps.getAdapter().run(
			`INSERT INTO accounts (id, name, provider, created_at, plan_monthly_usd)
				 VALUES (?, ?, ?, ?, ?)`,
			[id, name, "anthropic", now - 60 * DAY, planMonthlyUsd],
		);
	}

	let requestSeq = 0;
	async function seedRequest(row: {
		apiKeyId: string | null;
		accountId?: string | null;
		agoMs?: number;
		model?: string | null;
		costUsd?: number | null;
		billingType?: string | null;
		success?: boolean;
		inputTokens?: number;
		outputTokens?: number;
		cacheReadTokens?: number;
		cacheCreationTokens?: number;
		totalTokens?: number;
	}): Promise<void> {
		requestSeq += 1;
		await dbOps.getAdapter().run(
			`INSERT INTO requests
				(id, timestamp, method, path, account_used, success, model, cost_usd,
				 billing_type, api_key_id, input_tokens, output_tokens,
				 cache_read_input_tokens, cache_creation_input_tokens, total_tokens)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			[
				`req-${requestSeq}`,
				now - (row.agoMs ?? HOUR),
				"POST",
				"/v1/messages",
				row.accountId ?? null,
				row.success === false ? 0 : 1,
				row.model === undefined ? "claude-sonnet-4-20250514" : row.model,
				row.costUsd === undefined ? 1 : row.costUsd,
				row.billingType === undefined ? "api" : row.billingType,
				row.apiKeyId,
				row.inputTokens ?? 0,
				row.outputTokens ?? 0,
				row.cacheReadTokens ?? 0,
				row.cacheCreationTokens ?? 0,
				row.totalTokens ?? 0,
			],
		);
	}

	async function usage(
		keyIdOrName: string,
		range = "24h",
	): Promise<{ status: number; body: ApiKeyUsageResponse }> {
		const res = await handler(keyIdOrName, new URLSearchParams({ range }));
		return {
			status: res.status,
			body: (await res.json()) as ApiKeyUsageResponse,
		};
	}

	it("404s for an unknown key", async () => {
		const res = await handler("nope", new URLSearchParams());
		expect(res.status).toBe(404);
	});

	it("resolves a key by name as well as by id", async () => {
		await seedKey("key-1", "alpha");
		expect((await usage("key-1")).status).toBe(200);
		expect((await usage("alpha")).status).toBe(200);
	});

	it("reports an all-zero window for a key with no traffic", async () => {
		await seedKey("key-1", "alpha");
		const { status, body } = await usage("key-1");
		expect(status).toBe(200);
		expect(body.requests).toBe(0);
		// 0, not NaN: the success-rate denominator is guarded.
		expect(body.successRate).toBe(0);
		expect(body.apiCostUsd).toBe(0);
		expect(body.planValueUsd).toBe(0);
		expect(body.planCost.planCostUsd).toBe(0);
		expect(body.efficiencyRatio).toBeNull();
		expect(body.efficiencyStatus).toBe("no_plan_traffic");
		expect(body.models).toEqual([]);
		expect(body.accounts).toEqual([]);
		expect(body.series).toEqual([]);
		expect(body.unknownPricingModels).toEqual([]);
	});

	it("counts only this key's requests", async () => {
		await seedKey("key-1", "alpha");
		await seedKey("key-2", "beta");
		await seedRequest({ apiKeyId: "key-1", costUsd: 2 });
		await seedRequest({ apiKeyId: "key-2", costUsd: 99 });
		await seedRequest({ apiKeyId: null, costUsd: 99 });

		const { body } = await usage("key-1");
		expect(body.requests).toBe(1);
		expect(body.apiCostUsd).toBeCloseTo(2, 10);
	});

	it("excludes requests older than the window", async () => {
		await seedKey("key-1", "alpha");
		await seedRequest({ apiKeyId: "key-1", agoMs: HOUR, costUsd: 3 });
		await seedRequest({ apiKeyId: "key-1", agoMs: 3 * DAY, costUsd: 100 });

		const { body } = await usage("key-1", "24h");
		expect(body.requests).toBe(1);
		expect(body.apiCostUsd).toBeCloseTo(3, 10);

		const wider = await usage("key-1", "7d");
		expect(wider.body.requests).toBe(2);
		expect(wider.body.apiCostUsd).toBeCloseTo(103, 10);
	});

	it("puts a NULL billing_type row in the API bucket, not in neither", async () => {
		// `billing_type != 'plan'` is NULL for a NULL row, so the naive form
		// drops it from BOTH buckets and its cost silently disappears. This is
		// the regression guard for that.
		await seedKey("key-1", "alpha");
		await seedRequest({ apiKeyId: "key-1", billingType: null, costUsd: 7 });
		await seedRequest({ apiKeyId: "key-1", billingType: "api", costUsd: 1 });
		await seedRequest({
			apiKeyId: "key-1",
			billingType: "overage",
			costUsd: 2,
		});
		await seedRequest({ apiKeyId: "key-1", billingType: "plan", costUsd: 5 });

		const { body } = await usage("key-1");
		expect(body.apiCostUsd).toBeCloseTo(10, 10); // 7 + 1 + 2
		expect(body.planValueUsd).toBeCloseTo(5, 10);
		// Nothing fell out of both buckets.
		expect(body.apiCostUsd + body.planValueUsd).toBeCloseTo(15, 10);
	});

	it("reports success rate over the window", async () => {
		await seedKey("key-1", "alpha");
		await seedRequest({ apiKeyId: "key-1", success: true });
		await seedRequest({ apiKeyId: "key-1", success: true });
		await seedRequest({ apiKeyId: "key-1", success: true });
		await seedRequest({ apiKeyId: "key-1", success: false });

		const { body } = await usage("key-1");
		expect(body.requests).toBe(4);
		expect(body.successfulRequests).toBe(3);
		expect(body.successRate).toBeCloseTo(75, 10);
	});

	it("breaks tokens down and sums per model and per account", async () => {
		await seedKey("key-1", "alpha");
		await seedAccount("acc-1", "one", 200);
		await seedRequest({
			apiKeyId: "key-1",
			accountId: "acc-1",
			model: "claude-sonnet-4-20250514",
			costUsd: 2,
			inputTokens: 10,
			outputTokens: 20,
			cacheReadTokens: 30,
			cacheCreationTokens: 40,
			totalTokens: 100,
		});
		await seedRequest({
			apiKeyId: "key-1",
			accountId: "acc-1",
			model: "claude-opus-4-20250514",
			costUsd: 3,
			inputTokens: 1,
			totalTokens: 1,
		});

		const { body } = await usage("key-1");
		expect(body.tokens).toEqual({
			inputTokens: 11,
			outputTokens: 20,
			cacheReadInputTokens: 30,
			cacheCreationInputTokens: 40,
			totalTokens: 101,
		});
		expect(body.models).toHaveLength(2);
		// Sorted by cost descending.
		expect(body.models[0].model).toBe("claude-opus-4-20250514");
		expect(body.models[0].costUsd).toBeCloseTo(3, 10);
		expect(body.accounts).toHaveLength(1);
		expect(body.accounts[0].accountId).toBe("acc-1");
		expect(body.accounts[0].accountName).toBe("one");
		expect(body.accounts[0].requests).toBe(2);
		expect(body.accounts[0].costUsd).toBeCloseTo(5, 10);
	});

	it("handles rows with a NULL model and no tokens", async () => {
		// One real key on live data has 7,456 requests shaped exactly like this.
		await seedKey("key-1", "alpha");
		for (let i = 0; i < 3; i++) {
			await seedRequest({
				apiKeyId: "key-1",
				model: null,
				costUsd: null,
				totalTokens: 0,
			});
		}

		const { status, body } = await usage("key-1");
		expect(status).toBe(200);
		expect(body.requests).toBe(3);
		expect(body.apiCostUsd).toBe(0);
		expect(body.tokens.totalTokens).toBe(0);
		expect(body.models).toHaveLength(1);
		expect(body.models[0].model).toBeNull();
		expect(body.models[0].requests).toBe(3);
		// A NULL model is never "unknown pricing": there is no model to price.
		expect(body.unknownPricingModels).toEqual([]);
	});

	it("surfaces models the pricing catalogue has no rates for", async () => {
		await seedKey("key-1", "alpha");
		await seedRequest({
			apiKeyId: "key-1",
			model: "totally-unknown-model-xyz",
			costUsd: 0,
			totalTokens: 3_000_000,
		});
		await seedRequest({
			apiKeyId: "key-1",
			model: "claude-sonnet-4-20250514",
			costUsd: 1,
		});

		const { body } = await usage("key-1");
		expect(body.unknownPricingModels).toEqual(["totally-unknown-model-xyz"]);
	});

	it("apportions plan cost across accounts and reports the ratio", async () => {
		await seedKey("key-1", "alpha");
		await seedKey("key-2", "beta");
		await seedAccount("acc-1", "one", 300); // $300/month
		// This key: $100 of plan value on acc-1. Another key: $300. So the
		// account total is $400 and this key's share is 0.25. Over the 30d
		// window the prorated price is the full $300, so plan cost is $75.
		await seedRequest({
			apiKeyId: "key-1",
			accountId: "acc-1",
			billingType: "plan",
			costUsd: 100,
			agoMs: HOUR,
		});
		await seedRequest({
			apiKeyId: "key-2",
			accountId: "acc-1",
			billingType: "plan",
			costUsd: 300,
			agoMs: HOUR,
		});

		const { body } = await usage("key-1", "30d");
		expect(body.planValueUsd).toBeCloseTo(100, 10);
		expect(body.planCost.accounts).toHaveLength(1);
		expect(body.planCost.accounts[0].share).toBeCloseTo(0.25, 10);
		const expectedCost =
			75 * calendarMonthFraction(body.windowStartMs, body.windowEndMs);
		expect(body.planCost.planCostUsd).toBeCloseTo(expectedCost, 6);
		expect(body.efficiencyStatus).toBe("ok");
		expect(body.efficiencyRatio).toBeCloseTo(100 / expectedCost, 6);
	});

	it("reports an unpriced account separately rather than as free", async () => {
		await seedKey("key-1", "alpha");
		await seedAccount("acc-1", "unpriced", null);
		await seedRequest({
			apiKeyId: "key-1",
			accountId: "acc-1",
			billingType: "plan",
			costUsd: 500,
		});

		const { body } = await usage("key-1", "30d");
		expect(body.planValueUsd).toBeCloseTo(500, 10);
		expect(body.planCost.planCostUsd).toBe(0);
		expect(body.planCost.unpricedAccountIds).toEqual(["acc-1"]);
		expect(body.planCost.accounts[0].contributionUsd).toBeNull();
		expect(body.efficiencyRatio).toBeNull();
		expect(body.efficiencyStatus).toBe("unpriced");
	});

	it("buckets the series and echoes the bucket width", async () => {
		await seedKey("key-1", "alpha");
		await seedRequest({ apiKeyId: "key-1", agoMs: HOUR, costUsd: 1 });
		await seedRequest({ apiKeyId: "key-1", agoMs: HOUR + 1000, costUsd: 1 });
		await seedRequest({ apiKeyId: "key-1", agoMs: 5 * HOUR, costUsd: 1 });

		const { body } = await usage("key-1", "24h");
		expect(body.bucketMs).toBe(HOUR);
		// Two requests a second apart share a bucket; the third does not.
		expect(body.series.length).toBeGreaterThanOrEqual(2);
		const total = body.series.reduce((sum, point) => sum + point.requests, 0);
		expect(total).toBe(3);
		for (const point of body.series) {
			expect(point.ts % HOUR).toBe(0);
		}
		// Ordered ascending by bucket.
		const timestamps = body.series.map((point) => point.ts);
		expect([...timestamps].sort((a, b) => a - b)).toEqual(timestamps);
	});

	it("echoes the key's limit state and restrictions", async () => {
		await seedKey("key-1", "alpha");
		await dbOps
			.getAdapter()
			.run(
				`UPDATE api_keys SET allowed_models = ?, limit_usd = ?, limit_window = ?, limit_enforce = ? WHERE id = ?`,
				[JSON.stringify(["opus"]), 50, "rolling_7d", "warn", "key-1"],
			);

		const { body } = await usage("key-1");
		expect(body.restrictions.allowedModels).toEqual(["opus"]);
		expect(body.restrictions.allowedAccounts).toBeNull();
		expect(body.limit.limitUsd).toBe(50);
		expect(body.limit.limitWindow).toBe("rolling_7d");
		expect(body.limit.limitEnforce).toBe("warn");
		expect(body.apiKey.name).toBe("alpha");
		expect(body.apiKey.role).toBe("admin");
	});

	it("bounds custom queries on both sides, including the denominator and series", async () => {
		await seedKey("key-1", "alpha");
		await seedKey("key-2", "beta");
		await seedAccount("acc-1", "one", 300);
		await seedRequest({
			apiKeyId: "key-1",
			accountId: "acc-1",
			billingType: "plan",
			costUsd: 10,
			agoMs: 2 * HOUR,
		});
		await seedRequest({
			apiKeyId: "key-2",
			accountId: "acc-1",
			billingType: "plan",
			costUsd: 10,
			agoMs: 2 * HOUR,
		});
		await seedRequest({
			apiKeyId: "key-1",
			accountId: "acc-1",
			billingType: "plan",
			costUsd: 100,
			agoMs: 0,
		});
		const res = await handler(
			"alpha",
			new URLSearchParams({
				range: "custom",
				from: new Date(now - 3 * HOUR).toISOString(),
				to: new Date(now - HOUR).toISOString(),
			}),
		);
		const body = (await res.json()) as ApiKeyUsageResponse;
		expect(res.status).toBe(200);
		expect(body.requests).toBe(1);
		expect(body.planValueUsd).toBe(10);
		expect(body.totalCostUsd).toBe(10);
		expect(body.planCost.accounts[0].share).toBe(0.5);
		expect(body.series.reduce((sum, point) => sum + point.requests, 0)).toBe(1);
	});

	it("normalizes an unknown range to 24h", async () => {
		await seedKey("key-1", "alpha");
		const { body } = await usage("key-1", "bogus");
		expect(body.range).toBe("24h");
		expect(body.bucketMs).toBe(HOUR);
	});
});
