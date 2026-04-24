import { beforeEach, describe, expect, it } from "bun:test";
import { SessionStrategy } from "@better-ccflare/load-balancer";
import type {
	Account,
	RequestMeta,
	StrategyStore,
} from "@better-ccflare/types";

// ---------------------------------------------------------------------------
// Shared Account factory — keeps every test focused on the fields that
// actually differ. Gemini review flagged the previous inline-everything
// style as verbose and hard to maintain.
// ---------------------------------------------------------------------------
function makeAccount(overrides: Partial<Account> = {}): Account {
	return {
		id: "test-account",
		name: "test-account",
		provider: "anthropic",
		api_key: null,
		refresh_token: "test",
		access_token: "test",
		expires_at: Date.now() + 3600_000,
		request_count: 0,
		total_requests: 0,
		last_used: null,
		created_at: Date.now(),
		rate_limited_until: null,
		session_start: null,
		session_request_count: 0,
		paused: false,
		rate_limit_reset: null,
		rate_limit_status: null,
		rate_limit_remaining: null,
		priority: 0,
		auto_fallback_enabled: false,
		auto_refresh_enabled: false,
		custom_endpoint: null,
		model_mappings: null,
		cross_region_mode: null,
		model_fallbacks: null,
		...overrides,
	};
}

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
			id: "test-request",
			headers: new Headers(),
			path: "/v1/messages",
			method: "POST",
			timestamp: Date.now(),
		};
	});

	beforeEach(() => {
		mockStore.clear();
	});

	it("should reset session when rate limit window has reset", () => {
		const sessionStart = Date.now() - 2 * 60 * 60 * 1000;
		const account = makeAccount({
			id: "test-account-1",
			name: "test-account-1",
			session_start: sessionStart,
			session_request_count: 5,
			rate_limit_reset: Date.now() - 2000, // Reset 2s ago (expired, with 1s buffer)
		});

		const result = strategy.select([account], meta);

		expect(result[0]).toBe(account);
		expect(result).toHaveLength(1);

		const resetCall = mockStore.getResetCall(account.id);
		expect(resetCall).toBeDefined();
		expect(resetCall?.accountId).toBe(account.id);
		expect(resetCall?.timestamp).toBeGreaterThanOrEqual(sessionStart);

		expect(account.session_start).toBeGreaterThan(sessionStart);
		expect(account.session_request_count).toBe(0);
	});

	it("should work normally for non-Anthropic providers without session duration tracking", () => {
		const account = makeAccount({
			id: "test-account-2",
			name: "test-account-2",
			provider: "zai",
			api_key: "test-key",
			refresh_token: "",
			access_token: null,
			expires_at: null,
			session_start: Date.now() - 2 * 60 * 60 * 1000,
			session_request_count: 5,
		});

		const originalSessionStart = account.session_start;
		const originalRequestCount = account.session_request_count;

		const result = strategy.select([account], meta);

		expect(result[0]).toBe(account);
		expect(result).toHaveLength(1);

		const resetCall = mockStore.getResetCall(account.id);
		expect(resetCall).toBeUndefined();

		expect(account.session_start).toBe(originalSessionStart);
		expect(account.session_request_count).toBe(originalRequestCount);
	});

	it("should work normally when rate_limit_reset is in the future", () => {
		const account = makeAccount({
			id: "test-account-3",
			name: "test-account-3",
			session_start: Date.now() - 2 * 60 * 60 * 1000,
			session_request_count: 5,
			rate_limit_reset: Date.now() + 10000, // 10s in the future
		});

		const originalSessionStart = account.session_start;
		const originalRequestCount = account.session_request_count;

		const result = strategy.select([account], meta);

		expect(result[0]).toBe(account);
		expect(result).toHaveLength(1);

		const resetCall = mockStore.getResetCall(account.id);
		expect(resetCall).toBeUndefined();

		expect(account.session_start).toBe(originalSessionStart);
		expect(account.session_request_count).toBe(originalRequestCount);
	});

	it("should reset session when both fixed duration and rate limit have expired for Anthropic accounts", () => {
		const sessionStart = Date.now() - 6 * 60 * 60 * 1000;
		const account = makeAccount({
			id: "test-account-4",
			name: "test-account-4",
			session_start: sessionStart, // 6h ago (beyond 5h limit)
			session_request_count: 10,
			rate_limit_reset: Date.now() - 2000, // expired
		});

		const result = strategy.select([account], meta);

		expect(result[0]).toBe(account);
		expect(result).toHaveLength(1);

		const resetCall = mockStore.getResetCall(account.id);
		expect(resetCall).toBeDefined();
		expect(resetCall?.accountId).toBe(account.id);
		expect(resetCall?.timestamp).toBeGreaterThanOrEqual(sessionStart);

		expect(account.session_start).toBeGreaterThan(sessionStart);
		expect(account.session_request_count).toBe(0);
	});

	it("should reset session when fixed duration expired for Anthropic accounts", () => {
		const sessionStart = Date.now() - 6 * 60 * 60 * 1000;
		const account = makeAccount({
			id: "test-account-5-anthropic",
			name: "test-account-5-anthropic",
			session_start: sessionStart, // beyond 5h
			session_request_count: 10,
		});

		const result = strategy.select([account], meta);

		expect(result[0]).toBe(account);
		expect(result).toHaveLength(1);

		const resetCall = mockStore.getResetCall(account.id);
		expect(resetCall).toBeDefined();
		expect(resetCall?.accountId).toBe(account.id);
		expect(resetCall?.timestamp).toBeGreaterThanOrEqual(sessionStart);

		expect(account.session_start).toBeGreaterThan(sessionStart);
		expect(account.session_request_count).toBe(0);
	});

	it("should reset session when fixed duration expired for zai accounts (zai has session tracking)", () => {
		const sessionStart = Date.now() - 6 * 60 * 60 * 1000;
		const account = makeAccount({
			id: "test-account-6-non-anthropic",
			name: "test-account-6-non-anthropic",
			provider: "zai",
			api_key: "test-key",
			refresh_token: "",
			access_token: null,
			expires_at: null,
			session_start: sessionStart,
			session_request_count: 10,
		});

		const result = strategy.select([account], meta);

		expect(result[0]).toBe(account);
		expect(result).toHaveLength(1);

		// zai has requiresSessionTracking: true, so fixed-duration expiry triggers a reset
		const resetCall = mockStore.getResetCall(account.id);
		expect(resetCall).toBeDefined();
		expect(resetCall?.accountId).toBe(account.id);

		expect(account.session_start).toBeGreaterThan(sessionStart);
		expect(account.session_request_count).toBe(0);
	});

	it("should work normally when rate_limit_reset is explicitly null", () => {
		const account = makeAccount({
			id: "test-account-5",
			name: "test-account-5",
			session_start: Date.now() - 2 * 60 * 60 * 1000,
			session_request_count: 5,
		});

		const originalSessionStart = account.session_start;
		const originalRequestCount = account.session_request_count;

		const result = strategy.select([account], meta);

		expect(result[0]).toBe(account);
		expect(result).toHaveLength(1);

		const resetCall = mockStore.getResetCall(account.id);
		expect(resetCall).toBeUndefined();

		expect(account.session_start).toBe(originalSessionStart);
		expect(account.session_request_count).toBe(originalRequestCount);
	});

	it("should not reset session when rate_limit_reset equals current time (boundary condition)", () => {
		const now = Date.now();
		const account = makeAccount({
			id: "test-account-boundary",
			name: "test-account-boundary",
			created_at: now,
			expires_at: now + 3600_000,
			session_start: now - 2 * 60 * 60 * 1000,
			session_request_count: 5,
			rate_limit_reset: now, // boundary
		});

		const originalSessionStart = account.session_start;
		const originalRequestCount = account.session_request_count;

		const result = strategy.select([account], meta);

		expect(result[0]).toBe(account);
		expect(result).toHaveLength(1);

		const resetCall = mockStore.getResetCall(account.id);
		expect(resetCall).toBeUndefined();

		expect(account.session_start).toBe(originalSessionStart);
		expect(account.session_request_count).toBe(originalRequestCount);
	});

	it("should reset session when rate_limit_reset is just less than now - 1000 (boundary condition)", () => {
		const now = Date.now();
		const sessionStart = now - 2 * 60 * 60 * 1000;
		const account = makeAccount({
			id: "test-account-boundary-just-expired",
			name: "test-account-boundary-just-expired",
			created_at: now,
			expires_at: now + 3600_000,
			session_start: sessionStart,
			session_request_count: 5,
			rate_limit_reset: now - 1001, // 1001ms ago
		});

		const result = strategy.select([account], meta);

		expect(result[0]).toBe(account);
		expect(result).toHaveLength(1);

		const resetCall = mockStore.getResetCall(account.id);
		expect(resetCall).toBeDefined();
		expect(resetCall?.accountId).toBe(account.id);
		expect(resetCall?.timestamp).toBeGreaterThanOrEqual(sessionStart);

		expect(account.session_start).toBeGreaterThan(sessionStart);
		expect(account.session_request_count).toBe(0);
	});

	it("should handle multiple accounts with different rate limit reset scenarios", () => {
		const now = Date.now();

		const account1 = makeAccount({
			id: "test-account-1-reset",
			name: "test-account-1-reset",
			created_at: now,
			expires_at: now + 3600_000,
			rate_limit_reset: now - 2000, // expired → triggers reset
			priority: 0,
		});

		const account2 = makeAccount({
			id: "test-account-2-no-reset",
			name: "test-account-2-no-reset",
			created_at: now,
			expires_at: now + 3600_000,
			rate_limit_reset: now, // equal to now → does NOT trigger
			priority: 1,
		});

		const account3 = makeAccount({
			id: "test-account-3-future-reset",
			name: "test-account-3-future-reset",
			created_at: now,
			expires_at: now + 3600_000,
			rate_limit_reset: now + 5000, // future → does NOT trigger
			priority: 2,
		});

		const result = strategy.select([account2, account3, account1], meta);

		expect(result[0]).toBe(account1);
		expect(result).toHaveLength(3);

		const resetCall1 = mockStore.getResetCall(account1.id);
		const resetCall2 = mockStore.getResetCall(account2.id);
		const resetCall3 = mockStore.getResetCall(account3.id);

		expect(resetCall1).toBeDefined();
		expect(resetCall2).toBeUndefined();
		expect(resetCall3).toBeUndefined();

		expect(account1.session_start).toBeGreaterThanOrEqual(now);
		expect(account1.session_request_count).toBe(0);
		expect(account2.session_start).toBe(null);
		expect(account2.session_request_count).toBe(0);
		expect(account3.session_start).toBe(null);
		expect(account3.session_request_count).toBe(0);
	});

	it("should handle auto-fallback with multiple accounts at boundary conditions", () => {
		const now = Date.now();

		const account1 = makeAccount({
			id: "test-account-auto-fallback-reset",
			name: "test-account-auto-fallback-reset",
			created_at: now,
			expires_at: now + 3600_000,
			paused: true,
			rate_limit_reset: now - 2000, // expired
			priority: 0,
			auto_fallback_enabled: true,
		});

		const account2 = makeAccount({
			id: "test-account-no-auto-fallback",
			name: "test-account-no-auto-fallback",
			created_at: now,
			expires_at: now + 3600_000,
			paused: true,
			rate_limit_reset: now, // NOT expired
			priority: 1,
			auto_fallback_enabled: true,
		});

		const result = strategy.select([account2, account1], meta);

		expect(result[0]).toBe(account1);
		expect(result).toHaveLength(1);

		expect(account1.paused).toBe(false);
		expect(mockStore.hasResumeCall(account1.id)).toBe(true);
		expect(account2.paused).toBe(true);
	});

	it("should handle unknown providers gracefully", () => {
		const account = makeAccount({
			id: "test-account-unknown",
			name: "test-account-unknown",
			provider: "unknown-provider",
			api_key: "test-key",
			refresh_token: "",
			access_token: null,
			expires_at: null,
			session_start: Date.now() - 2 * 60 * 60 * 1000,
			session_request_count: 5,
		});

		const originalSessionStart = account.session_start;
		const originalRequestCount = account.session_request_count;

		const result = strategy.select([account], meta);

		expect(result[0]).toBe(account);
		expect(result).toHaveLength(1);

		const resetCall = mockStore.getResetCall(account.id);
		expect(resetCall).toBeUndefined();

		expect(account.session_start).toBe(originalSessionStart);
		expect(account.session_request_count).toBe(originalRequestCount);
	});

	it("should not reset session for Claude console API accounts (pay-as-you-go, no session tracking)", () => {
		const account = makeAccount({
			id: "test-account-console-api",
			name: "test-account-console-api",
			provider: "claude-console-api",
			api_key: "test-api-key",
			refresh_token: "",
			access_token: null,
			expires_at: null,
			session_start: Date.now() - 6 * 60 * 60 * 1000, // beyond 5h
			session_request_count: 10,
			rate_limit_reset: Date.now() - 1000, // expired, but should be ignored for console API
		});

		const originalSessionStart = account.session_start;
		const originalRequestCount = account.session_request_count;

		const result = strategy.select([account], meta);

		expect(result[0]).toBe(account);
		expect(result).toHaveLength(1);

		const resetCall = mockStore.getResetCall(account.id);
		expect(resetCall).toBeUndefined();

		expect(account.session_start).toBe(originalSessionStart);
		expect(account.session_request_count).toBe(originalRequestCount);
	});

	// -------------------------------------------------------------------------
	// Issue #115 — SessionStrategy must yield to live rate-limit state.
	//
	// Before the fix, hasActiveSession() only consulted session_start, so a
	// throttled active-session account would still be considered "active" for
	// the entire 5h Anthropic session window. Combined with #114 (streaming
	// failover bypass), this meant a primary account could be silently
	// throttled and the load-balancer would keep selecting it until either
	// the session expired (5h) or the rate limit window did.
	//
	// These tests assert the new behavior: a currently-rate-limited account
	// has no usable session, but its session_start is preserved so we resume
	// the cached session naturally once the rate-limit window elapses.
	// -------------------------------------------------------------------------

	it("issue #115: yields session affinity when active account is currently rate-limited", () => {
		const now = Date.now();

		const throttled = makeAccount({
			id: "throttled",
			name: "throttled",
			created_at: now,
			expires_at: now + 3600_000,
			rate_limited_until: now + 30 * 60 * 1000, // 30min from now
			session_start: now - 30 * 60 * 1000, // active 30min session
			session_request_count: 50,
		});

		const healthy = makeAccount({
			id: "healthy",
			name: "healthy",
			created_at: now,
			expires_at: now + 3600_000,
		});

		const result = strategy.select([throttled, healthy], meta);

		expect(result[0]).toBe(healthy);
		expect(result.find((a) => a.id === throttled.id)).toBeUndefined();

		// session_start preserved for prompt-cache continuity
		expect(throttled.session_start).toBe(now - 30 * 60 * 1000);
		expect(throttled.session_request_count).toBe(50);
	});

	it("issue #115: resumes the original active session after rate-limit window elapses", () => {
		const now = Date.now();

		const recovered = makeAccount({
			id: "recovered",
			name: "recovered",
			created_at: now,
			expires_at: now + 3600_000,
			rate_limited_until: now - 1000, // elapsed 1s ago
			session_start: now - 60 * 60 * 1000, // 1h into a 5h session
			session_request_count: 25,
		});

		const result = strategy.select([recovered], meta);

		expect(result[0]).toBe(recovered);

		// No reset — original session continues for prompt-cache warmth
		const resetCall = mockStore.getResetCall(recovered.id);
		expect(resetCall).toBeUndefined();
		expect(recovered.session_start).toBe(now - 60 * 60 * 1000);
		expect(recovered.session_request_count).toBe(25);
	});

	it("issue #115: throttled active account does not block lower-priority sibling", () => {
		const now = Date.now();

		const throttledHighPriority = makeAccount({
			id: "high-pri-throttled",
			name: "high-pri-throttled",
			created_at: now,
			expires_at: now + 3600_000,
			rate_limited_until: now + 30 * 60 * 1000,
			session_start: now - 10 * 60 * 1000,
			session_request_count: 5,
			priority: 0,
		});

		const lowerPriority = makeAccount({
			id: "lower-pri-healthy",
			name: "lower-pri-healthy",
			created_at: now,
			expires_at: now + 3600_000,
			priority: 1,
		});

		const result = strategy.select(
			[throttledHighPriority, lowerPriority],
			meta,
		);

		expect(result[0]).toBe(lowerPriority);
	});
});
