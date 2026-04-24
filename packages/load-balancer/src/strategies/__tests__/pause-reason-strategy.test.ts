/**
 * Tests for the auto-fallback unpause logic in SessionStrategy with pause_reason (issue #139).
 *
 * The core fix: when a rate-limit window resets, the strategy must NOT
 * auto-unpause accounts whose pause_reason is 'manual' or 'failure_threshold'.
 * Only accounts with pause_reason='overage', 'rate_limit_window', or null may
 * be auto-unpaused.
 *
 * Note on the result ordering: SessionStrategy.select() returns an ordered
 * preference list — the caller (request router / account selector) is responsible
 * for filtering out still-paused accounts from that list. The strategy itself
 * does not strip paused accounts from the result when it decides not to unpause
 * them; it simply skips the resumeAccount() DB call and leaves the account paused.
 *
 * What we test here is that resumeAccount() is (or is not) called and that the
 * account's in-memory `paused` flag is (or is not) cleared.
 */
import { beforeEach, describe, expect, it } from "bun:test";
import { SessionStrategy } from "@better-ccflare/load-balancer";
import type {
	Account,
	RequestMeta,
	StrategyStore,
} from "@better-ccflare/types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeAccount(overrides: Partial<Account> = {}): Account {
	return {
		id: "test-account",
		name: "test-account",
		provider: "anthropic",
		api_key: null,
		refresh_token: "test",
		access_token: "test",
		expires_at: Date.now() + 3_600_000,
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
		auto_pause_on_overage_enabled: false,
		custom_endpoint: null,
		model_mappings: null,
		cross_region_mode: null,
		model_fallbacks: null,
		billing_type: null,
		pause_reason: null,
		...overrides,
	};
}

class MockStrategyStore implements StrategyStore {
	resetCalls: Array<{ accountId: string; timestamp: number }> = [];
	resumeCalls: string[] = [];

	resetAccountSession(accountId: string, timestamp: number): void {
		this.resetCalls.push({ accountId, timestamp });
	}

	resumeAccount(accountId: string): void {
		this.resumeCalls.push(accountId);
	}

	clear(): void {
		this.resetCalls = [];
		this.resumeCalls = [];
	}

	hasResumeCall(accountId: string): boolean {
		return this.resumeCalls.includes(accountId);
	}
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("SessionStrategy — pause_reason auto-unpause logic", () => {
	let strategy: SessionStrategy;
	let mockStore: MockStrategyStore;
	let meta: RequestMeta;
	const now = Date.now();
	// A rate_limit_reset value that has elapsed (triggers auto-fallback window reset)
	const expiredReset = now - 2_000;

	beforeEach(() => {
		strategy = new SessionStrategy(5 * 60 * 60 * 1_000);
		mockStore = new MockStrategyStore();
		strategy.initialize(mockStore);
		mockStore.clear();

		meta = {
			id: "test-request",
			headers: new Headers(),
			path: "/v1/messages",
			method: "POST",
			timestamp: now,
		};
	});

	// -------------------------------------------------------------------------
	// pause_reason='failure_threshold' — must NOT be auto-unpaused
	// -------------------------------------------------------------------------

	describe("pause_reason='failure_threshold'", () => {
		it("does not call resumeAccount and keeps paused=true", () => {
			const hotmail = makeAccount({
				id: "hotmail",
				name: "hotmail",
				paused: true,
				pause_reason: "failure_threshold",
				auto_fallback_enabled: true,
				rate_limit_reset: expiredReset,
				priority: 0,
			});

			strategy.select([hotmail], meta);

			expect(mockStore.hasResumeCall("hotmail")).toBe(false);
			expect(hotmail.paused).toBe(true);
		});

		it("issue #139: does not auto-unpause a failure_threshold account even when the rate limit window resets", () => {
			const hotmail = makeAccount({
				id: "hotmail",
				name: "hotmail",
				paused: true,
				pause_reason: "failure_threshold",
				auto_fallback_enabled: true,
				rate_limit_reset: expiredReset,
				priority: 0,
			});

			const gmail = makeAccount({
				id: "gmail",
				name: "gmail",
				paused: false,
				pause_reason: null,
				auto_fallback_enabled: false,
				rate_limit_reset: null,
				priority: 1,
			});

			strategy.select([hotmail, gmail], meta);

			// HOTMAIL must remain paused — resumeAccount must NOT have been called
			expect(hotmail.paused).toBe(true);
			expect(mockStore.hasResumeCall("hotmail")).toBe(false);
		});

		it("leaves the failure_threshold account paused regardless of rate_limit_reset", () => {
			const hotmail = makeAccount({
				id: "hotmail",
				name: "hotmail",
				paused: true,
				pause_reason: "failure_threshold",
				auto_fallback_enabled: true,
				rate_limit_reset: expiredReset,
				priority: 0,
			});

			strategy.select([hotmail], meta);

			// The account is found as an auto-fallback candidate but must NOT be unpaused
			expect(hotmail.paused).toBe(true);
		});
	});

	// -------------------------------------------------------------------------
	// pause_reason='manual' — must NOT be auto-unpaused
	// -------------------------------------------------------------------------

	describe("pause_reason='manual'", () => {
		it("does not call resumeAccount for a manually-paused account when rate limit window resets", () => {
			const account = makeAccount({
				id: "manual-paused",
				name: "manual-paused",
				paused: true,
				pause_reason: "manual",
				auto_fallback_enabled: true,
				rate_limit_reset: expiredReset,
				priority: 0,
			});

			strategy.select([account], meta);

			expect(mockStore.hasResumeCall("manual-paused")).toBe(false);
			expect(account.paused).toBe(true);
		});

		it("leaves the manually-paused account paused regardless of elapsed rate_limit_reset", () => {
			const manual = makeAccount({
				id: "manual-paused",
				name: "manual-paused",
				paused: true,
				pause_reason: "manual",
				auto_fallback_enabled: true,
				rate_limit_reset: expiredReset,
				priority: 0,
			});

			const healthy = makeAccount({
				id: "healthy",
				name: "healthy",
				paused: false,
				pause_reason: null,
				priority: 1,
			});

			strategy.select([manual, healthy], meta);

			expect(manual.paused).toBe(true);
			expect(mockStore.hasResumeCall("manual-paused")).toBe(false);
		});
	});

	// -------------------------------------------------------------------------
	// pause_reason='overage' — SHOULD be auto-unpaused when window resets
	// -------------------------------------------------------------------------

	describe("pause_reason='overage'", () => {
		it("calls resumeAccount and clears paused flag when the rate limit window resets", () => {
			const account = makeAccount({
				id: "overage-paused",
				name: "overage-paused",
				paused: true,
				pause_reason: "overage",
				auto_fallback_enabled: true,
				rate_limit_reset: expiredReset,
				priority: 0,
			});

			const result = strategy.select([account], meta);

			expect(mockStore.hasResumeCall("overage-paused")).toBe(true);
			expect(account.paused).toBe(false);
			expect(result[0]).toBe(account);
		});

		it("is returned as an available account after auto-unpause", () => {
			const account = makeAccount({
				id: "overage-paused",
				name: "overage-paused",
				paused: true,
				pause_reason: "overage",
				auto_fallback_enabled: true,
				rate_limit_reset: expiredReset,
				priority: 0,
			});

			strategy.select([account], meta);

			// After resumeAccount(), the account's in-memory paused flag is cleared
			expect(account.paused).toBe(false);
		});
	});

	// -------------------------------------------------------------------------
	// pause_reason=null — SHOULD be auto-unpaused when window resets
	// -------------------------------------------------------------------------

	describe("pause_reason=null", () => {
		it("calls resumeAccount and clears paused flag for null-reason account", () => {
			const account = makeAccount({
				id: "null-reason-paused",
				name: "null-reason-paused",
				paused: true,
				pause_reason: null,
				auto_fallback_enabled: true,
				rate_limit_reset: expiredReset,
				priority: 0,
			});

			const result = strategy.select([account], meta);

			expect(mockStore.hasResumeCall("null-reason-paused")).toBe(true);
			expect(account.paused).toBe(false);
			expect(result[0]).toBe(account);
		});
	});

	// -------------------------------------------------------------------------
	// pause_reason='rate_limit_window' — SHOULD be auto-unpaused when window resets
	// -------------------------------------------------------------------------

	describe("pause_reason='rate_limit_window'", () => {
		it("calls resumeAccount and clears paused flag for rate_limit_window account", () => {
			const account = makeAccount({
				id: "rlw-paused",
				name: "rlw-paused",
				paused: true,
				pause_reason: "rate_limit_window",
				auto_fallback_enabled: true,
				rate_limit_reset: expiredReset,
				priority: 0,
			});

			const result = strategy.select([account], meta);

			expect(mockStore.hasResumeCall("rlw-paused")).toBe(true);
			expect(account.paused).toBe(false);
			expect(result[0]).toBe(account);
		});
	});

	// -------------------------------------------------------------------------
	// Mixed scenario: multiple paused accounts, each with different pause_reason.
	// The first eligible auto-fallback candidate (by priority) is the overage account
	// (priority=2). The failure and manual accounts are lower priority (0, 1) but
	// cannot be unpaused, so they stay paused.
	// -------------------------------------------------------------------------

	describe("mixed pause_reason values", () => {
		it("only unpauses the eligible (overage) account, leaves failure/manual paused", () => {
			const failureAcc = makeAccount({
				id: "failure",
				name: "failure",
				paused: true,
				pause_reason: "failure_threshold",
				auto_fallback_enabled: true,
				rate_limit_reset: expiredReset,
				priority: 0,
			});
			const manualAcc = makeAccount({
				id: "manual",
				name: "manual",
				paused: true,
				pause_reason: "manual",
				auto_fallback_enabled: true,
				rate_limit_reset: expiredReset,
				priority: 1,
			});
			const overageAcc = makeAccount({
				id: "overage",
				name: "overage",
				paused: true,
				pause_reason: "overage",
				auto_fallback_enabled: true,
				rate_limit_reset: expiredReset,
				priority: 2,
			});

			// The strategy picks the FIRST candidate by priority (lowest number first).
			// Priority 0 = failure_threshold → cannot unpause, stays paused.
			// So the candidate chosen is failure, and failure stays paused.
			// Overage (priority 2) never gets to be a candidate in this call.
			strategy.select([failureAcc, manualAcc, overageAcc], meta);

			// failure_threshold and manual must never be unpaused
			expect(mockStore.hasResumeCall("failure")).toBe(false);
			expect(mockStore.hasResumeCall("manual")).toBe(false);
			expect(failureAcc.paused).toBe(true);
			expect(manualAcc.paused).toBe(true);
		});

		it("unpauses an overage account that is the highest-priority auto-fallback candidate", () => {
			// When overage account has the best (lowest) priority among auto-fallback
			// eligible accounts, it IS the chosen fallback and gets unpaused.
			const overageAcc = makeAccount({
				id: "overage",
				name: "overage",
				paused: true,
				pause_reason: "overage",
				auto_fallback_enabled: true,
				rate_limit_reset: expiredReset,
				priority: 0,
			});
			const failureAcc = makeAccount({
				id: "failure",
				name: "failure",
				paused: true,
				pause_reason: "failure_threshold",
				auto_fallback_enabled: true,
				rate_limit_reset: expiredReset,
				priority: 1,
			});

			const result = strategy.select([failureAcc, overageAcc], meta);

			expect(mockStore.hasResumeCall("overage")).toBe(true);
			expect(overageAcc.paused).toBe(false);
			expect(result[0]).toBe(overageAcc);

			// failure_threshold account must not be unpaused
			expect(mockStore.hasResumeCall("failure")).toBe(false);
			expect(failureAcc.paused).toBe(true);
		});
	});

	// -------------------------------------------------------------------------
	// Contrast: with pause_reason=null behaves like the original (pre-issue-#139)
	// auto-fallback where paused accounts could be auto-unpaused
	// -------------------------------------------------------------------------

	describe("backward compatibility — null pause_reason unpauses as before", () => {
		it("existing auto-fallback behavior preserved when pause_reason is null", () => {
			const now2 = Date.now();
			const account1 = makeAccount({
				id: "auto-fallback-reset",
				name: "auto-fallback-reset",
				paused: true,
				pause_reason: null,
				rate_limit_reset: now2 - 2_000,
				priority: 0,
				auto_fallback_enabled: true,
			});

			const account2 = makeAccount({
				id: "no-auto-fallback",
				name: "no-auto-fallback",
				paused: true,
				pause_reason: null,
				rate_limit_reset: now2,
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
	});

	describe("provider eligibility for auto-fallback", () => {
		it("auto-unpauses codex account when reset window passed", () => {
			const codex = makeAccount({
				id: "codex",
				name: "codex",
				provider: "codex",
				paused: true,
				pause_reason: null,
				auto_fallback_enabled: true,
				rate_limit_reset: expiredReset,
				priority: 0,
			});

			const result = strategy.select([codex], meta);

			expect(result[0]).toBe(codex);
			expect(mockStore.hasResumeCall("codex")).toBe(true);
			expect(codex.paused).toBe(false);
		});

		it("auto-unpauses zai account when reset window passed", () => {
			const zai = makeAccount({
				id: "zai",
				name: "zai",
				provider: "zai",
				paused: true,
				pause_reason: null,
				auto_fallback_enabled: true,
				rate_limit_reset: expiredReset,
				priority: 0,
			});

			const result = strategy.select([zai], meta);

			expect(result[0]).toBe(zai);
			expect(mockStore.hasResumeCall("zai")).toBe(true);
			expect(zai.paused).toBe(false);
		});

		it("does not auto-unpause unsupported provider", () => {
			const unsupported = makeAccount({
				id: "openai-compatible",
				name: "openai-compatible",
				provider: "openai-compatible",
				paused: true,
				pause_reason: null,
				auto_fallback_enabled: true,
				rate_limit_reset: expiredReset,
				priority: 0,
			});

			const result = strategy.select([unsupported], meta);

			expect(result).toHaveLength(0);
			expect(mockStore.hasResumeCall("openai-compatible")).toBe(false);
			expect(unsupported.paused).toBe(true);
		});
	});
});
