import { beforeEach, describe, expect, it } from "bun:test";
import { SessionStrategy } from "@better-ccflare/load-balancer";
import type {
	Account,
	RequestMeta,
	StrategyStore,
} from "@better-ccflare/types";

// Mock StrategyStore for testing
class MockStrategyStore implements StrategyStore {
	resetCalls: Array<{ accountId: string; timestamp: number }> = [];
	resumeCalls: string[] = [];

	resetAccountSession(accountId: string, timestamp: number): void {
		this.resetCalls.push({ accountId, timestamp });
	}

	resumeAccount(accountId: string): void {
		this.resumeCalls.push(accountId);
	}

	// Helper methods for testing
	clear(): void {
		this.resetCalls = [];
		this.resumeCalls = [];
	}

	getResetCall(
		accountId: string,
	): { accountId: string; timestamp: number } | undefined {
		return this.resetCalls.find((call) => call.accountId === accountId);
	}

	hasResumeCall(accountId: string): boolean {
		return this.resumeCalls.includes(accountId);
	}
}

describe("SessionStrategy", () => {
	let strategy: SessionStrategy;
	let mockStore: MockStrategyStore;
	let meta: RequestMeta;

	beforeEach(() => {
		strategy = new SessionStrategy(5 * 60 * 60 * 1000); // 5 hour default duration
		mockStore = new MockStrategyStore();
		strategy.initialize(mockStore);

		meta = {
			headers: new Headers(),
			path: "/v1/messages",
			method: "POST",
		};
	});

	beforeEach(() => {
		mockStore.clear();
	});

	it("should reset session when rate limit window has reset", () => {
		const account: Account = {
			id: "test-account-1",
			name: "test-account-1",
			provider: "anthropic",
			api_key: null,
			refresh_token: "test",
			access_token: "test",
			expires_at: Date.now() + 3600000,
			request_count: 0,
			total_requests: 0,
			last_used: null,
			created_at: Date.now(),
			rate_limited_until: null,
			session_start: Date.now() - 2 * 60 * 60 * 1000, // 2 hours ago
			session_request_count: 5,
			paused: false,
			rate_limit_reset: Date.now() - 1000, // Reset time was 1 second ago (expired)
			rate_limit_status: null,
			rate_limit_remaining: null,
			priority: 0,
			auto_fallback_enabled: false,
			auto_refresh_enabled: false,
			custom_endpoint: null,
			model_mappings: null,
		};

		// Store original session values
		const originalSessionStart = account.session_start;
		const _originalRequestCount = account.session_request_count;

		// The account should be selected and session should be reset due to rate limit window reset
		const result = strategy.select([account], meta);

		// Verify the account is selected as the first (highest priority) result
		expect(result[0]).toBe(account);
		expect(result).toHaveLength(1);

		// Verify session was actually reset
		const resetCall = mockStore.getResetCall(account.id);
		expect(resetCall).toBeDefined();
		expect(resetCall?.accountId).toBe(account.id);
		expect(resetCall?.timestamp).toBeGreaterThanOrEqual(originalSessionStart);

		// Verify account object was updated
		expect(account.session_start).toBeGreaterThan(originalSessionStart);
		expect(account.session_request_count).toBe(0);
	});

	it("should work normally for non-Anthropic providers without session duration tracking", () => {
		const account: Account = {
			id: "test-account-2",
			name: "test-account-2",
			provider: "zai", // Non-anthropic provider
			api_key: "test-key",
			refresh_token: "",
			access_token: null,
			expires_at: null,
			request_count: 0,
			total_requests: 0,
			last_used: null,
			created_at: Date.now(),
			rate_limited_until: null,
			session_start: Date.now() - 2 * 60 * 60 * 1000, // 2 hours ago
			session_request_count: 5,
			paused: false,
			rate_limit_reset: null, // No rate limit reset for non-anthropic providers
			rate_limit_status: null,
			rate_limit_remaining: null,
			priority: 0,
			auto_fallback_enabled: false,
			auto_refresh_enabled: false,
			custom_endpoint: null,
			model_mappings: null,
		};

		// Store original session values
		const originalSessionStart = account.session_start;
		const originalRequestCount = account.session_request_count;

		// The account should be selected normally, session duration tracking doesn't apply to non-Anthropic
		const result = strategy.select([account], meta);

		// Verify the account is selected as the first (highest priority) result
		expect(result[0]).toBe(account);
		expect(result).toHaveLength(1);

		// Verify session was NOT reset due to fixed duration (no session duration tracking for non-Anthropic)
		const resetCall = mockStore.getResetCall(account.id);
		expect(resetCall).toBeUndefined();

		// Verify account session values remain unchanged
		expect(account.session_start).toBe(originalSessionStart);
		expect(account.session_request_count).toBe(originalRequestCount);
	});

	it("should work normally when rate_limit_reset is in the future", () => {
		const account: Account = {
			id: "test-account-3",
			name: "test-account-3",
			provider: "anthropic",
			api_key: null,
			refresh_token: "test",
			access_token: "test",
			expires_at: Date.now() + 3600000,
			request_count: 0,
			total_requests: 0,
			last_used: null,
			created_at: Date.now(),
			rate_limited_until: null,
			session_start: Date.now() - 2 * 60 * 60 * 1000, // 2 hours ago
			session_request_count: 5,
			paused: false,
			rate_limit_reset: Date.now() + 10000, // Reset time is 10 seconds in the future
			rate_limit_status: null,
			rate_limit_remaining: null,
			priority: 0,
			auto_fallback_enabled: false,
			auto_refresh_enabled: false,
			custom_endpoint: null,
			model_mappings: null,
		};

		// Store original session values
		const originalSessionStart = account.session_start;
		const originalRequestCount = account.session_request_count;

		// The account should be selected normally since rate limit reset is in the future
		const result = strategy.select([account], meta);

		// Verify the account is selected as the first (highest priority) result
		expect(result[0]).toBe(account);
		expect(result).toHaveLength(1);

		// Verify session was NOT reset (rate limit reset is in the future)
		const resetCall = mockStore.getResetCall(account.id);
		expect(resetCall).toBeUndefined();

		// Verify account session values remain unchanged
		expect(account.session_start).toBe(originalSessionStart);
		expect(account.session_request_count).toBe(originalRequestCount);
	});

	it("should reset session when both fixed duration and rate limit have expired for Anthropic accounts", () => {
		const account: Account = {
			id: "test-account-4",
			name: "test-account-4",
			provider: "anthropic",
			api_key: null,
			refresh_token: "test",
			access_token: "test",
			expires_at: Date.now() + 3600000,
			request_count: 0,
			total_requests: 0,
			last_used: null,
			created_at: Date.now(),
			rate_limited_until: null,
			session_start: Date.now() - 6 * 60 * 60 * 1000, // 6 hours ago (beyond 5 hour limit)
			session_request_count: 10,
			paused: false,
			rate_limit_reset: Date.now() - 1000, // Also expired (1 second ago)
			rate_limit_status: null,
			rate_limit_remaining: null,
			priority: 0,
			auto_fallback_enabled: false,
			auto_refresh_enabled: false,
			custom_endpoint: null,
			model_mappings: null,
		};

		// Store original session values
		const originalSessionStart = account.session_start;
		const _originalRequestCount = account.session_request_count;

		// The account should be selected and session should be reset (both conditions true)
		const result = strategy.select([account], meta);

		// Verify the account is selected as the first (highest priority) result
		expect(result[0]).toBe(account);
		expect(result).toHaveLength(1);

		// Verify session was reset
		const resetCall = mockStore.getResetCall(account.id);
		expect(resetCall).toBeDefined();
		expect(resetCall?.accountId).toBe(account.id);
		expect(resetCall?.timestamp).toBeGreaterThanOrEqual(originalSessionStart);

		// Verify account object was updated
		expect(account.session_start).toBeGreaterThan(originalSessionStart);
		expect(account.session_request_count).toBe(0);
	});

	it("should reset session when fixed duration expired for Anthropic accounts", () => {
		const account: Account = {
			id: "test-account-5-anthropic",
			name: "test-account-5-anthropic",
			provider: "anthropic",
			api_key: null,
			refresh_token: "test",
			access_token: "test",
			expires_at: Date.now() + 3600000,
			request_count: 0,
			total_requests: 0,
			last_used: null,
			created_at: Date.now(),
			rate_limited_until: null,
			session_start: Date.now() - 6 * 60 * 60 * 1000, // 6 hours ago (beyond 5 hour limit)
			session_request_count: 10,
			paused: false,
			rate_limit_reset: null, // No rate limit reset info
			rate_limit_status: null,
			rate_limit_remaining: null,
			priority: 0,
			auto_fallback_enabled: false,
			auto_refresh_enabled: false,
			custom_endpoint: null,
			model_mappings: null,
		};

		// Store original session values
		const originalSessionStart = account.session_start;
		const _originalRequestCount = account.session_request_count;

		// The account should be selected and session should be reset (fixed duration expired for Anthropic)
		const result = strategy.select([account], meta);

		// Verify the account is selected as the first (highest priority) result
		expect(result[0]).toBe(account);
		expect(result).toHaveLength(1);

		// Verify session was reset
		const resetCall = mockStore.getResetCall(account.id);
		expect(resetCall).toBeDefined();
		expect(resetCall?.accountId).toBe(account.id);
		expect(resetCall?.timestamp).toBeGreaterThanOrEqual(originalSessionStart);

		// Verify account object was updated
		expect(account.session_start).toBeGreaterThan(originalSessionStart);
		expect(account.session_request_count).toBe(0);
	});

	it("should not reset session when fixed duration expired for non-Anthropic accounts", () => {
		const account: Account = {
			id: "test-account-6-non-anthropic",
			name: "test-account-6-non-anthropic",
			provider: "zai", // Non-anthropic provider
			api_key: "test-key",
			refresh_token: "",
			access_token: null,
			expires_at: null,
			request_count: 0,
			total_requests: 0,
			last_used: null,
			created_at: Date.now(),
			rate_limited_until: null,
			session_start: Date.now() - 6 * 60 * 60 * 1000, // 6 hours ago (beyond 5 hour limit)
			session_request_count: 10,
			paused: false,
			rate_limit_reset: null,
			rate_limit_status: null,
			rate_limit_remaining: null,
			priority: 0,
			auto_fallback_enabled: false,
			auto_refresh_enabled: false,
			custom_endpoint: null,
			model_mappings: null,
		};

		// Store original session values
		const originalSessionStart = account.session_start;
		const originalRequestCount = account.session_request_count;

		// The account should be selected, but session should NOT be reset (no duration tracking for non-Anthropic)
		const result = strategy.select([account], meta);

		// Verify the account is selected as the first (highest priority) result
		expect(result[0]).toBe(account);
		expect(result).toHaveLength(1);

		// Verify session was NOT reset (no duration tracking for non-Anthropic providers)
		const resetCall = mockStore.getResetCall(account.id);
		expect(resetCall).toBeUndefined();

		// Verify account session values remain unchanged
		expect(account.session_start).toBe(originalSessionStart);
		expect(account.session_request_count).toBe(originalRequestCount);
	});

	it("should work normally when rate_limit_reset is explicitly null", () => {
		const account: Account = {
			id: "test-account-5",
			name: "test-account-5",
			provider: "anthropic",
			api_key: null,
			refresh_token: "test",
			access_token: "test",
			expires_at: Date.now() + 3600000,
			request_count: 0,
			total_requests: 0,
			last_used: null,
			created_at: Date.now(),
			rate_limited_until: null,
			session_start: Date.now() - 2 * 60 * 60 * 1000, // 2 hours ago
			session_request_count: 5,
			paused: false,
			rate_limit_reset: null, // Explicitly null (different from undefined)
			rate_limit_status: null,
			rate_limit_remaining: null,
			priority: 0,
			auto_fallback_enabled: false,
			auto_refresh_enabled: false,
			custom_endpoint: null,
			model_mappings: null,
		};

		// Store original session values
		const originalSessionStart = account.session_start;
		const originalRequestCount = account.session_request_count;

		// The account should be selected normally since rate_limit_reset is null
		const result = strategy.select([account], meta);

		// Verify the account is selected as the first (highest priority) result
		expect(result[0]).toBe(account);
		expect(result).toHaveLength(1);

		// Verify session was NOT reset (null rate_limit_reset should not trigger reset)
		const resetCall = mockStore.getResetCall(account.id);
		expect(resetCall).toBeUndefined();

		// Verify account session values remain unchanged
		expect(account.session_start).toBe(originalSessionStart);
		expect(account.session_request_count).toBe(originalRequestCount);
	});

	it("should not reset session when rate_limit_reset equals current time (boundary condition)", () => {
		const now = Date.now();
		const account: Account = {
			id: "test-account-boundary",
			name: "test-account-boundary",
			provider: "anthropic",
			api_key: null,
			refresh_token: "test",
			access_token: "test",
			expires_at: now + 3600000,
			request_count: 0,
			total_requests: 0,
			last_used: null,
			created_at: now,
			rate_limited_until: null,
			session_start: now - 2 * 60 * 60 * 1000, // 2 hours ago
			session_request_count: 5,
			paused: false,
			rate_limit_reset: now, // Equal to current time (boundary condition)
			rate_limit_status: null,
			rate_limit_remaining: null,
			priority: 0,
			auto_fallback_enabled: false,
			auto_refresh_enabled: false,
			custom_endpoint: null,
			model_mappings: null,
		};

		// Store original session values
		const originalSessionStart = account.session_start;
		const originalRequestCount = account.session_request_count;

		// The account should be selected normally since rate_limit_reset equals now (not less than now - 1000)
		const result = strategy.select([account], meta);

		// Verify the account is selected as the first (highest priority) result
		expect(result[0]).toBe(account);
		expect(result).toHaveLength(1);

		// Verify session was NOT reset (rate_limit_reset equals now, so condition rate_limit_reset < now - 1000 is false)
		const resetCall = mockStore.getResetCall(account.id);
		expect(resetCall).toBeUndefined();

		// Verify account session values remain unchanged
		expect(account.session_start).toBe(originalSessionStart);
		expect(account.session_request_count).toBe(originalRequestCount);
	});

	it("should reset session when rate_limit_reset is just less than now - 1000 (boundary condition)", () => {
		const now = Date.now();
		const account: Account = {
			id: "test-account-boundary-just-expired",
			name: "test-account-boundary-just-expired",
			provider: "anthropic",
			api_key: null,
			refresh_token: "test",
			access_token: "test",
			expires_at: now + 3600000,
			request_count: 0,
			total_requests: 0,
			last_used: null,
			created_at: now,
			rate_limited_until: null,
			session_start: now - 2 * 60 * 60 * 1000, // 2 hours ago
			session_request_count: 5,
			paused: false,
			rate_limit_reset: now - 1001, // Just less than now - 1000 (1001ms ago)
			rate_limit_status: null,
			rate_limit_remaining: null,
			priority: 0,
			auto_fallback_enabled: false,
			auto_refresh_enabled: false,
			custom_endpoint: null,
			model_mappings: null,
		};

		// Store original session values
		const originalSessionStart = account.session_start;
		const _originalRequestCount = account.session_request_count;

		// The account should be selected and session should be reset since rate_limit_reset < now - 1000
		const result = strategy.select([account], meta);

		// Verify the account is selected as the first (highest priority) result
		expect(result[0]).toBe(account);
		expect(result).toHaveLength(1);

		// Verify session was reset (rate_limit_reset is just less than now - 1000)
		const resetCall = mockStore.getResetCall(account.id);
		expect(resetCall).toBeDefined();
		expect(resetCall?.accountId).toBe(account.id);
		expect(resetCall?.timestamp).toBeGreaterThanOrEqual(originalSessionStart);

		// Verify account object was updated
		expect(account.session_start).toBeGreaterThan(originalSessionStart);
		expect(account.session_request_count).toBe(0);
	});

	it("should handle multiple accounts with different rate limit reset scenarios", () => {
		const now = Date.now();
		// Reset all sessions to ensure no active sessions exist
		const account1: Account = {
			id: "test-account-1-reset",
			name: "test-account-1-reset",
			provider: "anthropic",
			api_key: null,
			refresh_token: "test",
			access_token: "test",
			expires_at: now + 3600000,
			request_count: 0,
			total_requests: 0,
			last_used: null,
			created_at: now,
			rate_limited_until: null,
			session_start: null, // No active session to start with
			session_request_count: 0,
			paused: false,
			rate_limit_reset: now - 2000, // Reset 2 seconds ago (should trigger reset when selected)
			rate_limit_status: null,
			rate_limit_remaining: null,
			priority: 0, // Highest priority
			auto_fallback_enabled: false,
			auto_refresh_enabled: false,
			custom_endpoint: null,
			model_mappings: null,
		};

		const account2: Account = {
			id: "test-account-2-no-reset",
			name: "test-account-2-no-reset",
			provider: "anthropic",
			api_key: null,
			refresh_token: "test",
			access_token: "test",
			expires_at: now + 3600000,
			request_count: 0,
			total_requests: 0,
			last_used: null,
			created_at: now,
			rate_limited_until: null,
			session_start: null, // No active session
			session_request_count: 0,
			paused: false,
			rate_limit_reset: now, // Equal to current time (should NOT trigger reset)
			rate_limit_status: null,
			rate_limit_remaining: null,
			priority: 1, // Lower priority
			auto_fallback_enabled: false,
			auto_refresh_enabled: false,
			custom_endpoint: null,
			model_mappings: null,
		};

		const account3: Account = {
			id: "test-account-3-future-reset",
			name: "test-account-3-future-reset",
			provider: "anthropic",
			api_key: null,
			refresh_token: "test",
			access_token: "test",
			expires_at: now + 3600000,
			request_count: 0,
			total_requests: 0,
			last_used: null,
			created_at: now,
			rate_limited_until: null,
			session_start: null, // No active session
			session_request_count: 0,
			paused: false,
			rate_limit_reset: now + 5000, // Reset 5 seconds in the future (should NOT trigger reset)
			rate_limit_status: null,
			rate_limit_remaining: null,
			priority: 2, // Lowest priority
			auto_fallback_enabled: false,
			auto_refresh_enabled: false,
			custom_endpoint: null,
			model_mappings: null,
		};

		// All accounts have no active sessions, so priority 0 (account1) should be selected
		// Since account1 has rate_limit_reset < now - 1000, its session should be reset
		const result = strategy.select([account2, account3, account1], meta);

		// Verify the highest priority account (account1) is selected as the first result
		expect(result[0]).toBe(account1);
		expect(result).toHaveLength(3);

		// Verify session was reset only for account1 (the one with rate_limit_reset < now - 1000)
		const resetCall1 = mockStore.getResetCall(account1.id);
		const resetCall2 = mockStore.getResetCall(account2.id);
		const resetCall3 = mockStore.getResetCall(account3.id);

		expect(resetCall1).toBeDefined();
		expect(resetCall2).toBeUndefined();
		expect(resetCall3).toBeUndefined();

		// Verify account1 object was updated with new session start time and zero request count
		expect(account1.session_start).toBeGreaterThanOrEqual(now); // Should be set to current time or later
		expect(account1.session_request_count).toBe(0);
		expect(account2.session_start).toBe(null);
		expect(account2.session_request_count).toBe(0);
		expect(account3.session_start).toBe(null);
		expect(account3.session_request_count).toBe(0);
	});

	it("should handle auto-fallback with multiple accounts at boundary conditions", () => {
		const now = Date.now();
		const account1: Account = {
			id: "test-account-auto-fallback-reset",
			name: "test-account-auto-fallback-reset",
			provider: "anthropic",
			api_key: null,
			refresh_token: "test",
			access_token: "test",
			expires_at: now + 3600000,
			request_count: 0,
			total_requests: 0,
			last_used: null,
			created_at: now,
			rate_limited_until: null,
			session_start: null, // No active session
			session_request_count: 0,
			paused: true, // Paused account that should be auto-fallback eligible
			rate_limit_reset: now - 2000, // Reset 2 seconds ago (should trigger auto-fallback)
			rate_limit_status: null,
			rate_limit_remaining: null,
			priority: 0, // Highest priority
			auto_fallback_enabled: true, // Auto-fallback enabled
			auto_refresh_enabled: false,
			custom_endpoint: null,
			model_mappings: null,
		};

		const account2: Account = {
			id: "test-account-no-auto-fallback",
			name: "test-account-no-auto-fallback",
			provider: "anthropic",
			api_key: null,
			refresh_token: "test",
			access_token: "test",
			expires_at: now + 3600000,
			request_count: 0,
			total_requests: 0,
			last_used: null,
			created_at: now,
			rate_limited_until: null,
			session_start: null, // No active session
			session_request_count: 0,
			paused: true, // Paused account
			rate_limit_reset: now, // Equal to current time (should NOT trigger auto-fallback)
			rate_limit_status: null,
			rate_limit_remaining: null,
			priority: 1, // Lower priority
			auto_fallback_enabled: true, // Auto-fallback enabled but reset not expired
			auto_refresh_enabled: false,
			custom_endpoint: null,
			model_mappings: null,
		};

		// The account with expired reset should be selected via auto-fallback
		const result = strategy.select([account2, account1], meta);

		// Verify the account with expired reset and higher priority (account1) is selected first due to auto-fallback
		expect(result[0]).toBe(account1);
		expect(result).toHaveLength(1); // Only account1 should be in result since account2 doesn't qualify for auto-fallback

		// Verify the paused account was resumed due to auto-fallback
		expect(account1.paused).toBe(false);
		expect(mockStore.hasResumeCall(account1.id)).toBe(true);
		expect(account2.paused).toBe(true); // Should remain paused
	});

	it("should handle unknown providers gracefully", () => {
		const now = Date.now();
		const account: Account = {
			id: "test-account-unknown",
			name: "test-account-unknown",
			provider: "unknown-provider", // Unknown provider not in configuration
			api_key: "test-key",
			refresh_token: "",
			access_token: null,
			expires_at: null,
			request_count: 0,
			total_requests: 0,
			last_used: null,
			created_at: now,
			rate_limited_until: null,
			session_start: now - 2 * 60 * 60 * 1000, // 2 hours ago
			session_request_count: 5,
			paused: false,
			rate_limit_reset: null,
			rate_limit_status: null,
			rate_limit_remaining: null,
			priority: 0,
			auto_fallback_enabled: false,
			auto_refresh_enabled: false,
			custom_endpoint: null,
			model_mappings: null,
		};

		// Store original session values
		const originalSessionStart = account.session_start;
		const originalRequestCount = account.session_request_count;

		// The account should be selected normally, and since it's an unknown provider,
		// it should be treated as pay-as-you-go (no session duration tracking)
		const result = strategy.select([account], meta);

		// Verify the account is selected as the first (highest priority) result
		expect(result[0]).toBe(account);
		expect(result).toHaveLength(1);

		// Verify session was NOT reset (unknown providers default to no session duration tracking)
		const resetCall = mockStore.getResetCall(account.id);
		expect(resetCall).toBeUndefined();

		// Verify account session values remain unchanged
		expect(account.session_start).toBe(originalSessionStart);
		expect(account.session_request_count).toBe(originalRequestCount);
	});

	it("should not reset session for Claude console API accounts (pay-as-you-go, no session tracking)", () => {
		const account: Account = {
			id: "test-account-console-api",
			name: "test-account-console-api",
			provider: "claude-console-api", // New provider for console API accounts
			api_key: "test-api-key", // Console API accounts have API keys
			refresh_token: "",
			access_token: null,
			expires_at: null,
			request_count: 0,
			total_requests: 0,
			last_used: null,
			created_at: Date.now(),
			rate_limited_until: null,
			session_start: Date.now() - 6 * 60 * 60 * 1000, // 6 hours ago (beyond 5 hour limit)
			session_request_count: 10,
			paused: false,
			rate_limit_reset: Date.now() - 1000, // Rate limit reset in the past (should be ignored for console API)
			rate_limit_status: null,
			rate_limit_remaining: null,
			priority: 0,
			auto_fallback_enabled: false,
			auto_refresh_enabled: false,
			custom_endpoint: null,
			model_mappings: null,
		};

		// Store original session values
		const originalSessionStart = account.session_start;
		const originalRequestCount = account.session_request_count;

		// The account should be selected, but session should NOT be reset (console API accounts have no session tracking)
		const result = strategy.select([account], meta);

		// Verify the account is selected as the first (highest priority) result
		expect(result[0]).toBe(account);
		expect(result).toHaveLength(1);

		// Verify session was NOT reset (console API accounts have no session tracking)
		const resetCall = mockStore.getResetCall(account.id);
		expect(resetCall).toBeUndefined();

		// Verify account session values remain unchanged
		expect(account.session_start).toBe(originalSessionStart);
		expect(account.session_request_count).toBe(originalRequestCount);
	});
});
