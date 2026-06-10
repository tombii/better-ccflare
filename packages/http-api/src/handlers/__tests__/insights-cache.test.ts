import { Database } from "bun:sqlite";
import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
} from "bun:test";
import { resetNanoGPTPricingCacheForTest } from "@better-ccflare/core";
import {
	BunSqlAdapter,
	ensureSchema,
	runMigrations,
} from "@better-ccflare/database";
import type { APIContext } from "../../types";
import { createCacheInsightsHandler } from "../insights";

// Bundled pricing for claude-sonnet-4-20250514 ($ per 1M tokens)
const SONNET = "claude-sonnet-4-20250514";
const SONNET_INPUT = 3;
const SONNET_CACHE_READ = 0.3;
const SONNET_CACHE_WRITE = 3.75;
const MILLION = 1_000_000;

// ---------------------------------------------------------------------------
// Pricing isolation: force bundled pricing only (no models.dev / NanoGPT
// network fetches) for every test in this file.
// ---------------------------------------------------------------------------

let originalOffline: string | undefined;
let originalFetch: typeof globalThis.fetch;

beforeAll(() => {
	resetNanoGPTPricingCacheForTest();
	originalOffline = process.env.CF_PRICING_OFFLINE;
	process.env.CF_PRICING_OFFLINE = "1";
	originalFetch = globalThis.fetch;
	globalThis.fetch = (() =>
		Promise.reject(new Error("offline"))) as unknown as typeof fetch;
});

afterAll(() => {
	if (originalOffline === undefined) {
		delete process.env.CF_PRICING_OFFLINE;
	} else {
		process.env.CF_PRICING_OFFLINE = originalOffline;
	}
	globalThis.fetch = originalFetch;
	resetNanoGPTPricingCacheForTest();
});

// ---------------------------------------------------------------------------
// Mock-adapter tests
// ---------------------------------------------------------------------------

type SqlRow = {
	dimension_key: string | null;
	model: string | null;
	requests: number;
	uncached_input_tokens: number;
	cache_read_input_tokens: number;
	cache_creation_input_tokens: number;
};

function createMockContext(
	accountRows: SqlRow[],
	projectRows: SqlRow[],
): APIContext {
	const mockDb = {
		// First query (account x model) carries the accounts LEFT JOIN;
		// second query (project x model) does not.
		query: async (sql: string) =>
			sql.includes("LEFT JOIN accounts") ? accountRows : projectRows,
	};

	return {
		db: {} as APIContext["db"],
		config: {} as APIContext["config"],
		dbOps: {
			getAdapter: () => mockDb,
		} as unknown as APIContext["dbOps"],
	};
}

const sonnetAccountRow: SqlRow = {
	dimension_key: "acct-A",
	model: SONNET,
	requests: 12,
	uncached_input_tokens: 1_000_000,
	cache_read_input_tokens: 2_000_000,
	cache_creation_input_tokens: 400_000,
};

const sonnetProjectRow: SqlRow = { ...sonnetAccountRow, dimension_key: "proj" };

describe("cache insights handler (mock adapter)", () => {
	it("returns meta/totals/byModel/byAccount/byProject with defaults surfaced in meta", async () => {
		const context = createMockContext([sonnetAccountRow], [sonnetProjectRow]);
		const response = await createCacheInsightsHandler(context)(
			new URLSearchParams(),
		);
		expect(response.status).toBe(200);
		const data = await response.json();

		expect(data.meta).toEqual({
			range: "24h",
			thresholdPercent: 50,
			minRequestsForFlag: 10,
		});
		expect(Array.isArray(data.byModel)).toBe(true);
		expect(Array.isArray(data.byAccount)).toBe(true);
		expect(Array.isArray(data.byProject)).toBe(true);

		// Hand-computed dollars for the sonnet volume:
		// actual = 2M * 0.3/1M + 0.4M * 3.75/1M = 0.6 + 1.5 = 2.1
		// counterfactual = 2.4M * 3/1M = 7.2 ; savings = 5.1
		expect(data.totals.requests).toBe(12);
		expect(data.totals.actualCacheCostUsd).toBeCloseTo(2.1, 10);
		expect(data.totals.counterfactualCostUsd).toBeCloseTo(7.2, 10);
		expect(data.totals.savingsUsd).toBeCloseTo(5.1, 10);
		expect(data.totals.unknownPricingModels).toEqual([]);

		expect(data.byAccount[0].key).toBe("acct-A");
		expect(data.byAccount[0].pricingKnown).toBe(true);
		expect(data.byAccount[0].savingsUsd).toBeCloseTo(5.1, 10);
		expect(data.byModel[0].key).toBe(SONNET);
		expect(data.byProject[0].key).toBe("proj");
	});

	it("echoes the range param in meta", async () => {
		const context = createMockContext([sonnetAccountRow], [sonnetProjectRow]);
		const response = await createCacheInsightsHandler(context)(
			new URLSearchParams("range=7d"),
		);
		const data = await response.json();
		expect(data.meta.range).toBe("7d");
	});

	it("reports the effective range in meta when the range param is unknown", async () => {
		const context = createMockContext([sonnetAccountRow], [sonnetProjectRow]);
		const response = await createCacheInsightsHandler(context)(
			new URLSearchParams("range=bogus"),
		);
		const data = await response.json();
		// "bogus" falls back to the 24h window, and meta must reflect that.
		expect(data.meta.range).toBe("24h");
	});

	it("respects the threshold param and applies it to flagging", async () => {
		const context = createMockContext([sonnetAccountRow], [sonnetProjectRow]);

		// Row hit rate = 2M * 100 / 3.4M ~ 58.8% with 12 requests (>= 10).
		const lowThreshold = await (
			await createCacheInsightsHandler(context)(
				new URLSearchParams("threshold=30"),
			)
		).json();
		expect(lowThreshold.meta.thresholdPercent).toBe(30);
		expect(lowThreshold.byAccount[0].flagged).toBe(false);

		const highThreshold = await (
			await createCacheInsightsHandler(context)(
				new URLSearchParams("threshold=80"),
			)
		).json();
		expect(highThreshold.meta.thresholdPercent).toBe(80);
		expect(highThreshold.byAccount[0].flagged).toBe(true);
	});

	it("clamps the threshold param to 0-100", async () => {
		const context = createMockContext([sonnetAccountRow], [sonnetProjectRow]);

		const over = await (
			await createCacheInsightsHandler(context)(
				new URLSearchParams("threshold=150"),
			)
		).json();
		expect(over.meta.thresholdPercent).toBe(100);

		const under = await (
			await createCacheInsightsHandler(context)(
				new URLSearchParams("threshold=-20"),
			)
		).json();
		expect(under.meta.thresholdPercent).toBe(0);
	});

	it("falls back to the default threshold for non-numeric input", async () => {
		const context = createMockContext([sonnetAccountRow], [sonnetProjectRow]);
		const data = await (
			await createCacheInsightsHandler(context)(
				new URLSearchParams("threshold=abc"),
			)
		).json();
		expect(data.meta.thresholdPercent).toBe(50);
	});

	it("reports unknown models with null costs and lists them in totals", async () => {
		const unknownRow: SqlRow = {
			dimension_key: "acct-A",
			model: "totally-unknown-model-xyz",
			requests: 3,
			uncached_input_tokens: 100,
			cache_read_input_tokens: 50,
			cache_creation_input_tokens: 0,
		};
		const context = createMockContext(
			[unknownRow],
			[{ ...unknownRow, dimension_key: null }],
		);
		const data = await (
			await createCacheInsightsHandler(context)(new URLSearchParams())
		).json();

		expect(data.byModel[0].key).toBe("totally-unknown-model-xyz");
		expect(data.byModel[0].pricingKnown).toBe(false);
		expect(data.byModel[0].actualCacheCostUsd).toBeNull();
		expect(data.byModel[0].counterfactualCostUsd).toBeNull();
		expect(data.byModel[0].savingsUsd).toBeNull();
		expect(data.totals.unknownPricingModels).toEqual([
			"totally-unknown-model-xyz",
		]);
		// A null dimension key is reported under "Unknown"
		expect(data.byProject[0].key).toBe("Unknown");
	});

	it("returns a 500 error response when the query fails", async () => {
		const context = {
			db: {} as APIContext["db"],
			config: {} as APIContext["config"],
			dbOps: {
				getAdapter: () => ({
					query: async () => {
						throw new Error("boom");
					},
				}),
			} as unknown as APIContext["dbOps"],
		};
		const response = await createCacheInsightsHandler(context)(
			new URLSearchParams(),
		);
		expect(response.status).toBe(500);
	});
});

// ---------------------------------------------------------------------------
// Integration test: real in-memory SQLite
// ---------------------------------------------------------------------------

describe("cache insights handler (SQLite integration)", () => {
	let db: Database;
	let context: APIContext;

	function insertRequest(opts: {
		id: string;
		timestamp: number;
		accountUsed: string | null;
		model: string | null;
		inputTokens: number;
		cacheReadTokens: number;
		cacheCreationTokens: number;
		project: string | null;
	}): void {
		db.run(
			`INSERT INTO requests
				(id, timestamp, method, path, account_used, status_code, success,
				 response_time_ms, failover_attempts, model, input_tokens,
				 cache_read_input_tokens, cache_creation_input_tokens, project)
			 VALUES (?, ?, 'POST', '/v1/messages', ?, 200, 1, 100, 0, ?, ?, ?, ?, ?)`,
			[
				opts.id,
				opts.timestamp,
				opts.accountUsed,
				opts.model,
				opts.inputTokens,
				opts.cacheReadTokens,
				opts.cacheCreationTokens,
				opts.project,
			],
		);
	}

	beforeEach(() => {
		db = new Database(":memory:");
		ensureSchema(db);
		runMigrations(db);

		db.run(
			"INSERT INTO accounts (id, name, created_at) VALUES ('a1', 'acct-A', ?)",
			[Date.now()],
		);

		const now = Date.now();
		// r1: sonnet, project proj-x
		insertRequest({
			id: "r1",
			timestamp: now - 1000,
			accountUsed: "a1",
			model: SONNET,
			inputTokens: 1_000_000,
			cacheReadTokens: 2_000_000,
			cacheCreationTokens: 400_000,
			project: "proj-x",
		});
		// r2: sonnet, NULL project
		insertRequest({
			id: "r2",
			timestamp: now - 1000,
			accountUsed: "a1",
			model: SONNET,
			inputTokens: 500_000,
			cacheReadTokens: 0,
			cacheCreationTokens: 0,
			project: null,
		});
		// r3: NULL model, NULL account, NULL project -> "Unknown" everywhere
		insertRequest({
			id: "r3",
			timestamp: now - 1000,
			accountUsed: null,
			model: null,
			inputTokens: 100,
			cacheReadTokens: 50,
			cacheCreationTokens: 0,
			project: null,
		});
		// r4: outside the default 24h range -> must be excluded
		insertRequest({
			id: "r4",
			timestamp: now - 2 * 24 * 60 * 60 * 1000,
			accountUsed: "a1",
			model: SONNET,
			inputTokens: 999_999,
			cacheReadTokens: 999_999,
			cacheCreationTokens: 999_999,
			project: "proj-x",
		});

		const adapter = new BunSqlAdapter(db);
		context = {
			db: adapter,
			config: {} as APIContext["config"],
			dbOps: {
				getAdapter: () => adapter,
			} as unknown as APIContext["dbOps"],
		};
	});

	afterEach(() => {
		db.close();
	});

	it("computes exact hand-computed savings, hit rates and Unknown handling", async () => {
		const response = await createCacheInsightsHandler(context)(
			new URLSearchParams(),
		);
		expect(response.status).toBe(200);
		const data = await response.json();

		// Hand-computed for the sonnet volume of r1+r2:
		// uncached 1.5M, cacheRead 2M, cacheCreation 0.4M
		const sonnetActual =
			(2_000_000 * SONNET_CACHE_READ) / MILLION +
			(400_000 * SONNET_CACHE_WRITE) / MILLION; // 0.6 + 1.5 = 2.1
		const sonnetCounterfactual = (2_400_000 * SONNET_INPUT) / MILLION; // 7.2
		const sonnetSavings = sonnetCounterfactual - sonnetActual; // 5.1

		// --- totals (r1+r2+r3; r4 excluded by the 24h window) ---
		expect(data.totals.requests).toBe(3);
		expect(data.totals.uncachedInputTokens).toBe(1_500_100);
		expect(data.totals.cacheReadInputTokens).toBe(2_000_050);
		expect(data.totals.cacheCreationInputTokens).toBe(400_000);
		expect(data.totals.cacheHitRate).toBeCloseTo(
			(2_000_050 * 100) / 3_900_150,
			10,
		);
		expect(data.totals.actualCacheCostUsd).toBeCloseTo(sonnetActual, 10);
		expect(data.totals.counterfactualCostUsd).toBeCloseTo(
			sonnetCounterfactual,
			10,
		);
		expect(data.totals.savingsUsd).toBeCloseTo(sonnetSavings, 10);
		expect(data.totals.unknownPricingModels).toEqual(["Unknown"]);

		// --- byModel: sonnet first (savings desc), Unknown (null costs) last ---
		expect(data.byModel.map((r: { key: string }) => r.key)).toEqual([
			SONNET,
			"Unknown",
		]);
		const modelRow = data.byModel[0];
		expect(modelRow.requests).toBe(2);
		expect(modelRow.cacheHitRate).toBeCloseTo(
			(2_000_000 * 100) / 3_900_000,
			10,
		);
		expect(modelRow.actualCacheCostUsd).toBeCloseTo(sonnetActual, 10);
		expect(modelRow.counterfactualCostUsd).toBeCloseTo(
			sonnetCounterfactual,
			10,
		);
		expect(modelRow.savingsUsd).toBeCloseTo(sonnetSavings, 10);
		expect(modelRow.pricingKnown).toBe(true);
		expect(data.byModel[1].pricingKnown).toBe(false);
		expect(data.byModel[1].savingsUsd).toBeNull();

		// --- byAccount: acct-A (priced), Unknown (r3, unpriced) ---
		expect(data.byAccount.map((r: { key: string }) => r.key)).toEqual([
			"acct-A",
			"Unknown",
		]);
		expect(data.byAccount[0].requests).toBe(2);
		expect(data.byAccount[0].savingsUsd).toBeCloseTo(sonnetSavings, 10);
		expect(data.byAccount[1].requests).toBe(1);
		expect(data.byAccount[1].savingsUsd).toBeNull();

		// --- byProject: proj-x (r1), Unknown (r2 + r3 -> unpriced due to r3) ---
		expect(data.byProject.map((r: { key: string }) => r.key)).toEqual([
			"proj-x",
			"Unknown",
		]);
		const projRow = data.byProject[0];
		expect(projRow.requests).toBe(1);
		expect(projRow.uncachedInputTokens).toBe(1_000_000);
		expect(projRow.cacheHitRate).toBeCloseTo((2_000_000 * 100) / 3_400_000, 10);
		expect(projRow.savingsUsd).toBeCloseTo(sonnetSavings, 10);
		const unknownProj = data.byProject[1];
		expect(unknownProj.requests).toBe(2);
		expect(unknownProj.pricingKnown).toBe(false);
		expect(unknownProj.savingsUsd).toBeNull();
	});

	it("applies the shared account filter", async () => {
		const response = await createCacheInsightsHandler(context)(
			new URLSearchParams("accounts=acct-A"),
		);
		const data = await response.json();

		// r3 (NULL account) is excluded by the filter
		expect(data.totals.requests).toBe(2);
		expect(data.byAccount).toHaveLength(1);
		expect(data.byAccount[0].key).toBe("acct-A");
		expect(data.totals.unknownPricingModels).toEqual([]);
	});
});
