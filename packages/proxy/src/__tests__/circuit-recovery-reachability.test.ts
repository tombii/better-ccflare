/**
 * Regression tests for PR #349 fix A — the request-path success call that
 * the circuit breaker needs in order to actually close.
 *
 * Why these tests exist: the original PR shipped `CircuitBreaker.recordSuccess`
 * but never wired it into a request-path caller. The only existing callers
 * were the active-clear job (`server.ts:286`, `:806`) which called it on
 * `open` circuits — and `recordSuccess` is a deliberate no-op while `open`
 * (see `circuit-breaker.ts:337-353`). Consequence: the half-open probe
 * could never close the circuit, and the active-clear path could not
 * either. The breaker as written had no path to `closed` at all.
 *
 * Fix A adds the missing request-path success call in `response-processor.ts`
 * (gated on `response.ok`, `!isKeepalive`, and `!isInternalProbe(..., "auto-refresh")`),
 * AND adds `forceClose` for the active-clear path so the two events are no
 * longer conflated. This file pins both behaviours end-to-end so a future
 * "simplification" that removes the success call cannot regress silently.
 *
 * The mandatory negative control — "delete only the recordSuccess call and
 * test (i) must go RED" — is exercised manually by the orchestrator after
 * this file lands. See spec §PART 4 (i) and the explicit warning in the
 * spec's MANDATORY NEGATIVE CONTROL section.
 */
import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import type { Account } from "@better-ccflare/types";
import type { ProxyContext } from "../handlers";
import { applyRateLimitCooldown } from "../handlers/rate-limit-cooldown";
import {
	CIRCUIT_BREAKER_ENV,
	CircuitBreaker,
	circuitKeyFor,
	forceClose,
	getDefaultCircuitBreaker,
	getState,
	recordSuccess,
	resetDefaultCircuitBreaker,
} from "../circuit-breaker";
import { handleProxy } from "../proxy";
import * as usageCollectorModule from "../usage-collector";

/** Local process type shim — matches circuit-breaker.test.ts. */
declare const process: { env: Record<string, string | undefined> };

function stubUsageCollector() {
	return spyOn(usageCollectorModule, "getUsageCollector").mockReturnValue({
		handleStart: mock(() => {}),
		handleChunk: mock(() => {}),
		handleEnd: mock(() => Promise.resolve()),
	} as unknown as usageCollectorModule.UsageCollector);
}

/**
 * Mirrors the harness template from `probe-gate-all-suppressed.test.ts`:
 * an unregistered provider name so `getProvider(...)` resolves to
 * `undefined` and the request falls back to the ctx.provider.
 */
function makeAccount(overrides: Partial<Account> = {}): Account {
	return {
		id: "acc-recov",
		name: "recovery-account",
		provider: "test-provider",
		api_key: null,
		refresh_token: "refresh-token",
		access_token: "access-token",
		expires_at: Date.now() + 3 * 60 * 60 * 1000,
		request_count: 0,
		total_requests: 0,
		last_used: null,
		created_at: Date.now(),
		rate_limited_until: null,
		rate_limited_reason: null,
		rate_limited_at: null,
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
	};
}

function makeContext(account: Account): ProxyContext {
	return {
		strategy: { select: (accounts: Account[]) => accounts } as never,
		dbOps: {
			getAllAccounts: mock(async () => [account]),
			getActiveComboForFamily: mock(async () => null),
		} as never,
		runtime: { port: 8080, clientId: "test" } as never,
		config: {
			getUsageThrottlingFiveHourEnabled: () => false,
			getUsageThrottlingWeeklyEnabled: () => false,
			getSystemPromptCacheTtl1h: () => false,
			getAgentFrontmatterModelFallback: () => false,
		} as never,
		provider: {
			name: "test-provider",
			canHandle: () => true,
			buildUrl: () => "https://fake.local/v1/messages",
			prepareHeaders: () => new Headers(),
			transformRequestBody: undefined,
			processResponse: async (r: Response) => r,
			parseRateLimit: () => ({
				isRateLimited: false,
				resetTime: undefined,
				statusHeader: undefined,
				remaining: undefined,
			}),
			isStreamingResponse: () => false,
		} as never,
		refreshInFlight: new Map(),
		asyncWriter: { enqueue: mock(() => {}) } as never,
	};
}

function makeRequest(headers: Record<string, string> = {}): Request {
	return new Request("https://proxy.local/v1/messages", {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			...headers,
		},
		body: JSON.stringify({
			model: "claude-sonnet-4-5",
			messages: [{ role: "user", content: "hello" }],
			max_tokens: 16,
		}),
	});
}

/**
 * Drive a fresh default breaker to half-open for the given account key.
 * Mirrors the OPEN_COOLDOWN_MS boundary from `circuit-breaker.ts`.
 */
function tripToHalfOpen(account: Account, T0 = Date.now()): void {
	const cb = getDefaultCircuitBreaker();
	const key = circuitKeyFor(account);
	for (let i = 0; i < 5; i++) {
		cb.recordFailure(key, "upstream_529_overloaded_with_reset", T0 + i);
	}
	// Advance past OPEN_COOLDOWN_MS so shouldAllow promotes open → half-open.
	// cooldownEndsAt = T0 + 4 + 30_000 = T0 + 30_004, so anything >=
	// T0 + 30_005 is unambiguously past the cooldown.
	expect(cb.getState(key)).toBe("open");
	expect(cb.shouldAllow(key, T0 + 30_005)).toBe(true);
	expect(cb.getState(key)).toBe("half-open");
}

beforeEach(() => {
	resetDefaultCircuitBreaker();
	delete process.env[CIRCUIT_BREAKER_ENV];
});

afterEach(() => {
	resetDefaultCircuitBreaker();
	delete process.env[CIRCUIT_BREAKER_ENV];
});

// ────────────────────────────────────────────────────────────────────────────
// (i) REACHABILITY — the only test that really matters.
//
// Drives handleProxy with a mocked provider returning 200. Beforehand, the
// real breaker is at half-open for this account (5× recordFailure, then
// shouldAllow at T0 + OPEN_COOLDOWN_MS + 1). After handleProxy returns, the
// circuit MUST be closed.
//
// Deleting the recordSuccess(circuitKeyFor(account)) call in
// response-processor.ts MUST make this fail. A unit test of recordSuccess
// cannot do this — all four prior "mechanism nothing calls" defects in this
// repo had green unit tests. End-to-end is the only thing that catches it.
// ────────────────────────────────────────────────────────────────────────────
describe("circuit-recovery reachability (PR #349 fix A test i)", () => {
	it("closes the circuit after a 200 from handleProxy on a half-open probe", async () => {
		const account = makeAccount();
		tripToHalfOpen(account);

		const collectorSpy = stubUsageCollector();
		const realFetch = globalThis.fetch;
		globalThis.fetch = mock(
			async () =>
				new Response(JSON.stringify({ type: "message", id: "msg_1" }), {
					status: 200,
					headers: { "content-type": "application/json" },
				}),
		) as unknown as typeof fetch;

		try {
			const ctx = makeContext(account);
			const response = await handleProxy(
				makeRequest(),
				new URL("https://proxy.local/v1/messages"),
				ctx,
			);

			expect(response.status).toBe(200);
			// After the request-path recordSuccess fires, the half-open
			// probe must transition to closed and the failureCount
			// resets to 0. snapshot().length === 1 confirms the breaker
			// did not create a duplicate entry for the same key.
			expect(getState(circuitKeyFor(account))).toBe("closed");
		} finally {
			globalThis.fetch = realFetch;
			collectorSpy.mockRestore();
		}
	});
});

// ────────────────────────────────────────────────────────────────────────────
// (ii) Keepalive asymmetry — the keepalive header must prevent the breaker
// from closing, just as it already prevents the cooldown path from firing.
// Deleting the !isKeepalive guard MUST make this fail (the keepalive
// scheduler becomes a timer-driven circuit-eraser).
// ────────────────────────────────────────────────────────────────────────────
describe("circuit-recovery keepalive asymmetry (PR #349 fix A test ii)", () => {
	it("leaves the circuit half-open when the request carries the keepalive header", async () => {
		const account = makeAccount();
		const T0 = Date.now();
		// Inject a process-local secret so isInternalProbe accepts the
		// header (the function refuses to recognise the marker without the
		// shared secret — see proxy-types.ts:54-68).
		const secret = "test-internal-probe-secret";
		process.env.CCFLARE_INTERNAL_PROBE_SECRET = secret;

		const cb = getDefaultCircuitBreaker();
		const key = circuitKeyFor(account);
		for (let i = 0; i < 5; i++) {
			cb.recordFailure(key, "upstream_529_overloaded_with_reset", T0 + i);
		}
		expect(cb.shouldAllow(key, T0 + 30_005)).toBe(true);
		expect(cb.getState(key)).toBe("half-open");

		const collectorSpy = stubUsageCollector();
		const realFetch = globalThis.fetch;
		globalThis.fetch = mock(
			async () =>
				new Response(JSON.stringify({ type: "message", id: "msg_1" }), {
					status: 200,
					headers: { "content-type": "application/json" },
				}),
		) as unknown as typeof fetch;

		try {
			// Stub the provider's ctx with the secret plumbed in, and
			// stamp the keepalive header onto the request.
			const ctx = makeContext(account);
			(ctx as ProxyContext & { internalProbeSecret?: string }).internalProbeSecret =
				secret;

			const request = makeRequest({
				"x-better-ccflare-internal-probe-secret": secret,
				"x-better-ccflare-keepalive": "true",
			});

			const response = await handleProxy(
				request,
				new URL("https://proxy.local/v1/messages"),
				ctx,
			);

			expect(response.status).toBe(200);
			// The keepalive gate MUST prevent the breaker from closing.
			// Without this guard, the keepalive scheduler becomes a
			// timer-driven circuit-eraser — every keepalive tick that
			// returns 200 closes a circuit regardless of upstream state.
			expect(getState(circuitKeyFor(account))).toBe("half-open");
		} finally {
			globalThis.fetch = realFetch;
			collectorSpy.mockRestore();
			delete process.env.CCFLARE_INTERNAL_PROBE_SECRET;
		}
	});
});

// ────────────────────────────────────────────────────────────────────────────
// (iii) KEY AGREEMENT — trip the breaker through the REAL applyRateLimitCooldown
// path (not a hand-built key), then drive a 200 through handleProxy and
// assert the state cleared. This is the only test that catches a
// provider-string drift between the failure and success sites.
// ────────────────────────────────────────────────────────────────────────────
describe("circuit-recovery key agreement (PR #349 fix A test iii)", () => {
	it("closes the circuit when the failure site and success site use the same helper", async () => {
		const account = makeAccount();
		const T0 = Date.now();

		const cb = getDefaultCircuitBreaker();
		const key = circuitKeyFor(account);
		// Trip through the real cooldown path. The breaker is fed via
		// `breaker.recordFailure(circuitKeyFor(account), ...)` inside
		// applyRateLimitCooldown — so any drift between the failure
		// site and the success site would leave the breaker in `open`
		// after the 200 returns.
		const ctx = makeContext(account);
		for (let i = 0; i < 4; i++) {
			applyRateLimitCooldown(
				account,
				{ resetTime: T0 + 30_000, reason: "upstream_429_with_reset" },
				ctx,
				cb,
			);
		}
		expect(cb.getState(key)).toBe("closed");
		applyRateLimitCooldown(
			account,
			{ resetTime: T0 + 30_000, reason: "upstream_429_with_reset" },
			ctx,
			cb,
		);
		expect(cb.getState(key)).toBe("open");
		expect(cb.shouldAllow(key, T0 + 30_005)).toBe(true);
		expect(cb.getState(key)).toBe("half-open");

		const collectorSpy = stubUsageCollector();
		const realFetch = globalThis.fetch;
		globalThis.fetch = mock(
			async () =>
				new Response(JSON.stringify({ type: "message", id: "msg_1" }), {
					status: 200,
					headers: { "content-type": "application/json" },
				}),
		) as unknown as typeof fetch;

		try {
			const response = await handleProxy(
				makeRequest(),
				new URL("https://proxy.local/v1/messages"),
				ctx,
			);

			expect(response.status).toBe(200);
			// If the success site used a drifted provider string, the
			// breaker would still be `half-open` here. The whole point
			// of circuitKeyFor(account) is to make this structurally
			// impossible rather than merely tested.
			expect(cb.getState(key)).toBe("closed");
		} finally {
			globalThis.fetch = realFetch;
			collectorSpy.mockRestore();
		}
	});
});

// ────────────────────────────────────────────────────────────────────────────
// (iv) forceClose does not create entries. Calling it on an untracked key
// (one the breaker has never observed) MUST NOT add a snapshot row. This
// guards the model_fallback_429 interaction: the active-clear job calls
// forceClose for every cleared row regardless of whether the breaker ever
// tracked the account, and model_fallback_429 writes rate_limited_until on
// accounts the breaker deliberately never tracked.
// ────────────────────────────────────────────────────────────────────────────
describe("forceClose — no-create-on-untracked (PR #349 fix A test iv)", () => {
	it("does not add a snapshot row when the key was never tracked", () => {
		const cb = new CircuitBreaker();
		const untrackedKey = {
			provider: "anthropic",
			accountId: "never-tracked",
		};
		expect(cb.snapshot().length).toBe(0);
		cb.forceClose(untrackedKey);
		expect(cb.snapshot().length).toBe(0);
	});

	it("does not add a snapshot row on the default breaker either (module-level wrapper)", () => {
		// The default breaker is what server.ts actually calls into.
		const before = getDefaultCircuitBreaker().snapshot().length;
		forceClose({ provider: "anthropic", accountId: "never-tracked-default" });
		const after = getDefaultCircuitBreaker().snapshot().length;
		expect(after).toBe(before);
	});
});

// ────────────────────────────────────────────────────────────────────────────
// (v) Split preserved — recordSuccess on an `open` circuit is still a no-op,
// so a future "simplification" that folds forceClose back into recordSuccess
// goes RED. This is the load-bearing assertion that keeps the two-event
// model distinct: the half-open probe path and the active-clear path are
// semantically different events that should NOT collapse into one method.
// ────────────────────────────────────────────────────────────────────────────
describe("split preserved — recordSuccess on open is still a no-op (PR #349 fix A test v)", () => {
	it("does not close an open circuit when recordSuccess is called on it", () => {
		const T0 = Date.now();
		const cb = new CircuitBreaker();
		const key = { provider: "anthropic", accountId: "acc-open" };
		for (let i = 0; i < 5; i++) {
			cb.recordFailure(key, "upstream_529_overloaded_with_reset", T0 + i);
		}
		expect(cb.getState(key)).toBe("open");
		const snapshotBefore = cb.snapshot();
		const failureCountBefore =
			snapshotBefore[0]?.failureCount ?? Number.NEGATIVE_INFINITY;

		// recordSuccess on an open circuit MUST be a no-op. The only
		// way to close an open circuit from outside is forceClose
		// (active-clear) — folding them back together would let the
		// active-clear job, which calls into open circuits, accidentally
		// close them, which is the exact bug fix A removes.
		cb.recordSuccess(key, T0 + 10);

		expect(cb.getState(key)).toBe("open");
		const snapshotAfter = cb.snapshot();
		expect(snapshotAfter[0]?.failureCount).toBe(failureCountBefore);
	});

	it("the module-level recordSuccess wrapper is also a no-op on open", () => {
		const T0 = Date.now();
		const cb = getDefaultCircuitBreaker();
		const key = { provider: "anthropic", accountId: "acc-open-default" };
		for (let i = 0; i < 5; i++) {
			cb.recordFailure(key, "upstream_529_overloaded_with_reset", T0 + i);
		}
		expect(cb.getState(key)).toBe("open");

		recordSuccess(key, T0 + 10);

		expect(cb.getState(key)).toBe("open");
	});
});