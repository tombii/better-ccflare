import { afterEach, describe, expect, it, spyOn } from "bun:test";
import {
	estimateCostUSD,
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
