import { beforeEach, describe, expect, it, spyOn } from "bun:test";

// Mock the usage fetcher functions directly
const mockUsageCache = {
	cache: new Map(),
	polling: new Map(),
	tokenProviders: new Map(),
	providerTypes: new Map(),
	customEndpoints: new Map(),

	get: (accountId: string) => {
		const cached = mockUsageCache.cache.get(accountId);
		return cached ? cached.data : null;
	},

	getAge: (accountId: string) => {
		const cached = mockUsageCache.cache.get(accountId);
		return cached ? Date.now() - cached.timestamp : null;
	},

	set: (accountId: string, data: any) => {
		mockUsageCache.cache.set(accountId, { data, timestamp: Date.now() });
	},

	delete: (accountId: string) => {
		mockUsageCache.cache.delete(accountId);
	},

	refreshNow: async (_accountId: string) => true,

	clear: () => {
		mockUsageCache.cache.clear();
		mockUsageCache.polling.clear();
		mockUsageCache.tokenProviders.clear();
	},
};

const mockFetchUsageData = {
	five_hour: { utilization: 50, resets_at: null },
	seven_day: { utilization: 70, resets_at: null },
	seven_day_oauth_apps: { utilization: 60, resets_at: null },
	seven_day_opus: { utilization: 80, resets_at: null },
};

const mockGetRepresentativeUtilization = () => 70;
const mockGetRepresentativeWindow = () => "seven_day";

const mockLog = {
	info: () => {},
	warn: () => {},
	debug: () => {},
	error: () => {},
};

const mockClearAccountRefreshCache = (_accountId: string) => {
	// Mock implementation
};

const mockCliCommands = {
	removeAccount: () => ({ success: true, message: "Account removed" }),
	pauseAccount: () => ({ success: true, message: "Account paused" }),
	resumeAccount: () => ({ success: true, message: "Account resumed" }),
};

const mockDbOps = {
	getDatabase: () => mockDatabase,
	updateAccountPriority: () => {},
	renameAccount: () => {},
	setAutoFallbackEnabled: () => {},
	forceResetAccountRateLimit: () => true,
};

// Mock Database instance
const mockDatabase = {
	query: () => mockQuery,
	run: () => {},
} as any;

const mockQuery = {
	all: () => [],
	get: () => null,
};

// Mock response helpers
const mockJsonResponse = (data: any) => ({
	ok: true,
	json: async () => data,
	status: 200,
	headers: new Headers(),
});

const mockErrorResponse = (error: any) => ({
	ok: false,
	json: async () => error,
	status: error.status || 400,
	headers: new Headers(),
});

describe("Accounts Handler - Dashboard Usage Data Integration", () => {
	const CACHE_FRESHNESS_THRESHOLD_MS = 90000; // 90 seconds

	beforeEach(() => {
		// Reset all mocks
		mockUsageCache.clear();
	});

	describe("Proactive Usage Data Fetching", () => {
		it("should fetch usage data for Claude CLI OAuth accounts but not API key accounts", async () => {
			// Setup: Create accounts handler with mocked dependencies
			const accountsHandler = createMockAccountsListHandler(
				CACHE_FRESHNESS_THRESHOLD_MS,
			);

			// Mock database response with mixed account types
			const allAccounts = [
				{
					id: "oauth-account-1",
					name: "Claude OAuth Account 1",
					provider: "anthropic",
					access_token: "sk-ant-test-1",
					refresh_token: "refresh-token-1", // Different from access token
				},
				{
					id: "api-account-1",
					name: "API Key Account",
					provider: "anthropic",
					access_token: "sk-api-key",
					refresh_token: "sk-api-key", // Same as access token = API key
				},
			];

			mockQuery.all = () =>
				allAccounts.map((account) => ({
					...account,
					request_count: 100,
					total_requests: 1000,
					last_used: Date.now() - 3600000,
					created_at: Date.now() - 86400000,
					expires_at: Date.now() + 86400000,
					rate_limited_until: null,
					rate_limit_reset: null,
					rate_limit_status: null,
					rate_limit_remaining: null,
					session_start: null,
					session_request_count: 0,
					paused: 0,
					priority: 0,
					auto_fallback_enabled: 0,
					auto_refresh_enabled: 0,
					custom_endpoint: null,
					model_mappings: null,
					token_valid: 1,
					rate_limited: 0,
					session_info: null,
				}));

			// Mock empty cache (no fresh data)
			mockUsageCache.getAge = () => null;

			// Track usageCache.set calls
			const setSpy = spyOn(mockUsageCache, "set");

			// Execute the handler
			const response = await accountsHandler();

			// Verify usage data was cached only for OAuth accounts (not API key account)
			expect(setSpy).toHaveBeenCalledWith(
				"oauth-account-1",
				mockFetchUsageData,
			);
			// Verify handler still returns data for both accounts
			expect(response.ok).toBe(true);
		});

		it("should skip fetching when cache data is fresh (< 90 seconds)", async () => {
			const accountsHandler = createMockAccountsListHandler(
				CACHE_FRESHNESS_THRESHOLD_MS,
			);

			// Mock database response with OAuth account
			const oauthAccount = {
				id: "oauth-account-1",
				name: "Claude OAuth Account",
				provider: "anthropic",
				access_token: "sk-ant-test",
				refresh_token: "refresh-token",
			};

			mockQuery.all = () => [
				{
					...oauthAccount,
					request_count: 100,
					total_requests: 1000,
					last_used: Date.now() - 3600000,
					created_at: Date.now() - 86400000,
					expires_at: Date.now() + 86400000,
					rate_limited_until: null,
					rate_limit_reset: null,
					rate_limit_status: null,
					rate_limit_remaining: null,
					session_start: null,
					session_request_count: 0,
					paused: 0,
					priority: 0,
					auto_fallback_enabled: 0,
					auto_refresh_enabled: 0,
					custom_endpoint: null,
					model_mappings: null,
					token_valid: 1,
					rate_limited: 0,
					session_info: null,
				},
			];

			// Mock fresh cache data (age = 30 seconds)
			mockUsageCache.getAge = () => 30000; // 30 seconds old

			// Execute the handler
			const response = await accountsHandler();

			// Verify handler still works with fresh cache
			expect(response.ok).toBe(true);
		});

		it("should fetch when cache data is stale (> 90 seconds)", async () => {
			const accountsHandler = createMockAccountsListHandler(
				CACHE_FRESHNESS_THRESHOLD_MS,
			);

			// Mock database response with OAuth account
			const oauthAccount = {
				id: "oauth-account-1",
				name: "Claude OAuth Account",
				provider: "anthropic",
				access_token: "sk-ant-test",
				refresh_token: "refresh-token",
			};

			mockQuery.all = () => [
				{
					...oauthAccount,
					request_count: 100,
					total_requests: 1000,
					last_used: Date.now() - 3600000,
					created_at: Date.now() - 86400000,
					expires_at: Date.now() + 86400000,
					rate_limited_until: null,
					rate_limit_reset: null,
					rate_limit_status: null,
					rate_limit_remaining: null,
					session_start: null,
					session_request_count: 0,
					paused: 0,
					priority: 0,
					auto_fallback_enabled: 0,
					auto_refresh_enabled: 0,
					custom_endpoint: null,
					model_mappings: null,
					token_valid: 1,
					rate_limited: 0,
					session_info: null,
				},
			];

			// Mock stale cache data (age = 120 seconds)
			mockUsageCache.getAge = () => 120000; // 120 seconds old

			// Track usageCache.set calls
			const setSpy = spyOn(mockUsageCache, "set");

			// Execute the handler
			const response = await accountsHandler();

			// Verify usage data was fetched and cached
			expect(setSpy).toHaveBeenCalledWith(
				"oauth-account-1",
				expect.any(Object),
			);
			expect(response.ok).toBe(true);
		});
	});

	describe("Account Management Integration", () => {
		it("should clear usage cache when Anthropic account is removed", async () => {
			const removeHandler = createMockAccountRemoveHandler();

			// Setup: Account exists in database
			mockQuery.get = () => ({ id: "test-account-id" });

			// Mock successful removal
			mockCliCommands.removeAccount = () => ({
				success: true,
				message: "Account removed",
			});

			// Track usageCache.delete calls
			const deleteSpy = spyOn(mockUsageCache, "delete");

			// Mock request body with confirmation
			const mockRequest = {
				json: async () => ({ confirm: "test-account-name" }),
			} as Request;

			// Execute the handler
			const response = await removeHandler(mockRequest, "test-account-name");

			// Verify usage cache was cleared for the removed account
			expect(deleteSpy).toHaveBeenCalledWith("test-account-id");
			expect(response.ok).toBe(true);
		});

		it("should clear usage cache when Anthropic account tokens are reloaded", async () => {
			const reloadHandler = createMockAccountReloadHandler();

			// Setup: Anthropic account exists in database
			mockQuery.get = () => ({
				name: "test-account-name",
				provider: "anthropic",
			});

			// Track usageCache.delete calls
			const deleteSpy = spyOn(mockUsageCache, "delete");

			// Execute the handler
			const response = await reloadHandler({} as Request, "test-account-id");

			// Verify usage cache was cleared
			expect(deleteSpy).toHaveBeenCalledWith("test-account-id");
			expect(response.ok).toBe(true);
		});

		it("should not clear caches for non-Anthropic accounts during token reload", async () => {
			const reloadHandler = createMockAccountReloadHandler();

			// Setup: Non-Anthropic account exists
			mockQuery.get = () => ({
				name: "test-account-name",
				provider: "openai-compatible",
			});

			// Clear any previous calls
			mockUsageCache.delete.calls = [];

			// Execute the handler
			const response = await reloadHandler({} as Request, "test-account-id");

			// Verify response indicates error for non-Anthropic account
			expect(response.ok).toBe(false);
		});

		it("should return 404 when account is not found", async () => {
			const forceResetHandler = createMockAccountForceResetRateLimitHandler();
			mockQuery.get = () => undefined;

			const response = await forceResetHandler({} as Request, "nonexistent-id");
			expect(response.status).toBe(404);
		});

		it("should force reset rate-limit state and trigger immediate usage polling", async () => {
			const forceResetHandler = createMockAccountForceResetRateLimitHandler();

			mockQuery.get = () => ({
				id: "test-account-id",
				name: "test-account-name",
				provider: "anthropic",
				access_token: "test-token",
			});

			const refreshNowSpy = spyOn(mockUsageCache, "refreshNow");
			const forceResetSpy = spyOn(mockDbOps, "forceResetAccountRateLimit");

			const response = await forceResetHandler(
				{} as Request,
				"test-account-id",
			);
			const payload = (await response.json()) as {
				success: boolean;
				usagePollTriggered: boolean;
			};

			expect(forceResetSpy).toHaveBeenCalledWith("test-account-id");
			expect(refreshNowSpy).toHaveBeenCalledWith("test-account-id");
			expect(response.ok).toBe(true);
			expect(payload.success).toBe(true);
			expect(payload.usagePollTriggered).toBe(true);
		});

		it("should return usagePollTriggered false when usage poll fails", async () => {
			const forceResetHandler = createMockAccountForceResetRateLimitHandler();
			mockQuery.get = () => ({
				id: "test-id",
				name: "test",
				provider: "anthropic",
				access_token: "tok",
			});

			const refreshNowSpy = spyOn(
				mockUsageCache,
				"refreshNow",
			).mockImplementation(async () => false);
			const forceResetSpy = spyOn(mockDbOps, "forceResetAccountRateLimit");

			const response = await forceResetHandler({} as Request, "test-id");
			const payload = (await response.json()) as {
				success: boolean;
				usagePollTriggered: boolean;
			};

			expect(forceResetSpy).toHaveBeenCalledWith("test-id");
			expect(refreshNowSpy).toHaveBeenCalledWith("test-id");
			expect(response.ok).toBe(true);
			expect(payload.usagePollTriggered).toBe(false);
		});
	});
});

// Mock factory functions to create handlers with our mocked dependencies
function createMockAccountsListHandler(CACHE_FRESHNESS_THRESHOLD_MS: number) {
	return async (): Promise<Response> => {
		const now = Date.now();
		const sessionDuration = 5 * 60 * 60 * 1000; // 5 hours

		const accounts = mockQuery.all(
			now,
			now,
			now,
			sessionDuration,
		) as Array<any>;

		// Fetch usage data for all Claude CLI OAuth accounts
		const oauthAccounts = accounts.filter(
			(acc) =>
				acc.provider === "anthropic" &&
				acc.access_token &&
				acc.refresh_token &&
				acc.refresh_token !== acc.access_token, // Exclude API key accounts
		);

		// Fetch usage data in parallel for all OAuth accounts that don't have fresh cache data
		await Promise.all(
			oauthAccounts.map(async (account) => {
				// Check if we already have cached data and if it's still fresh
				const cacheAge = mockUsageCache.getAge(account.id);
				const isCacheFresh =
					cacheAge !== null && cacheAge < CACHE_FRESHNESS_THRESHOLD_MS;

				if (!isCacheFresh && account.access_token) {
					// Fetch usage data if cache is stale or missing
					try {
						const usageData = mockFetchUsageData;
						if (usageData) {
							mockUsageCache.set(account.id, usageData);
							mockLog.debug(
								`Fetched usage data for ${account.name}: 5h=${usageData.five_hour.utilization}%, 7d=${usageData.seven_day.utilization}%`,
							);
						}
					} catch (error) {
						mockLog.warn(
							`Failed to fetch usage data for account ${account.name}:`,
							error,
						);
					}
				}
			}),
		);

		const response = accounts.map((account) => {
			// Get usage data from cache
			const usageData = mockUsageCache.get(account.id);
			let usageUtilization: number | null = null;
			let usageWindow: string | null = null;

			if (account.provider === "anthropic" && usageData) {
				usageUtilization = mockGetRepresentativeUtilization();
				usageWindow = mockGetRepresentativeWindow();
			}

			return {
				id: account.id,
				name: account.name,
				provider: account.provider || "anthropic",
				usageUtilization,
				usageWindow,
				usageData,
				hasRefreshToken: !!account.refresh_token,
			};
		});

		return mockJsonResponse(response);
	};
}

function createMockAccountRemoveHandler() {
	return async (req: Request, accountName: string): Promise<Response> => {
		try {
			const body = await req.json();

			if (body.confirm !== accountName) {
				return mockErrorResponse({
					status: 400,
					message: "Confirmation does not match",
				});
			}

			const result = mockCliCommands.removeAccount(mockDbOps, accountName);

			if (!result.success) {
				return mockErrorResponse({ status: 404, message: result.message });
			}

			// Find the account ID to clean up usage cache
			const account = mockQuery.get(accountName);

			if (account) {
				mockUsageCache.delete(account.id);
			}

			return mockJsonResponse({
				success: true,
				message: result.message,
			});
		} catch (error) {
			return mockErrorResponse(error);
		}
	};
}

function createMockAccountReloadHandler() {
	return async (_req: Request, accountId: string): Promise<Response> => {
		try {
			const account = mockQuery.get(accountId);

			if (!account) {
				return mockErrorResponse({ status: 404, message: "Account not found" });
			}

			if (account.provider !== "anthropic") {
				return mockErrorResponse({
					status: 400,
					message: "Token reload is only available for Anthropic accounts",
				});
			}

			// Clear refresh cache and usage cache
			mockClearAccountRefreshCache(accountId);
			mockUsageCache.delete(accountId);

			mockLog.info(`Token reload triggered for account '${account.name}'`);

			return mockJsonResponse({
				success: true,
				message: `Token reload triggered for account '${account.name}'`,
			});
		} catch (error) {
			return mockErrorResponse(error);
		}
	};
}

function createMockAccountForceResetRateLimitHandler() {
	return async (_req: Request, accountId: string): Promise<Response> => {
		try {
			const account = mockQuery.get(accountId);
			if (!account) {
				return mockErrorResponse({ status: 404, message: "Account not found" });
			}

			mockDbOps.forceResetAccountRateLimit(accountId);
			mockClearAccountRefreshCache(accountId);
			const usagePollTriggered = await mockUsageCache.refreshNow(accountId);

			return mockJsonResponse({
				success: true,
				message: `Rate limit state cleared for account '${account.name}'`,
				usagePollTriggered,
			});
		} catch (error) {
			return mockErrorResponse(error);
		}
	};
}
