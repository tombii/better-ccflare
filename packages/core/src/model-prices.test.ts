import { afterEach, describe, expect, it, spyOn } from "bun:test";
import {
	estimateCostUSD,
	getModelRates,
	listModelPrices,
	resetNanoGPTPricingCacheForTest,
} from "./pricing";

afterEach(() => resetNanoGPTPricingCacheForTest());

describe("model prices catalogue", () => {
	it("lists the same winning rates used for costs, preserving unknown and zero prices", async () => {
		resetNanoGPTPricingCacheForTest();
		const fetch = spyOn(globalThis, "fetch").mockImplementation(
			async (input) =>
				new Response(
					JSON.stringify(
						String(input).includes("models.dev")
							? {
									anthropic: {
										models: {
											"test-opus": {
												id: "test-opus",
												name: "Test Opus",
												cost: {
													input: 2,
													output: 8,
													cache_read: 0,
													cache_write: 3,
												},
											},
											unpriced: { id: "unpriced", name: "Unpriced" },
											malformed: {
												id: "malformed",
												cost: { input: "2", output: 8 },
											},
											"input-only": { cost: { input: 2 } },
											"output-only": { cost: { output: 8 } },
											"cache-only": {
												cost: { cache_read: 0.25, cache_write: 0.5 },
											},
											"empty-cost": { cost: {} },
										},
									},
									other: {
										models: {
											"test-opus": {
												id: "test-opus",
												cost: { input: 99, output: 99 },
											},
										},
									},
								}
							: { data: [] },
					),
				),
		);
		const offline = process.env.CF_PRICING_OFFLINE;
		delete process.env.CF_PRICING_OFFLINE;
		try {
			const prices = await listModelPrices();
			expect(prices.filter((model) => model.id === "test-opus")).toHaveLength(
				1,
			);
			expect(prices.find((model) => model.id === "test-opus")).toMatchObject({
				provider: "anthropic",
				family: "opus",
				rates: { input: 2, output: 8, cacheRead: 0, cacheWrite: 3 },
			});
			expect(prices.find((model) => model.id === "unpriced")?.rates).toBeNull();
			expect(
				prices.find((model) => model.id === "malformed")?.rates,
			).toBeNull();
			for (const [id, input, output, cacheRead, cacheWrite] of [
				["input-only", 2, 0, null, null],
				["output-only", 0, 8, null, null],
				["cache-only", 0, 0, 0.25, 0.5],
				["empty-cost", 0, 0, null, null],
			] as const) {
				const rates = { input, output, cacheRead, cacheWrite };
				expect(prices.find((model) => model.id === id)?.rates).toEqual(rates);
				expect(await getModelRates(id)).toEqual(rates);
				expect(
					await estimateCostUSD(id, {
						inputTokens: 1_000_000,
						outputTokens: 1_000_000,
						cacheReadInputTokens: 1_000_000,
						cacheCreationInputTokens: 1_000_000,
					}),
				).toBe(input + output + (cacheRead ?? 0) + (cacheWrite ?? 0));
			}
			expect(
				await estimateCostUSD("test-opus", {
					inputTokens: 1_000_000,
					outputTokens: 1_000_000,
					cacheReadInputTokens: 1_000_000,
					cacheCreationInputTokens: 1_000_000,
				}),
			).toBe(13);
		} finally {
			fetch.mockRestore();
			if (offline === undefined) delete process.env.CF_PRICING_OFFLINE;
			else process.env.CF_PRICING_OFFLINE = offline;
		}
	});
});
