import { describe, expect, test } from "bun:test";
import type { ModelRates } from "@better-ccflare/core";
import {
	buildCacheInsightsResponse,
	type CacheInsightsResponse,
	computeCacheCosts,
	computeCacheHitRate,
	type GroupedTokenRow,
	type TokenSums,
} from "../cache-insights";

/**
 * Tests for the pure cache-savings math service.
 *
 * Rates are $ per 1M tokens. Reference rates loosely modeled on Claude Sonnet:
 * input 3, output 15, cacheRead 0.3, cacheWrite 3.75.
 */

const SONNET_RATES: ModelRates = {
	input: 3,
	output: 15,
	cacheRead: 0.3,
	cacheWrite: 3.75,
};

function sums(partial: Partial<TokenSums> = {}): TokenSums {
	return {
		requests: 0,
		uncachedInputTokens: 0,
		cacheReadInputTokens: 0,
		cacheCreationInputTokens: 0,
		...partial,
	};
}

function row(
	dimensionKey: string | null,
	model: string | null,
	partial: Partial<TokenSums> = {},
): GroupedTokenRow {
	return { dimensionKey, model, ...sums(partial) };
}

function build(
	accountModelRows: GroupedTokenRow[],
	rates: Map<string, ModelRates | null>,
	overrides: {
		projectModelRows?: GroupedTokenRow[];
		range?: string;
		thresholdPercent?: number;
		minRequestsForFlag?: number;
	} = {},
): CacheInsightsResponse {
	return buildCacheInsightsResponse({
		accountModelRows,
		projectModelRows: overrides.projectModelRows ?? [],
		rates,
		options: {
			range: overrides.range ?? "7d",
			thresholdPercent: overrides.thresholdPercent,
			minRequestsForFlag: overrides.minRequestsForFlag,
		},
	});
}

describe("computeCacheHitRate", () => {
	test("returns 0 when the denominator is zero", () => {
		expect(computeCacheHitRate(sums())).toBe(0);
	});

	test("returns 100 for pure cache-read traffic", () => {
		expect(computeCacheHitRate(sums({ cacheReadInputTokens: 5_000 }))).toBe(
			100,
		);
	});

	test("matches the analytics.ts definition", () => {
		// cache_read * 100 / (input + cache_read + cache_creation)
		const rate = computeCacheHitRate(
			sums({
				uncachedInputTokens: 1_000_000,
				cacheReadInputTokens: 10_000_000,
				cacheCreationInputTokens: 2_000_000,
			}),
		);
		expect(rate).toBeCloseTo((10_000_000 * 100) / 13_000_000, 10);
	});
});

describe("computeCacheCosts", () => {
	test("computes exact dollars including negative cache_creation contribution", () => {
		const result = computeCacheCosts(
			sums({
				uncachedInputTokens: 1_000_000,
				cacheReadInputTokens: 10_000_000,
				cacheCreationInputTokens: 2_000_000,
			}),
			SONNET_RATES,
		);
		expect(result).not.toBeNull();
		// actual = 10M * 0.3/1M + 2M * 3.75/1M = 3 + 7.5 = 10.5
		expect(result?.actualCacheCostUsd).toBeCloseTo(10.5, 10);
		// counterfactual = 12M * 3/1M = 36
		expect(result?.counterfactualCostUsd).toBeCloseTo(36, 10);
		// savings = 36 - 10.5 = 25.5
		expect(result?.savingsUsd).toBeCloseTo(25.5, 10);
	});

	test("cache_creation dominating produces net negative savings", () => {
		const result = computeCacheCosts(
			sums({ cacheCreationInputTokens: 1_000_000 }),
			SONNET_RATES,
		);
		// actual = 3.75, counterfactual = 3, savings = -0.75
		expect(result?.actualCacheCostUsd).toBeCloseTo(3.75, 10);
		expect(result?.counterfactualCostUsd).toBeCloseTo(3, 10);
		expect(result?.savingsUsd).toBeCloseTo(-0.75, 10);
	});

	test("returns null for null rates (unknown model)", () => {
		expect(
			computeCacheCosts(sums({ cacheReadInputTokens: 100 }), null),
		).toBeNull();
	});

	test("returns null when cacheWrite rate is null and cache_creation tokens > 0", () => {
		const rates: ModelRates = { ...SONNET_RATES, cacheWrite: null };
		expect(
			computeCacheCosts(
				sums({ cacheReadInputTokens: 100, cacheCreationInputTokens: 50 }),
				rates,
			),
		).toBeNull();
	});

	test("null cacheWrite rate is irrelevant when cache_creation tokens are zero", () => {
		const rates: ModelRates = { ...SONNET_RATES, cacheWrite: null };
		const result = computeCacheCosts(
			sums({ cacheReadInputTokens: 1_000_000 }),
			rates,
		);
		expect(result).not.toBeNull();
		expect(result?.actualCacheCostUsd).toBeCloseTo(0.3, 10);
		expect(result?.counterfactualCostUsd).toBeCloseTo(3, 10);
		expect(result?.savingsUsd).toBeCloseTo(2.7, 10);
	});

	test("returns null when cacheRead rate is null and cache_read tokens > 0", () => {
		const rates: ModelRates = { ...SONNET_RATES, cacheRead: null };
		expect(
			computeCacheCosts(sums({ cacheReadInputTokens: 100 }), rates),
		).toBeNull();
	});
});

describe("buildCacheInsightsResponse", () => {
	test("single account/model row: exact math, meta echo, totals", () => {
		const rates = new Map<string, ModelRates | null>([
			["claude-sonnet", SONNET_RATES],
		]);
		const response = build(
			[
				row("acc1", "claude-sonnet", {
					requests: 100,
					uncachedInputTokens: 1_000_000,
					cacheReadInputTokens: 10_000_000,
					cacheCreationInputTokens: 2_000_000,
				}),
			],
			rates,
			{ range: "30d" },
		);

		expect(response.meta).toEqual({
			range: "30d",
			thresholdPercent: 50,
			minRequestsForFlag: 10,
		});

		expect(response.byAccount).toHaveLength(1);
		const account = response.byAccount[0];
		expect(account.key).toBe("acc1");
		expect(account.requests).toBe(100);
		expect(account.pricingKnown).toBe(true);
		expect(account.actualCacheCostUsd).toBeCloseTo(10.5, 10);
		expect(account.counterfactualCostUsd).toBeCloseTo(36, 10);
		expect(account.savingsUsd).toBeCloseTo(25.5, 10);
		expect(account.cacheHitRate).toBeCloseTo(
			(10_000_000 * 100) / 13_000_000,
			10,
		);
		// hit rate ~76.9% >= 50 threshold
		expect(account.flagged).toBe(false);

		expect(response.byModel).toHaveLength(1);
		expect(response.byModel[0].key).toBe("claude-sonnet");
		expect(response.byModel[0].savingsUsd).toBeCloseTo(25.5, 10);

		expect(response.totals.requests).toBe(100);
		expect(response.totals.uncachedInputTokens).toBe(1_000_000);
		expect(response.totals.cacheReadInputTokens).toBe(10_000_000);
		expect(response.totals.cacheCreationInputTokens).toBe(2_000_000);
		expect(response.totals.actualCacheCostUsd).toBeCloseTo(10.5, 10);
		expect(response.totals.counterfactualCostUsd).toBeCloseTo(36, 10);
		expect(response.totals.savingsUsd).toBeCloseTo(25.5, 10);
		expect(response.totals.cacheHitRate).toBeCloseTo(
			(10_000_000 * 100) / 13_000_000,
			10,
		);
		expect(response.totals.unknownPricingModels).toEqual([]);
		expect(response.byProject).toEqual([]);
	});

	test("cache_creation-dominated model yields net negative savingsUsd", () => {
		const rates = new Map<string, ModelRates | null>([
			["claude-sonnet", SONNET_RATES],
		]);
		const response = build(
			[
				row("acc1", "claude-sonnet", {
					requests: 5,
					uncachedInputTokens: 100,
					cacheCreationInputTokens: 1_000_000,
				}),
			],
			rates,
		);
		expect(response.byModel[0].savingsUsd).toBeCloseTo(-0.75, 10);
		expect(response.totals.savingsUsd).toBeCloseTo(-0.75, 10);
	});

	test("unknown model: null costs, pricingKnown=false, listed in unknownPricingModels, token totals still counted", () => {
		const rates = new Map<string, ModelRates | null>([
			["claude-sonnet", SONNET_RATES],
			["mystery-model", null],
		]);
		const response = build(
			[
				row("acc1", "claude-sonnet", {
					requests: 20,
					uncachedInputTokens: 1_000_000,
					cacheReadInputTokens: 10_000_000,
					cacheCreationInputTokens: 2_000_000,
				}),
				row("acc1", "mystery-model", {
					requests: 7,
					uncachedInputTokens: 500,
					cacheReadInputTokens: 1_500,
					cacheCreationInputTokens: 250,
				}),
			],
			rates,
		);

		const mystery = response.byModel.find((r) => r.key === "mystery-model");
		expect(mystery).toBeDefined();
		expect(mystery?.pricingKnown).toBe(false);
		expect(mystery?.actualCacheCostUsd).toBeNull();
		expect(mystery?.counterfactualCostUsd).toBeNull();
		expect(mystery?.savingsUsd).toBeNull();

		// account row aggregates a known and an unknown model -> pricingKnown=false, costs null
		expect(response.byAccount).toHaveLength(1);
		expect(response.byAccount[0].pricingKnown).toBe(false);
		expect(response.byAccount[0].savingsUsd).toBeNull();

		// token totals include the unknown model
		expect(response.totals.requests).toBe(27);
		expect(response.totals.uncachedInputTokens).toBe(1_000_500);
		expect(response.totals.cacheReadInputTokens).toBe(10_001_500);
		expect(response.totals.cacheCreationInputTokens).toBe(2_000_250);

		// cost totals cover only the pricing-known volume
		expect(response.totals.actualCacheCostUsd).toBeCloseTo(10.5, 10);
		expect(response.totals.counterfactualCostUsd).toBeCloseTo(36, 10);
		expect(response.totals.savingsUsd).toBeCloseTo(25.5, 10);

		expect(response.totals.unknownPricingModels).toEqual(["mystery-model"]);
	});

	test("model missing from the rates map is treated as unknown", () => {
		const response = build(
			[row("acc1", "not-in-map", { requests: 1, cacheReadInputTokens: 100 })],
			new Map(),
		);
		expect(response.byModel[0].pricingKnown).toBe(false);
		expect(response.totals.unknownPricingModels).toEqual(["not-in-map"]);
	});

	test("null cacheWrite rate with cache_creation tokens > 0 -> pricingKnown=false", () => {
		const rates = new Map<string, ModelRates | null>([
			["no-write-rate", { ...SONNET_RATES, cacheWrite: null }],
		]);
		const response = build(
			[
				row("acc1", "no-write-rate", {
					requests: 3,
					cacheReadInputTokens: 1_000,
					cacheCreationInputTokens: 1,
				}),
			],
			rates,
		);
		expect(response.byModel[0].pricingKnown).toBe(false);
		expect(response.byModel[0].savingsUsd).toBeNull();
		expect(response.totals.unknownPricingModels).toEqual(["no-write-rate"]);
	});

	test("null cacheWrite rate with zero cache_creation tokens -> pricingKnown=true", () => {
		const rates = new Map<string, ModelRates | null>([
			["no-write-rate", { ...SONNET_RATES, cacheWrite: null }],
		]);
		const response = build(
			[
				row("acc1", "no-write-rate", {
					requests: 3,
					cacheReadInputTokens: 1_000_000,
				}),
			],
			rates,
		);
		expect(response.byModel[0].pricingKnown).toBe(true);
		expect(response.byModel[0].savingsUsd).toBeCloseTo(2.7, 10);
		expect(response.totals.unknownPricingModels).toEqual([]);
	});

	test("hit-rate edge cases: zero denominator -> 0, pure cache-read -> 100", () => {
		const rates = new Map<string, ModelRates | null>([
			["claude-sonnet", SONNET_RATES],
		]);
		const response = build(
			[
				row("acc-zero", "claude-sonnet", { requests: 2 }),
				row("acc-pure", "claude-sonnet", {
					requests: 2,
					cacheReadInputTokens: 1_000,
				}),
			],
			rates,
		);
		const zero = response.byAccount.find((r) => r.key === "acc-zero");
		const pure = response.byAccount.find((r) => r.key === "acc-pure");
		expect(zero?.cacheHitRate).toBe(0);
		expect(pure?.cacheHitRate).toBe(100);
	});

	test("flagging: below threshold with enough requests -> flagged; too few requests or above threshold -> not flagged", () => {
		const rates = new Map<string, ModelRates | null>([
			["claude-sonnet", SONNET_RATES],
		]);
		const response = build(
			[
				// 25% hit rate, 10 requests -> flagged (>= minRequests default 10)
				row("acc-low-many", "claude-sonnet", {
					requests: 10,
					uncachedInputTokens: 750,
					cacheReadInputTokens: 250,
				}),
				// 25% hit rate, 9 requests -> not flagged
				row("acc-low-few", "claude-sonnet", {
					requests: 9,
					uncachedInputTokens: 750,
					cacheReadInputTokens: 250,
				}),
				// 75% hit rate, 100 requests -> not flagged
				row("acc-high", "claude-sonnet", {
					requests: 100,
					uncachedInputTokens: 250,
					cacheReadInputTokens: 750,
				}),
			],
			rates,
		);
		const byKey = new Map(response.byAccount.map((r) => [r.key, r]));
		expect(byKey.get("acc-low-many")?.flagged).toBe(true);
		expect(byKey.get("acc-low-few")?.flagged).toBe(false);
		expect(byKey.get("acc-high")?.flagged).toBe(false);
	});

	test("flagging respects custom thresholdPercent and minRequestsForFlag", () => {
		const rates = new Map<string, ModelRates | null>([
			["claude-sonnet", SONNET_RATES],
		]);
		const response = build(
			[
				// 75% hit rate, 3 requests
				row("acc1", "claude-sonnet", {
					requests: 3,
					uncachedInputTokens: 250,
					cacheReadInputTokens: 750,
				}),
			],
			rates,
			{ thresholdPercent: 80, minRequestsForFlag: 2 },
		);
		expect(response.meta.thresholdPercent).toBe(80);
		expect(response.meta.minRequestsForFlag).toBe(2);
		expect(response.byAccount[0].flagged).toBe(true);
	});

	test("byModel aggregates the same model across accounts", () => {
		const rates = new Map<string, ModelRates | null>([
			["claude-sonnet", SONNET_RATES],
		]);
		const response = build(
			[
				row("acc1", "claude-sonnet", {
					requests: 10,
					uncachedInputTokens: 1_000_000,
					cacheReadInputTokens: 4_000_000,
					cacheCreationInputTokens: 1_000_000,
				}),
				row("acc2", "claude-sonnet", {
					requests: 5,
					uncachedInputTokens: 500_000,
					cacheReadInputTokens: 6_000_000,
					cacheCreationInputTokens: 1_000_000,
				}),
			],
			rates,
		);
		expect(response.byAccount).toHaveLength(2);
		expect(response.byModel).toHaveLength(1);
		const model = response.byModel[0];
		expect(model.key).toBe("claude-sonnet");
		expect(model.requests).toBe(15);
		expect(model.uncachedInputTokens).toBe(1_500_000);
		expect(model.cacheReadInputTokens).toBe(10_000_000);
		expect(model.cacheCreationInputTokens).toBe(2_000_000);
		// actual = 10M*0.3/1M + 2M*3.75/1M = 3 + 7.5 = 10.5
		expect(model.actualCacheCostUsd).toBeCloseTo(10.5, 10);
		// counterfactual = 12M*3/1M = 36
		expect(model.counterfactualCostUsd).toBeCloseTo(36, 10);
		expect(model.savingsUsd).toBeCloseTo(25.5, 10);
		expect(model.pricingKnown).toBe(true);
	});

	test("byProject aggregates project rows with Unknown key for null project", () => {
		const rates = new Map<string, ModelRates | null>([
			["claude-sonnet", SONNET_RATES],
		]);
		const response = build(
			[
				row("acc1", "claude-sonnet", {
					requests: 4,
					cacheReadInputTokens: 1_000_000,
				}),
			],
			rates,
			{
				projectModelRows: [
					row("proj-a", "claude-sonnet", {
						requests: 3,
						cacheReadInputTokens: 750_000,
					}),
					row(null, "claude-sonnet", {
						requests: 1,
						cacheReadInputTokens: 250_000,
					}),
				],
			},
		);
		expect(response.byProject).toHaveLength(2);
		const keys = response.byProject.map((r) => r.key).sort();
		expect(keys).toEqual(["Unknown", "proj-a"]);
		const unknown = response.byProject.find((r) => r.key === "Unknown");
		// project key is unknown, but the model pricing is known
		expect(unknown?.pricingKnown).toBe(true);
		expect(unknown?.savingsUsd).toBeCloseTo((250_000 * (3 - 0.3)) / 1e6, 10);
	});

	test("null/empty model id maps to model key Unknown with pricingKnown=false", () => {
		const rates = new Map<string, ModelRates | null>([
			["claude-sonnet", SONNET_RATES],
		]);
		const response = build(
			[
				row("acc1", null, { requests: 2, cacheReadInputTokens: 100 }),
				row("acc1", "", { requests: 3, cacheReadInputTokens: 200 }),
				row("acc1", "claude-sonnet", {
					requests: 1,
					cacheReadInputTokens: 1_000,
				}),
			],
			rates,
		);
		const unknown = response.byModel.find((r) => r.key === "Unknown");
		expect(unknown).toBeDefined();
		// null and empty model ids merge into one Unknown row
		expect(unknown?.requests).toBe(5);
		expect(unknown?.cacheReadInputTokens).toBe(300);
		expect(unknown?.pricingKnown).toBe(false);
		expect(unknown?.savingsUsd).toBeNull();
		expect(response.totals.unknownPricingModels).toEqual(["Unknown"]);
	});

	test("rows sort by savingsUsd descending with nulls last, tie-break by key", () => {
		const rates = new Map<string, ModelRates | null>([
			["big-saver", SONNET_RATES],
			["small-saver", SONNET_RATES],
			["unknown-b", null],
			["unknown-a", null],
			["tie-b", SONNET_RATES],
			["tie-a", SONNET_RATES],
		]);
		const response = build(
			[
				row("acc1", "small-saver", {
					requests: 1,
					cacheReadInputTokens: 1_000_000,
				}),
				row("acc1", "big-saver", {
					requests: 1,
					cacheReadInputTokens: 10_000_000,
				}),
				row("acc1", "unknown-b", { requests: 1, cacheReadInputTokens: 1 }),
				row("acc1", "unknown-a", { requests: 1, cacheReadInputTokens: 1 }),
				row("acc1", "tie-b", { requests: 1, cacheReadInputTokens: 500_000 }),
				row("acc1", "tie-a", { requests: 1, cacheReadInputTokens: 500_000 }),
			],
			rates,
		);
		expect(response.byModel.map((r) => r.key)).toEqual([
			"big-saver",
			"small-saver",
			"tie-a",
			"tie-b",
			"unknown-a",
			"unknown-b",
		]);
		// unknownPricingModels is sorted
		expect(response.totals.unknownPricingModels).toEqual([
			"unknown-a",
			"unknown-b",
		]);
	});

	test("empty input produces zeroed totals and empty lists", () => {
		const response = build([], new Map());
		expect(response.byModel).toEqual([]);
		expect(response.byAccount).toEqual([]);
		expect(response.byProject).toEqual([]);
		expect(response.totals).toEqual({
			requests: 0,
			uncachedInputTokens: 0,
			cacheReadInputTokens: 0,
			cacheCreationInputTokens: 0,
			cacheHitRate: 0,
			actualCacheCostUsd: 0,
			counterfactualCostUsd: 0,
			savingsUsd: 0,
			unknownPricingModels: [],
		});
	});
});
