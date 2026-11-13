import { describe, expect, it } from "bun:test";
import { filterModelPrices, priceSummary } from "../model-prices";

const models = [
	{
		id: "claude-opus-4",
		name: "Opus 4",
		provider: "anthropic",
		family: "opus",
		rates: { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 },
	},
	{
		id: "claude-opus-4-6",
		name: "Opus 4.6",
		provider: "anthropic",
		family: "opus",
		rates: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
	},
	{
		id: "mystery",
		name: "Mystery Model",
		provider: "unknown",
		family: "unknown",
		rates: null,
	},
];

describe("shared model price presentation", () => {
	it("shows all four USD rates, distinguishing family ranges and absent prices", () => {
		expect(priceSummary(models, "claude-opus-4-6")).toBe(
			"$5 in / $25 out / $0.5 cache-read / $6.25 cache-write per 1M tokens (USD)",
		);
		expect(priceSummary(models, "opus")).toBe(
			"$5–15 in / $25–75 out / $0.5–1.5 cache-read / $6.25–18.75 cache-write per 1M tokens (USD; varies by model)",
		);
		expect(priceSummary(models, "mystery")).toBe("No price available");
		expect(
			priceSummary(
				[
					{
						...models[0],
						rates: { input: 0, output: 0, cacheRead: null, cacheWrite: null },
					},
				],
				"claude-opus-4",
			),
		).toContain("$0 in / $0 out / unknown cache-read / unknown cache-write");
	});
	it("searches model names, ids, families and providers", () => {
		expect(filterModelPrices(models, "OPUS")).toHaveLength(2);
		expect(filterModelPrices(models, "anthropic")).toHaveLength(2);
		expect(filterModelPrices(models, "Mystery Model")).toHaveLength(1);
		expect(filterModelPrices(models, "nothing")).toHaveLength(0);
	});
});
