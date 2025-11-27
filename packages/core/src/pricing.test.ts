import { afterEach, beforeEach, describe, expect, it } from "bun:test";
// Import vi from vitest for mocking utilities
import { vi } from "vitest";
import {
	estimateCostUSD,
	fetchNanoGPTPricingData,
	getCachedNanoGPTPricing,
	initializeNanoGPTPricingRefresh,
	resetNanoGPTPricingCacheForTest,
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
