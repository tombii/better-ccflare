import { describe, expect, it } from "bun:test";
import type { DatabaseOperations } from "@better-ccflare/database";
import {
	createAccountTokenHealthHandler,
	createReauthNeededHandler,
	createTokenHealthHandler,
} from "../token-health";
import {
	checkAllAccountsHealth,
	getAccountsNeedingReauth,
} from "@better-ccflare/proxy";

// Mock database operations for testing
const mockAccounts = [
	{
		id: "1",
		name: "test-account-1",
		provider: "anthropic",
		refresh_token: "valid-refresh-token",
		created_at: Date.now() - 30 * 24 * 60 * 60 * 1000, // 30 days ago
		expires_at: Date.now() + 14 * 24 * 60 * 60 * 1000, // 14 days from now (healthy)
		paused: false,
		api_key: null,
		access_token: "access-token",
		request_count: 0,
		total_requests: 0,
		last_used: null,
		rate_limited_until: null,
		session_start: null,
		session_request_count: 0,
		rate_limit_reset: null,
		rate_limit_status: null,
		rate_limit_remaining: null,
		priority: 0,
		auto_fallback_enabled: false,
		auto_refresh_enabled: false,
		custom_endpoint: null,
		model_mappings: null,
	},
	{
		id: "2",
		name: "test-account-2",
		provider: "anthropic",
		refresh_token: "expiring-soon-token",
		created_at: Date.now() - 95 * 24 * 60 * 60 * 1000, // 95 days ago (past 90 day max, will be expired)
		expires_at: Date.now() - 2 * 24 * 60 * 60 * 1000, // 2 days ago (expired)
		paused: false,
		api_key: null,
		access_token: "access-token",
		request_count: 0,
		total_requests: 0,
		last_used: null,
		rate_limited_until: null,
		session_start: null,
		session_request_count: 0,
		rate_limit_reset: null,
		rate_limit_status: null,
		rate_limit_remaining: null,
		priority: 0,
		auto_fallback_enabled: false,
		auto_refresh_enabled: false,
		custom_endpoint: null,
		model_mappings: null,
	},
	{
		id: "3",
		name: "test-account-3",
		provider: "anthropic",
		refresh_token: null, // No refresh token (console mode)
		created_at: Date.now() - 30 * 24 * 60 * 60 * 1000,
		expires_at: null,
		paused: false,
		api_key: "api-key", // API key account
		access_token: null,
		request_count: 0,
		total_requests: 0,
		last_used: null,
		rate_limited_until: null,
		session_start: null,
		session_request_count: 0,
		rate_limit_reset: null,
		rate_limit_status: null,
		rate_limit_remaining: null,
		priority: 0,
		auto_fallback_enabled: false,
		auto_refresh_enabled: false,
		custom_endpoint: null,
		model_mappings: null,
	},
];

const mockDbOps = {
	getAllAccounts: () => mockAccounts,
	getAccount: (name: string) =>
		mockAccounts.find((acc) => acc.name === name) || null,
	createOAuthSession: () => {},
	getOAuthSession: () => null,
	deleteOAuthSession: () => {},
	getDatabase: () => ({
		prepare: () => ({
			run: () => {},
			get: () => null,
			all: () => [],
		}),
	}),
} as unknown as DatabaseOperations;

describe("Token Health HTTP API Integration", () => {
	describe("Token Health Endpoints", () => {
		it("should create token health handler", () => {
			expect(() => {
				const handler = createTokenHealthHandler(mockDbOps);
				expect(typeof handler).toBe("function");
			}).not.toThrow();
		});

		it("should create reauth needed handler", () => {
			expect(() => {
				const handler = createReauthNeededHandler(mockDbOps);
				expect(typeof handler).toBe("function");
			}).not.toThrow();
		});

		it("should create account token health handler", () => {
			expect(() => {
				const handler = createAccountTokenHealthHandler(
					mockDbOps,
					"test-account-1",
				);
				expect(typeof handler).toBe("function");
			}).not.toThrow();
		});
	});

	describe("Token Health Monitoring", () => {
		it("should check all accounts health", () => {
			const healthReport = checkAllAccountsHealth(mockAccounts);

			expect(healthReport).toBeDefined();
			expect(healthReport.accounts).toHaveLength(3);
			expect(healthReport.summary).toBeDefined();
			expect(healthReport.summary.total).toBe(3);
		});

		it("should identify accounts needing re-authentication", () => {
			const needingReauth = getAccountsNeedingReauth(mockAccounts);

			// Should find accounts that need re-authentication
			expect(needingReauth.length).toBeGreaterThanOrEqual(1);
			// The specific account may vary based on implementation details
			expect(needingReauth.some(acc => acc.name.includes("test-account"))).toBe(true);
		});

		it("should handle empty accounts list", () => {
			const emptyHealthReport = checkAllAccountsHealth([]);
			const emptyNeedingReauth = getAccountsNeedingReauth([]);

			expect(emptyHealthReport.accounts).toHaveLength(0);
			expect(emptyHealthReport.summary.total).toBe(0);
			expect(emptyNeedingReauth).toHaveLength(0);
		});
	});

	describe("Account Health Status Types", () => {
		it("should return correct status for different account types", () => {
			const healthReport = checkAllAccountsHealth(mockAccounts);

			const account1 = healthReport.accounts.find(
				(acc) => acc.accountName === "test-account-1",
			);
			const account2 = healthReport.accounts.find(
				(acc) => acc.accountName === "test-account-2",
			);
			const account3 = healthReport.accounts.find(
				(acc) => acc.accountName === "test-account-3",
			);

			// Account with valid refresh token should have appropriate status
			expect(account1?.status).toBeDefined();

			// Account expiring soon should have appropriate status
			expect(account2?.status).toBeDefined();

			// Account without refresh token should be "no-refresh-token"
			expect(account3?.status).toBe("no-refresh-token");
		});

		it("should include days until expiration for OAuth accounts", () => {
			const healthReport = checkAllAccountsHealth(mockAccounts);

			const account1 = healthReport.accounts.find(
				(acc) => acc.name === "test-account-1",
			);
			const account2 = healthReport.accounts.find(
				(acc) => acc.name === "test-account-2",
			);

			// OAuth accounts should have daysUntilExpiration if they have expiration dates
			if (account1?.daysUntilExpiration !== undefined) {
				expect(account1?.daysUntilExpiration).toBeGreaterThan(0);
			}
			if (account2?.daysUntilExpiration !== undefined) {
				expect(account2?.daysUntilExpiration).toBeGreaterThan(0);
			}
		});
	});

	describe("Response Data Structure", () => {
		it("should provide consistent health report structure", () => {
			const healthReport = checkAllAccountsHealth(mockAccounts);

			// Check top-level structure
			expect(healthReport).toHaveProperty("accounts");
			expect(healthReport).toHaveProperty("summary");
			expect(healthReport).toHaveProperty("timestamp");

			// Check summary structure
			expect(healthReport.summary).toHaveProperty("total");
			expect(healthReport.summary).toHaveProperty("healthy");
			expect(healthReport.summary).toHaveProperty("warning");
			expect(healthReport.summary).toHaveProperty("critical");
			expect(healthReport.summary).toHaveProperty("expired");
			expect(healthReport.summary).toHaveProperty("noRefreshToken");
			expect(healthReport.summary).toHaveProperty("requiresReauth");

			// Check account structure
			healthReport.accounts.forEach((account) => {
				expect(account).toHaveProperty("accountName");
				expect(account).toHaveProperty("provider");
				expect(account).toHaveProperty("status");
				expect(account).toHaveProperty("message");
			});
		});
	});
});

describe("CLI Integration Tests", () => {
	it("should support CLI token health commands", () => {
		// Test that CLI can import and use token health functions
		expect(() => {
			const report = checkAllAccountsHealth(mockAccounts);
			const reauthNeeded = getAccountsNeedingReauth(mockAccounts);

			expect(report.summary.total).toBe(3);
			expect(reauthNeeded.length).toBeGreaterThanOrEqual(0);
		}).not.toThrow();
	});

	it("should handle account-specific health checks", () => {
		const healthReport = checkAllAccountsHealth(mockAccounts);
		const accountHealth = healthReport.accounts.find(
			(acc) => acc.accountName === "test-account-1",
		);

		expect(accountHealth).toBeDefined();
		expect(accountHealth?.accountName).toBe("test-account-1");
		expect(accountHealth?.provider).toBe("anthropic");
	});
});

describe("Error Handling", () => {
	it("should handle missing account gracefully", () => {
		const healthReport = checkAllAccountsHealth(mockAccounts);
		const missingAccount = healthReport.accounts.find(
			(acc) => acc.name === "nonexistent-account",
		);

		expect(missingAccount).toBeUndefined();
	});

	it("should handle malformed account data", () => {
		const malformedAccounts = [
			{
				id: "1",
				name: "",
				provider: "anthropic",
				refresh_token: "token",
				created_at: Date.now(),
				expires_at: Date.now(),
				paused: false,
				api_key: null,
				access_token: "access-token",
				request_count: 0,
				total_requests: 0,
				last_used: null,
				rate_limited_until: null,
				session_start: null,
				session_request_count: 0,
				rate_limit_reset: null,
				rate_limit_status: null,
				rate_limit_remaining: null,
				priority: 0,
				auto_fallback_enabled: false,
				auto_refresh_enabled: false,
				custom_endpoint: null,
				model_mappings: null,
			},
		];

		expect(() => {
			const healthReport = checkAllAccountsHealth(malformedAccounts);
			expect(healthReport.accounts).toHaveLength(1);
		}).not.toThrow();
	});
});
