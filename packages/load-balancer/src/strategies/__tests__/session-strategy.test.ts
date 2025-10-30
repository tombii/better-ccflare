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
		expect(resetCall?.timestamp).toBeGreaterThan(0);

		// Verify account object was updated
		expect(account.session_start).toBeGreaterThan(originalSessionStart);
		expect(account.session_request_count).toBe(0);
	});

	it("should work normally for accounts without rate_limit_reset", () => {
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

		// The account should be selected normally, using only fixed duration logic
		const result = strategy.select([account], meta);

		// Verify the account is selected as the first (highest priority) result
		expect(result[0]).toBe(account);
		expect(result).toHaveLength(1);

		// Verify session was NOT reset (no rate limit reset logic for non-anthropic)
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

	it("should reset session when both fixed duration and rate limit have expired", () => {
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
		expect(resetCall?.timestamp).toBeGreaterThan(0);

		// Verify account object was updated
		expect(account.session_start).toBeGreaterThan(originalSessionStart);
		expect(account.session_request_count).toBe(0);
	});
});
