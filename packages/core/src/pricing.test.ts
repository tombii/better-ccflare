import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import {
	estimateCostUSD,
	fetchNanoGPTPricingData,
	getCachedNanoGPTPricing,
	getModelRates,
	initializeNanoGPTPricingRefresh,
	resetNanoGPTPricingCacheForTest,
	setPricingLogger,
	stopNanoGPTPricingRefresh,
	type TokenBreakdown,
} from "./pricing";

// Mock logger for testing
const mockLogger = {
	warn: vi.fn(),
	debug: vi.fn(),
};

// Mock AccountRepository for testing
const mockAccountRepository = {
	hasAccountsForProvider: vi.fn(),
};

describe("models.dev pricing", () => {
	let originalFetch: typeof global.fetch;
	let originalOffline: string | undefined;

	beforeEach(() => {
		originalFetch = global.fetch;
		originalOffline = process.env.CF_PRICING_OFFLINE;
		delete process.env.CF_PRICING_OFFLINE;
		resetNanoGPTPricingCacheForTest();
		vi.clearAllMocks();
	});

	afterEach(() => {
		global.fetch = originalFetch;
		if (originalOffline === undefined) {
			delete process.env.CF_PRICING_OFFLINE;
		} else {
			process.env.CF_PRICING_OFFLINE = originalOffline;
		}
		resetNanoGPTPricingCacheForTest();
		vi.restoreAllMocks();
	});

	it("shares one cold models.dev fetch across concurrent estimates", async () => {
		let resolveModelsDev!: (response: Response) => void;
		const modelsDevResponse = new Promise<Response>((resolve) => {
			resolveModelsDev = resolve;
		});
		const fetchMock = vi.fn((input: string | URL | Request) => {
			if (String(input) === "https://models.dev/api.json") {
				return modelsDevResponse;
			}
			return Promise.resolve({
				ok: true,
				json: async () => ({ object: "list", data: [] }),
			} as Response);
		});
		global.fetch = fetchMock as typeof global.fetch;

		const estimates = [
			estimateCostUSD("claude-sonnet-4-20250514", { outputTokens: 1 }),
			estimateCostUSD("claude-sonnet-4-20250514", { outputTokens: 2 }),
		];
		await Promise.resolve();
		await Promise.resolve();

		const modelsDevCalls = fetchMock.mock.calls.filter(
			([input]) => String(input) === "https://models.dev/api.json",
		).length;
		resolveModelsDev({
			ok: true,
			json: async () => ({}),
		} as Response);
		await Promise.all(estimates);

		expect(modelsDevCalls).toBe(1);
	});

	it("passes an AbortSignal to the models.dev fetch and falls back to bundled pricing on abort", async () => {
		let modelsDevSignal: AbortSignal | undefined;
		const fetchMock = vi.fn(
			(input: string | URL | Request, init?: RequestInit) => {
				if (String(input) !== "https://models.dev/api.json") {
					return Promise.resolve({
						ok: true,
						json: async () => ({ object: "list", data: [] }),
					} as Response);
				}

				modelsDevSignal = init?.signal ?? undefined;
				// Simulate the fetch being aborted (as the real 10s timeout would
				// trigger via AbortController.abort()) without waiting on a real timer.
				return Promise.reject(new DOMException("aborted", "AbortError"));
			},
		);
		global.fetch = fetchMock as typeof global.fetch;

		const cost = await estimateCostUSD("claude-sonnet-4-20250514", {
			outputTokens: 1_000_000,
		});

		expect(modelsDevSignal).toBeInstanceOf(AbortSignal);
		expect(cost).toBe(15);
	});
});

describe("NanoGPT Pricing", () => {
	beforeEach(() => {
		// Clear any existing intervals
		stopNanoGPTPricingRefresh();
		// Reset the global cache state to ensure test isolation
		resetNanoGPTPricingCacheForTest();

		// Clear mocks
		vi.clearAllMocks();
	});

	afterEach(() => {
		// Stop any intervals after each test
		stopNanoGPTPricingRefresh();
		// Reset the global cache state to ensure test isolation
		resetNanoGPTPricingCacheForTest();
		// Restore all mocks to clean up between tests
		vi.restoreAllMocks();
	});

	it("should fetch NanoGPT pricing data successfully", async () => {
		// Mock fetch response
		const mockResponse = {
			object: "list",
			data: [
				{
					id: "test-model",
					name: "Test Model",
					pricing: {
						prompt: 2.5,
						completion: 10.0,
						currency: "USD",
						unit: "per_million_tokens",
					},
				},
			],
		};

		global.fetch = vi.fn().mockResolvedValue({
			ok: true,
			json: async () => mockResponse,
		} as Response);

		const result = await fetchNanoGPTPricingData(mockLogger);

		expect(fetch).toHaveBeenCalledWith(
			"https://nano-gpt.com/api/v1/models?detailed=true",
			expect.objectContaining({
				signal: expect.any(AbortSignal),
			}),
		);
		expect(result).toHaveProperty("nanogpt");
		expect(result?.nanogpt?.models).toHaveProperty("test-model");
		expect(result?.nanogpt?.models?.["test-model"]).toEqual({
			id: "test-model",
			name: "Test Model",
			cost: {
				input: 2.5,
				output: 10.0,
			},
		});
	});

	it("should handle fetch errors gracefully", async () => {
		global.fetch = vi.fn().mockRejectedValue(new Error("Network error"));

		const result = await fetchNanoGPTPricingData(mockLogger);

		expect(result).toBeNull();
		expect(mockLogger.warn).toHaveBeenCalledWith(
			expect.stringContaining("Failed to fetch NanoGPT pricing data"),
			expect.any(Error),
		);
	});

	it("should cache and reuse pricing data", async () => {
		const mockResponse = {
			object: "list",
			data: [
				{
					id: "cached-model",
					name: "Cached Model",
					pricing: {
						prompt: 1.0,
						completion: 5.0,
						currency: "USD",
						unit: "per_million_tokens",
					},
				},
			],
		};

		global.fetch = vi.fn().mockResolvedValue({
			ok: true,
			json: async () => mockResponse,
		} as Response);

		// First call should fetch
		const result1 = await getCachedNanoGPTPricing(mockLogger);
		expect(fetch).toHaveBeenCalledTimes(1);

		// Second call should use cache (no additional fetch)
		const result2 = await getCachedNanoGPTPricing(mockLogger);
		expect(fetch).toHaveBeenCalledTimes(1);

		expect(result1).toEqual(result2);
	});

	it("should refresh cache after expiration", async () => {
		const mockResponse = {
			object: "list",
			data: [
				{
					id: "refresh-model",
					name: "Refresh Model",
					pricing: {
						prompt: 3.0,
						completion: 15.0,
						currency: "USD",
						unit: "per_million_tokens",
					},
				},
			],
		};

		const originalFetch = global.fetch;
		const fetchMock = vi.fn();
		global.fetch = fetchMock
			.mockResolvedValueOnce({
				// First call
				ok: true,
				json: async () => mockResponse,
			} as Response)
			.mockResolvedValueOnce({
				// Second call after cache reset (simulating expiration)
				ok: true,
				json: async () => ({
					...mockResponse,
					data: [
						{
							...mockResponse.data[0],
							pricing: {
								...mockResponse.data[0].pricing,
								prompt: 4.0, // Different price to verify it was refreshed
							},
						},
					],
				}),
			} as Response);

		// First call should fetch
		await getCachedNanoGPTPricing(mockLogger);
		expect(fetchMock).toHaveBeenCalledTimes(1);

		// Reset the internal cache to simulate time-based expiration
		// This tests the cache expiration behavior by clearing the cache and ensuring it fetches again
		resetNanoGPTPricingCacheForTest();

		// Second call should fetch again since cache was cleared (simulating expiration)
		await getCachedNanoGPTPricing(mockLogger);
		expect(fetchMock).toHaveBeenCalledTimes(2);

		// Restore original functions
		global.fetch = originalFetch;
	});

	it("should initialize and run periodic refresh", async () => {
		const mockResponse = {
			object: "list",
			data: [
				{
					id: "periodic-model",
					name: "Periodic Model",
					pricing: {
						prompt: 2.0,
						completion: 8.0,
						currency: "USD",
						unit: "per_million_tokens",
					},
				},
			],
		};

		// Mock the global fetch function
		const originalFetch = global.fetch;
		global.fetch = vi.fn().mockResolvedValue({
			ok: true,
			json: async () => mockResponse,
		} as Response);

		await initializeNanoGPTPricingRefresh(mockLogger);

		// Should have fetched initially
		expect(global.fetch).toHaveBeenCalledTimes(1);

		// Restore original functions
		global.fetch = originalFetch;
	});

	it("should calculate cost correctly for nanogpt models", async () => {
		const mockResponse = {
			object: "list",
			data: [
				{
					id: "nanogpt-test-model",
					name: "NanoGPT Test Model",
					pricing: {
						prompt: 2.0, // $2.00 per million input tokens
						completion: 8.0, // $8.00 per million output tokens
						currency: "USD",
						unit: "per_million_tokens",
					},
				},
			],
		};

		global.fetch = vi.fn().mockResolvedValue({
			ok: true,
			json: async () => mockResponse,
		} as Response);

		// First, ensure the cache is populated
		await getCachedNanoGPTPricing(mockLogger);

		// Now test the cost calculation with specific token counts
		const tokenBreakdown: TokenBreakdown = {
			inputTokens: 500000, // 0.5 million tokens
			outputTokens: 250000, // 0.25 million tokens
		};

		// Calculate expected cost:
		// Input cost: 500,000 tokens * ($2.00 / 1,000,000) = $1.00
		// Output cost: 250,000 tokens * ($8.00 / 1,000,000) = $2.00
		// Total expected: $3.00
		const expectedInputCost = (500000 * 2.0) / 1_000_000; // $1.00
		const expectedOutputCost = (250000 * 8.0) / 1_000_000; // $2.00
		const expectedTotalCost = expectedInputCost + expectedOutputCost; // $3.00

		// This will use the cached pricing data that includes our nanogpt model
		const cost = await estimateCostUSD("nanogpt-test-model", tokenBreakdown);

		// Use toBeCloseTo for floating point comparison
		expect(cost).toBeCloseTo(expectedTotalCost, 10); // Allow for floating point precision
	});

	it("should initialize NanoGPT pricing when NanoGPT accounts exist", async () => {
		// Mock that there are nanogpt accounts
		mockAccountRepository.hasAccountsForProvider.mockReturnValue(true);

		// Spy on initializeNanoGPTPricingRefresh to verify it gets called
		const initializeRefreshSpy = vi.spyOn(
			await import("./pricing"),
			"initializeNanoGPTPricingRefresh",
		);

		// Import and call the function
		const { initializeNanoGPTPricingIfAccountsExist } = await import(
			"./pricing"
		);
		await initializeNanoGPTPricingIfAccountsExist(
			mockAccountRepository,
			mockLogger,
		);

		// Verify that initializeNanoGPTPricingRefresh was called
		expect(mockAccountRepository.hasAccountsForProvider).toHaveBeenCalledWith(
			"nanogpt",
		);
		expect(initializeRefreshSpy).toHaveBeenCalledWith(mockLogger);
	});

	it("should not initialize NanoGPT pricing when no NanoGPT accounts exist", async () => {
		// Mock that there are no nanogpt accounts
		mockAccountRepository.hasAccountsForProvider.mockReturnValue(false);

		// Spy on initializeNanoGPTPricingRefresh to verify it doesn't get called
		const initializeRefreshSpy = vi.spyOn(
			await import("./pricing"),
			"initializeNanoGPTPricingRefresh",
		);

		// Import and call the function
		const { initializeNanoGPTPricingIfAccountsExist } = await import(
			"./pricing"
		);
		await initializeNanoGPTPricingIfAccountsExist(
			mockAccountRepository,
			mockLogger,
		);

		// Verify that initializeNanoGPTPricingRefresh was not called
		expect(mockAccountRepository.hasAccountsForProvider).toHaveBeenCalledWith(
			"nanogpt",
		);
		expect(initializeRefreshSpy).not.toHaveBeenCalled();
	});
});

describe("getModelRates", () => {
	let originalOffline: string | undefined;
	let originalFetch: typeof global.fetch;

	beforeEach(() => {
		resetNanoGPTPricingCacheForTest();
		originalOffline = process.env.CF_PRICING_OFFLINE;
		process.env.CF_PRICING_OFFLINE = "1";
		originalFetch = global.fetch;
		// Block the NanoGPT fetch so only bundled pricing is used
		global.fetch = vi.fn().mockRejectedValue(new Error("offline"));
	});

	afterEach(() => {
		if (originalOffline === undefined) {
			delete process.env.CF_PRICING_OFFLINE;
		} else {
			process.env.CF_PRICING_OFFLINE = originalOffline;
		}
		global.fetch = originalFetch;
		resetNanoGPTPricingCacheForTest();
		vi.restoreAllMocks();
	});

	it("should return full rates for a bundled model with cache pricing", async () => {
		const rates = await getModelRates("claude-sonnet-4-20250514");

		expect(rates).toEqual({
			input: 3,
			output: 15,
			cacheRead: 0.3,
			cacheWrite: 3.75,
		});
	});

	it("should return null for an unknown model without throwing", async () => {
		const rates = await getModelRates("totally-unknown-model-xyz");

		expect(rates).toBeNull();
	});

	it("should return null cache rates for a bundled model without cache pricing", async () => {
		const rates = await getModelRates("MiniMax-M2");

		expect(rates).toEqual({
			input: 0.3,
			output: 1.2,
			cacheRead: null,
			cacheWrite: null,
		});
	});

	it("should return null and warn when the catalogue has malformed cost data", async () => {
		// Inject a malformed model via the NanoGPT merge path: pricing values
		// flow straight into cost.input/cost.output without validation.
		global.fetch = vi.fn().mockResolvedValue({
			ok: true,
			json: async () => ({
				object: "list",
				data: [
					{
						id: "malformed-cost-model",
						name: "Malformed Cost Model",
						pricing: {
							prompt: "not-a-number",
							completion: Number.NaN,
							currency: "USD",
							unit: "per_million_tokens",
						},
					},
				],
			}),
		} as unknown as Response);

		const warnLogger = { warn: vi.fn(), debug: vi.fn() };
		setPricingLogger(warnLogger);

		const rates = await getModelRates("malformed-cost-model");

		expect(rates).toBeNull();
		expect(warnLogger.warn).toHaveBeenCalledWith(
			"Price for model %s not found - cache savings reported as unknown",
			"malformed-cost-model",
		);
	});

	it("should still warn when estimateCostUSD warned first for the same model", async () => {
		const warnLogger = { warn: vi.fn(), debug: vi.fn() };
		setPricingLogger(warnLogger);

		// estimateCostUSD warns first via warnOnce (cost set to 0)
		const cost = await estimateCostUSD("unknown-model-warn-dedup", {
			inputTokens: 100,
		});
		expect(cost).toBe(0);
		expect(warnLogger.warn).toHaveBeenCalledWith(
			"Price for model %s not found - cost set to 0 (reason: %s)",
			"unknown-model-warn-dedup",
			expect.any(String),
		);

		// getModelRates must still emit its own distinct warning
		const rates = await getModelRates("unknown-model-warn-dedup");
		expect(rates).toBeNull();
		expect(warnLogger.warn).toHaveBeenCalledWith(
			"Price for model %s not found - cache savings reported as unknown",
			"unknown-model-warn-dedup",
		);
	});
});
