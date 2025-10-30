import { describe, it, expect, beforeEach } from "bun:test";
import { SessionStrategy } from "@better-ccflare/load-balancer";
import type {
	Account,
	RequestMeta,
	StrategyStore,
} from "@better-ccflare/types";

// Mock StrategyStore for testing
class MockStrategyStore implements StrategyStore {
	resetAccountSession(accountId: string, timestamp: number): void {
		// Mock implementation
		console.log(`Mock: Reset session for account ${accountId} at ${timestamp}`);
	}

	resumeAccount(accountId: string): void {
		// Mock implementation
		console.log(`Mock: Resume account ${accountId}`);
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

		// The account should be selected and session should be reset due to rate limit window reset
		const result = strategy.select([account], meta);
		expect(result).toContain(account);
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

		// The account should be selected normally, using only fixed duration logic
		const result = strategy.select([account], meta);
		expect(result).toContain(account);
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

		// The account should be selected normally since rate limit reset is in the future
		const result = strategy.select([account], meta);
		expect(result).toContain(account);
	});
});
