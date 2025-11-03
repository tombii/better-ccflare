import type { Account } from "@better-ccflare/types";
import { NanoGPTProvider } from "../provider";

describe("NanoGPTProvider", () => {
	let provider: NanoGPTProvider;
	let mockAccount: Account;

	beforeEach(() => {
		provider = new NanoGPTProvider();
		mockAccount = {
			id: "test-id",
			name: "test-account",
			provider: "nanogpt",
			refresh_token: null,
			access_token: null,
			expires_at: null,
			api_key: "test-api-key",
			custom_endpoint: "https://nano-gpt.com/api",
			rate_limited_until: null,
			rate_limit_status: null,
			rate_limit_reset: null,
			rate_limit_remaining: null,
			created_at: Date.now(),
			last_used: null,
			request_count: 0,
			total_requests: 0,
			session_start: null,
			session_request_count: 0,
			paused: false,
			priority: 0,
			auto_fallback_enabled: false,
			auto_refresh_enabled: false,
			model_mappings: null,
		};
	});

	describe("name", () => {
		it("should have the correct provider name", () => {
			expect(provider.name).toBe("nanogpt");
		});
	});

	describe("canHandle", () => {
		it("should handle all paths", () => {
			expect(provider.canHandle("/v1/messages")).toBe(true);
			expect(provider.canHandle("/v1/chat/completions")).toBe(true);
			expect(provider.canHandle("/any/path")).toBe(true);
		});
	});

	describe("refreshToken", () => {
		it("should return existing API key for API key providers", async () => {
			const result = await provider.refreshToken(mockAccount, "client-id");

			expect(result.accessToken).toBe("test-api-key");
			expect(result.refreshToken).toBe(""); // Empty string prevents DB update for API key accounts
			expect(result.expiresAt).toBeGreaterThan(Date.now());
		});

		it("should throw error when no API key is available", async () => {
			const accountWithoutKey = {
				...mockAccount,
				api_key: null,
				refresh_token: null,
			};

			await expect(
				provider.refreshToken(accountWithoutKey, "client-id"),
			).rejects.toThrow("No API key available for account");
		});

		it("should use refresh_token as fallback when api_key is not available", async () => {
			const accountWithRefreshTokenOnly = {
				...mockAccount,
				api_key: null,
				refresh_token: "fallback-api-key",
			};

			const result = await provider.refreshToken(
				accountWithRefreshTokenOnly,
				"client-id",
			);

			expect(result.accessToken).toBe("fallback-api-key");
			expect(result.refreshToken).toBe(""); // Empty string prevents DB update for API key accounts
			expect(result.expiresAt).toBeGreaterThan(Date.now());
		});
	});

	describe("supportsUsageTracking", () => {
		it("should support usage tracking", () => {
			expect(provider.supportsUsageTracking()).toBe(true);
		});
	});

	describe("isAccountUsable", () => {
		it("should return true if subscription data cannot be fetched (fail-safe behavior)", async () => {
			// Mock the checkSubscriptionUsage to return null
			jest.spyOn(provider, "checkSubscriptionUsage").mockResolvedValue(null);

			const result = await provider.isAccountUsable(mockAccount);
			expect(result).toBe(true); // Changed to true for fail-safe behavior
		});

		it("should return true for inactive (PAYG) accounts", async () => {
			// Mock the checkSubscriptionUsage to return inactive subscription
			jest.spyOn(provider, "checkSubscriptionUsage").mockResolvedValue({
				subscription: {
					active: false,
					limits: {
						daily: 2000,
						monthly: 60000,
					},
					enforceDailyLimit: false,
					daily: {
						used: 100,
						remaining: 1900,
						percentUsed: 0.05,
						resetAt: Date.now() + 86400000, // 24 hours from now
					},
					monthly: {
						used: 500,
						remaining: 59500,
						percentUsed: 0.0083,
						resetAt: Date.now() + 2592000000, // 30 days from now
					},
					period: {
						currentPeriodEnd: null,
					},
					state: "inactive",
					graceUntil: null,
				},
				lastChecked: Date.now(),
			});

			const result = await provider.isAccountUsable(mockAccount);
			expect(result).toBe(true);
		});

		it("should return true for active subscription with sufficient limits", async () => {
			// Mock the checkSubscriptionUsage to return active subscription with sufficient limits
			jest.spyOn(provider, "checkSubscriptionUsage").mockResolvedValue({
				subscription: {
					active: true,
					limits: {
						daily: 2000,
						monthly: 60000,
					},
					enforceDailyLimit: true,
					daily: {
						used: 100,
						remaining: 1900,
						percentUsed: 0.05,
						resetAt: Date.now() + 86400000, // 24 hours from now
					},
					monthly: {
						used: 500,
						remaining: 59500,
						percentUsed: 0.0083,
						resetAt: Date.now() + 2592000000, // 30 days from now
					},
					period: {
						currentPeriodEnd: "2025-02-13T23:59:59.000Z",
					},
					state: "active",
					graceUntil: null,
				},
				lastChecked: Date.now(),
			});

			const result = await provider.isAccountUsable(mockAccount);
			expect(result).toBe(true);
		});

		it("should return false for active subscription with exceeded daily limit when enforced", async () => {
			// Mock the checkSubscriptionUsage to return active subscription with exceeded daily limit
			jest.spyOn(provider, "checkSubscriptionUsage").mockResolvedValue({
				subscription: {
					active: true,
					limits: {
						daily: 2000,
						monthly: 60000,
					},
					enforceDailyLimit: true,
					daily: {
						used: 2000,
						remaining: 0,
						percentUsed: 1,
						resetAt: Date.now() + 86400000, // 24 hours from now
					},
					monthly: {
						used: 500,
						remaining: 59500,
						percentUsed: 0.0083,
						resetAt: Date.now() + 2592000000, // 30 days from now
					},
					period: {
						currentPeriodEnd: "2025-02-13T23:59:59.000Z",
					},
					state: "active",
					graceUntil: null,
				},
				lastChecked: Date.now(),
			});

			const result = await provider.isAccountUsable(mockAccount);
			expect(result).toBe(false);
		});

		it("should return false for active subscription with exceeded monthly limit", async () => {
			// Mock the checkSubscriptionUsage to return active subscription with exceeded monthly limit
			jest.spyOn(provider, "checkSubscriptionUsage").mockResolvedValue({
				subscription: {
					active: true,
					limits: {
						daily: 2000,
						monthly: 60000,
					},
					enforceDailyLimit: false,
					daily: {
						used: 100,
						remaining: 1900,
						percentUsed: 0.05,
						resetAt: Date.now() + 86400000, // 24 hours from now
					},
					monthly: {
						used: 60000,
						remaining: 0,
						percentUsed: 1,
						resetAt: Date.now() + 2592000000, // 30 days from now
					},
					period: {
						currentPeriodEnd: "2025-02-13T23:59:59.000Z",
					},
					state: "active",
					graceUntil: null,
				},
				lastChecked: Date.now(),
			});

			const result = await provider.isAccountUsable(mockAccount);
			expect(result).toBe(false);
		});
	});

	describe("getRateLimitInfo", () => {
		it("should return not rate limited for inactive (PAYG) accounts", async () => {
			// Mock the checkSubscriptionUsage to return inactive subscription
			jest.spyOn(provider, "checkSubscriptionUsage").mockResolvedValue({
				subscription: {
					active: false,
					limits: {
						daily: 2000,
						monthly: 60000,
					},
					enforceDailyLimit: false,
					daily: {
						used: 100,
						remaining: 1900,
						percentUsed: 0.05,
						resetAt: Date.now() + 86400000, // 24 hours from now
					},
					monthly: {
						used: 500,
						remaining: 59500,
						percentUsed: 0.0083,
						resetAt: Date.now() + 2592000000, // 30 days from now
					},
					period: {
						currentPeriodEnd: null,
					},
					state: "inactive",
					graceUntil: null,
				},
				lastChecked: Date.now(),
			});

			const result = await provider.getRateLimitInfo(mockAccount);
			expect(result.isRateLimited).toBe(false);
		});

		it("should return rate limited when daily limit is exceeded and enforced", async () => {
			// Mock the checkSubscriptionUsage to return active subscription with exceeded daily limit
			jest.spyOn(provider, "checkSubscriptionUsage").mockResolvedValue({
				subscription: {
					active: true,
					limits: {
						daily: 2000,
						monthly: 60000,
					},
					enforceDailyLimit: true,
					daily: {
						used: 2000,
						remaining: 0,
						percentUsed: 1,
						resetAt: Date.now() + 86400000, // 24 hours from now
					},
					monthly: {
						used: 500,
						remaining: 59500,
						percentUsed: 0.0083,
						resetAt: Date.now() + 2592000000, // 30 days from now
					},
					period: {
						currentPeriodEnd: "2025-02-13T23:59:59.000Z",
					},
					state: "active",
					graceUntil: null,
				},
				lastChecked: Date.now(),
			});

			const result = await provider.getRateLimitInfo(mockAccount);
			expect(result.isRateLimited).toBe(true);
			expect(result.resetTime).toBeDefined();
			expect(result.resetTime).toBeCloseTo(Date.now() + 86400000, -1); // Allow for small timing differences
			expect(result.statusHeader).toBe("rate_limited");
		});

		it("should return rate limited when monthly limit is exceeded", async () => {
			// Mock the checkSubscriptionUsage to return active subscription with exceeded monthly limit
			jest.spyOn(provider, "checkSubscriptionUsage").mockResolvedValue({
				subscription: {
					active: true,
					limits: {
						daily: 2000,
						monthly: 60000,
					},
					enforceDailyLimit: false,
					daily: {
						used: 100,
						remaining: 1900,
						percentUsed: 0.05,
						resetAt: Date.now() + 86400000, // 24 hours from now
					},
					monthly: {
						used: 60000,
						remaining: 0,
						percentUsed: 1,
						resetAt: Date.now() + 2592000000, // 30 days from now
					},
					period: {
						currentPeriodEnd: "2025-02-13T23:59:59.000Z",
					},
					state: "active",
					graceUntil: null,
				},
				lastChecked: Date.now(),
			});

			const result = await provider.getRateLimitInfo(mockAccount);
			expect(result.isRateLimited).toBe(true);
			expect(result.resetTime).toBeDefined();
			expect(result.resetTime).toBeCloseTo(Date.now() + 2592000000, -1); // Allow for small timing differences
			expect(result.statusHeader).toBe("rate_limited");
		});

		it("should return not rate limited when limits are available", async () => {
			// Mock the checkSubscriptionUsage to return active subscription with available limits
			jest.spyOn(provider, "checkSubscriptionUsage").mockResolvedValue({
				subscription: {
					active: true,
					limits: {
						daily: 2000,
						monthly: 60000,
					},
					enforceDailyLimit: true,
					daily: {
						used: 100,
						remaining: 1900,
						percentUsed: 0.05,
						resetAt: Date.now() + 86400000, // 24 hours from now
					},
					monthly: {
						used: 500,
						remaining: 59500,
						percentUsed: 0.0083,
						resetAt: Date.now() + 2592000000, // 30 days from now
					},
					period: {
						currentPeriodEnd: "2025-02-13T23:59:59.000Z",
					},
					state: "active",
					graceUntil: null,
				},
				lastChecked: Date.now(),
			});

			const result = await provider.getRateLimitInfo(mockAccount);
			expect(result.isRateLimited).toBe(false);
		});
	});

	describe("subscription caching", () => {
		it("should use cached data when available", async () => {
			const mockSubscriptionData = {
				subscription: {
					active: true,
					limits: {
						daily: 2000,
						monthly: 60000,
					},
					enforceDailyLimit: true,
					daily: {
						used: 100,
						remaining: 1900,
						percentUsed: 0.05,
						resetAt: Date.now() + 86400000,
					},
					monthly: {
						used: 500,
						remaining: 59500,
						percentUsed: 0.0083,
						resetAt: Date.now() + 2592000000,
					},
					period: {
						currentPeriodEnd: "2025-02-13T23:59:59.000Z",
					},
					state: "active",
					graceUntil: null,
				},
				lastChecked: Date.now(),
			};

			// Mock fetch to return the subscription data
			global.fetch = jest.fn(() =>
				Promise.resolve({
					ok: true,
					json: () => Promise.resolve(mockSubscriptionData.subscription),
				} as Response),
			) as jest.Mock;

			// Call checkSubscriptionUsage twice
			const result1 = await provider.checkSubscriptionUsage(mockAccount);
			const result2 = await provider.checkSubscriptionUsage(mockAccount);

			// Both calls should return the same data
			expect(result1).not.toBeNull();
			expect(result2).toEqual(result1);

			// At least one API call should be made
			expect(global.fetch).toHaveBeenCalledTimes(2); // Once for each call since no polling is active

			// Verify the data structure is correct
			expect(result1?.subscription.state).toBe("active");
			expect(result1?.subscription.daily.remaining).toBe(1900);
			expect(result1?.subscription.monthly.remaining).toBe(59500);
		});
	});

	describe("supportsOAuth", () => {
		it("should not support OAuth", () => {
			expect(provider.supportsOAuth()).toBe(false);
		});
	});
});
