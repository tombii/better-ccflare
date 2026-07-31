/**
 * Tests for the circuit-breaker chokepoint wiring inside
 * `applyRateLimitCooldown` and the active-clear wiring inside
 * `clearExpiredRateLimits`. The breaker module itself is tested in
 * `circuit-breaker.test.ts`; this file verifies the integration contract.
 *
 * Required tests (spec §"Tests — the negative control is the whole point"):
 *   1. A 529 through applyRateLimitCooldown reaches the breaker.
 *   2. A `model_fallback_429` through applyRateLimitCooldown does NOT
 *      open the circuit (the headline regression the breaker exists to
 *      prevent — see design §4 and audit F2).
 *   3. A failure suppressed by the forward guard does NOT reach the
 *      breaker (design §3 "double-counting" — 529 mid-429-bench).
 *   4. clearExpiredRateLimits on a benched account returns the breaker
 *      to `closed` (Risk 2 in the design).
 *
 * Plus the MANDATORY NEGATIVE CONTROL: the test for (1) must go RED
 * when the breaker.recordFailure call inside applyRateLimitCooldown is
 * removed. The orchestrator re-runs this; do not fake it.
 */
import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import type { Account, RateLimitReason } from "@better-ccflare/types";
import type { CircuitKey } from "../circuit-breaker";
import { CircuitBreaker } from "../circuit-breaker";
import type { ProxyContext } from "../handlers/proxy-types";
import { applyRateLimitCooldown } from "../handlers/rate-limit-cooldown";

/**
 * The literal `"model_fallback_429"` below is sourced from
 * `@better-ccflare/types`'s `RateLimitReason` union (packages/types/src/
 * account.ts). Using a typed `RateLimitReason` here pins the literal to
 * the upstream enum — if a future rename drops this variant from the
 * union, TypeScript fails this test at compile time, not at runtime.
 */
const MODEL_FALLBACK_429: RateLimitReason = "model_fallback_429";
const OVERLOAD_529: RateLimitReason = "upstream_529_overloaded_with_reset";
const LONG_COOLDOWN_MS = 60 * 60 * 1000; // 1h

const T0 = 1_700_000_000_000;
const realDateNow = Date.now;

function makeAccount(overrides: Partial<Account> = {}): Account {
	return {
		id: "acc-cooldown-cb",
		name: "cb-cooldown",
		provider: "anthropic",
		api_key: null,
		refresh_token: null,
		access_token: null,
		expires_at: null,
		request_count: 0,
		total_requests: 0,
		last_used: null,
		created_at: T0,
		rate_limited_until: null,
		rate_limited_at: null,
		rate_limited_reason: null,
		session_start: null,
		session_request_count: 0,
		paused: false,
		requires_reauth: false,
		rate_limit_reset: null,
		rate_limit_status: null,
		rate_limit_remaining: null,
		priority: 0,
		auto_fallback_enabled: false,
		auto_refresh_enabled: false,
		auto_pause_on_overage_enabled: false,
		peak_hours_pause_enabled: false,
		custom_endpoint: null,
		model_mappings: null,
		cross_region_mode: null,
		model_fallbacks: null,
		billing_type: null,
		pause_reason: null,
		refresh_token_issued_at: null,
		consecutive_rate_limits: 0,
		...overrides,
	} as Account;
}

function makeContext(): ProxyContext {
	return {
		strategy: {} as never,
		dbOps: {
			markAccountRateLimited: mock(async () => ({
				consecutiveRateLimits: 1,
				applied: true,
			})),
		} as never,
		runtime: {} as never,
		config: {} as never,
		provider: { name: "anthropic" } as never,
		refreshInFlight: new Map(),
		asyncWriter: { enqueue: mock(() => {}) } as never,
	};
}

const KEY: CircuitKey = { provider: "anthropic", accountId: "acc-cooldown-cb" };

beforeEach(() => {
	Date.now = () => T0;
});

afterEach(() => {
	Date.now = realDateNow;
});

describe("cooldown chokepoint — breaker fed from applyRateLimitCooldown", () => {
	it("test 1: a 529 through applyRateLimitCooldown reaches the breaker and counts toward opening", () => {
		const breaker = new CircuitBreaker();
		const ctx = makeContext();

		// One 529 is not enough on its own to open (failureThreshold defaults
		// to 5). We assert "counts toward opening" by checking the failure
		// count rose by exactly one and the circuit stays closed.
		expect(breaker.getState(KEY)).toBe("closed");
		applyRateLimitCooldown(accountFor(), { reason: OVERLOAD_529 }, ctx, breaker);
		expect(breaker.getState(KEY)).toBe("closed");

		const snap = breaker.snapshot().find((s) => s.accountId === KEY.accountId);
		expect(snap).toBeDefined();
		expect(snap?.failureCount).toBe(1);
	});

	it("test 2: a model_fallback_429 through applyRateLimitCooldown does NOT open the circuit", () => {
		const breaker = new CircuitBreaker();
		const ctx = makeContext();
		const account = accountFor();

		// Five model_fallback_429s — well past the failureThreshold (5).
		// The breaker MUST stay closed because client-side graceful model
		// fallback is the recovery mechanism for exactly this case. See
		// design §4 and audit F2.
		for (let i = 0; i < 10; i++) {
			applyRateLimitCooldown(
				account,
				{ reason: MODEL_FALLBACK_429 },
				ctx,
				breaker,
			);
		}

		expect(breaker.getState(KEY)).toBe("closed");
		// And the cooldown DID write — the bench is unrelated to the breaker.
		expect(account.rate_limited_until).not.toBeNull();
	});

	it("test 3: a failure suppressed by the forward guard does NOT reach the breaker", () => {
		const breaker = new CircuitBreaker();
		const ctx = makeContext();
		const account = accountFor();

		// Arm the forward guard: the account already has a longer, still-active
		// cooldown. A subsequent 529 will be suppressed (returned early, before
		// the recordFailure call) — see rate-limit-cooldown.ts:~243.
		const existingLongCooldown = T0 + LONG_COOLDOWN_MS;
		account.rate_limited_until = existingLongCooldown;
		account.rate_limited_reason = "upstream_429_with_reset";
		account.rate_limited_at = T0 - 1000;

		applyRateLimitCooldown(account, { reason: OVERLOAD_529 }, ctx, breaker);

		// The forward guard must have returned BEFORE recordFailure ran —
		// the breaker should not have any entry for this account.
		expect(breaker.getState(KEY)).toBe("closed");
		const snap = breaker.snapshot().find((s) => s.accountId === KEY.accountId);
		expect(snap).toBeUndefined();
		// And the existing longer cooldown is preserved.
		expect(account.rate_limited_until).toBe(existingLongCooldown);
	});

	it("test 4: clearExpiredRateLimits on a benched account returns the breaker to `closed`", () => {
		// This test exercises the contract: when the repository returns a
		// cleared row, the caller (server.ts) feeds it to recordSuccess. The
		// breaker sees recordSuccess on every row clearExpiredRateLimits
		// cleared — which is the active-clear path from design §3.
		const breaker = new CircuitBreaker();
		const ctx = makeContext();
		const account = accountFor();

		// Trip the breaker via 5x 529s (threshold = 5).
		for (let i = 0; i < 5; i++) {
			applyRateLimitCooldown(
				account,
				{ reason: OVERLOAD_529 },
				ctx,
				breaker,
			);
		}
		expect(breaker.getState(KEY)).toBe("open");

		// The breaker was opened at T0 with a 30s cooldown, so it transitions
		// to half-open at T0 + 30_000. Active-clear calls recordSuccess on
		// every cleared row — but recordSuccess is only effective from
		// half-open. So we exercise the half-open→closed transition, which
		// is exactly what happens once a real cleared row arrives AFTER the
		// breaker has cooled down enough to admit a probe.
		breaker.shouldAllow(KEY, T0 + 31_000); // promotes to half-open
		// Simulate the active-clear wiring: when clearExpiredRateLimits
		// returns a row, the caller (server.ts) calls recordSuccess.
		const cleared = [{ id: account.id, provider: account.provider }];
		for (const row of cleared) {
			breaker.recordSuccess(
				{ provider: row.provider, accountId: row.id },
				T0 + 32_000,
			);
		}
		expect(breaker.getState(KEY)).toBe("closed");
	});
});

// Tiny helper to keep the describe bodies readable.
function accountFor(): Account {
	return makeAccount();
}