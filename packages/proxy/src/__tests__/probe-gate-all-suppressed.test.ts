/**
 * Regression test for delta-internal-1: the reason-aware single-flight probe
 * gate (rate-limit-cooldown.ts) arms for ANY expired 529 cooldown, not just a
 * mature 429 streak. When a pool has exactly one candidate account and that
 * account's probe lease is already held by another in-flight request, the
 * account loop in proxy.ts used to `continue` past the only candidate and
 * fall through to a hard `ALL_ACCOUNTS_FAILED` / 503 — even though the
 * account's cooldown had already expired and the request could simply have
 * been attempted. The gate's purpose is to prefer another account over
 * stampeding one that just recovered, not to drop the request when there is
 * no other account to prefer.
 */
import { afterEach, describe, expect, it, mock, spyOn } from "bun:test";
import type { Account, ComboWithSlots } from "@better-ccflare/types";
import type { ProxyContext } from "../handlers";
import {
	getRateLimitProbeAdmission,
	resetRateLimitProbeGatesForTests,
} from "../handlers/rate-limit-cooldown";
import { handleProxy } from "../proxy";
import * as usageCollectorModule from "../usage-collector";

function stubUsageCollector() {
	return spyOn(usageCollectorModule, "getUsageCollector").mockReturnValue({
		handleStart: mock(() => {}),
		handleChunk: mock(() => {}),
		handleEnd: mock(() => Promise.resolve()),
	} as unknown as usageCollectorModule.UsageCollector);
}

/**
 * A fully-mocked, unregistered provider name ("test-provider") so
 * `getProvider(account.provider)` in proxy-operations.ts resolves to
 * `undefined` and falls back to `ctx.provider` — same trick as
 * auto-refresh-throttle-exemption.test.ts, giving the test full,
 * deterministic control over header prep / response processing.
 */
function makeAccount(overrides: Partial<Account> = {}): Account {
	return {
		id: "acc-1",
		name: "sole-account",
		provider: "test-provider",
		api_key: null,
		refresh_token: "refresh-token",
		access_token: "access-token",
		// Comfortably beyond TOKEN_SAFETY_WINDOW_MS so getValidAccessToken
		// returns the access token directly without a network refresh.
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

function makeRequest(): Request {
	return new Request("https://proxy.local/v1/messages", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			model: "claude-sonnet-4-5",
			messages: [{ role: "user", content: "hello" }],
			max_tokens: 16,
		}),
	});
}

describe("handleProxy — every candidate probe-gate suppressed (delta-internal-1)", () => {
	afterEach(() => {
		resetRateLimitProbeGatesForTests();
	});

	it("retries the sole account ungated instead of failing with ALL_ACCOUNTS_FAILED", async () => {
		const now = Date.now();
		const account = makeAccount({
			rate_limited_until: now - 1,
			rate_limited_reason: "upstream_529_overloaded_no_reset",
		});

		// Simulate a concurrent request ("Request A") that already admitted the
		// single-flight probe for this account: its cooldown expired (the
		// expiredMatureCooldown predicate is satisfied via the overload reason
		// alone, per getRateLimitProbeAdmission's doc comment), but the gate is
		// armed and a lease is already held by that other in-flight request —
		// the exact state a real concurrent Request A would leave behind.
		expect(getRateLimitProbeAdmission(account)).toBe("admitted");

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
			// "Request B": the account loop's only candidate is suppressed by the
			// gate. Before the fix this fell straight through to a thrown
			// ServiceUnavailableError (mapped to a hard 503 by the server) even
			// though the account's cooldown had already expired and there was no
			// other account to prefer over it.
			const response = await handleProxy(
				makeRequest(),
				new URL("https://proxy.local/v1/messages"),
				ctx,
			);

			expect(response.status).toBe(200);
		} finally {
			globalThis.fetch = realFetch;
			collectorSpy.mockRestore();
		}
	});
});

/**
 * Regression test for delta2-1: the ungated retry copied the loop's
 * last-account expression `i === accounts.length - 1` while hard-coding
 * `i = 0`, so `returnRateLimitedResponseOnExhaustion` was `false` for every
 * pool with more than one candidate — a final upstream 529 on the ungated
 * retry was swallowed into a generic 503 instead of being forwarded, even
 * though the retry IS the request's terminal attempt by construction.
 */
describe("handleProxy — multi-account all-suppressed pool forwards a terminal 529 (delta2-1)", () => {
	afterEach(() => {
		resetRateLimitProbeGatesForTests();
	});

	it("forwards the ungated retry's final 529 instead of falling through to a generic 503", async () => {
		const now = Date.now();
		const accountOne = makeAccount({
			id: "acc-1",
			name: "account-one",
			rate_limited_until: now - 1,
			rate_limited_reason: "upstream_529_overloaded_no_reset",
		});
		const accountTwo = makeAccount({
			id: "acc-2",
			name: "account-two",
			rate_limited_until: now - 1,
			rate_limited_reason: "upstream_529_overloaded_no_reset",
		});

		// Simulate two concurrent in-flight requests ("Request A" for each
		// account) that already admitted the single-flight probe, leaving both
		// accounts' leases held — the exact state a 529 burst leaves behind for
		// an N-account pool.
		expect(getRateLimitProbeAdmission(accountOne)).toBe("admitted");
		expect(getRateLimitProbeAdmission(accountTwo)).toBe("admitted");

		const collectorSpy = stubUsageCollector();
		const realFetch = globalThis.fetch;
		globalThis.fetch = mock(
			async () =>
				new Response(
					JSON.stringify({
						type: "error",
						error: { type: "overloaded_error", message: "Overloaded" },
					}),
					{
						status: 529,
						headers: { "content-type": "application/json" },
					},
				),
		) as unknown as typeof fetch;

		try {
			const ctx: ProxyContext = {
				strategy: { select: (accounts: Account[]) => accounts } as never,
				dbOps: {
					getAllAccounts: mock(async () => [accountOne, accountTwo]),
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
					// The ungated retry against accountOne is the only
					// proxyWithAccount call in this scenario (both loop
					// iterations `continue` past the suppressed candidates), so a
					// constant true is unambiguous here.
					parseRateLimit: () => ({
						isRateLimited: true,
						resetTime: undefined,
						statusHeader: undefined,
						remaining: undefined,
					}),
					isStreamingResponse: () => false,
				} as never,
				refreshInFlight: new Map(),
				asyncWriter: { enqueue: mock(() => {}) } as never,
			};

			// "Request C": both candidates are probe-gate suppressed. The main
			// loop's ungated retry (proxy.ts:506-534) attacks accountOne
			// (accounts[0]) and — mid-storm — gets the same 529 back.
			const response = await handleProxy(
				makeRequest(),
				new URL("https://proxy.local/v1/messages"),
				ctx,
			);

			// Before the delta2-1 fix: returnRateLimitedResponseOnExhaustion was
			// hard-coded false for accounts.length > 1, so this terminal 529 was
			// swallowed into a generic 503 service_unavailable_error instead of
			// being forwarded — the client saw a ccflare pool failure instead of
			// Anthropic's own overloaded_error body.
			expect(response.status).toBe(529);
		} finally {
			globalThis.fetch = realFetch;
			collectorSpy.mockRestore();
		}
	});
});

/**
 * Regression test for delta2-6: the combo-fallback ungated retry
 * (proxy.ts's Step-10 "all fallback candidate(s) were probe-gate
 * suppressed" block, :605-629) had no test at all — only the main-loop
 * ungated retry (above) was exercised. A refactor that deletes or breaks
 * that second block would keep this suite green while combo-routed
 * requests regressed back to the original delta-internal-1 hard 503.
 */
describe("handleProxy — combo-fallback pool all-suppressed retries ungated (delta2-6)", () => {
	afterEach(() => {
		resetRateLimitProbeGatesForTests();
	});

	it("retries the Step-10 fallback pool's sole candidate ungated instead of falling through to a generic 503", async () => {
		const now = Date.now();

		// The combo's sole slot account. It gets a normal (non-suppressed)
		// attempt in the main combo loop and fails with a 429 — ordinary
		// quota exhaustion, unrelated to the probe gate — which drives Step
		// 10's fallback re-selection. It deliberately does NOT reappear in the
		// fallback pool below (see the call-count-aware getAllAccounts mock):
		// this test isolates the fallback pool's own ungated-retry block from
		// Step 10's account-selection mechanics, which are covered separately
		// in proxy-model-capacity.test.ts.
		const comboAccount = makeAccount({
			id: "combo-acc-a",
			name: "combo-account-a",
		});

		// The Step-10 fallback pool's sole candidate. Its probe lease is
		// already held by a simulated concurrent request ("Request A") before
		// the fallback loop ever sees it, so its first-ever attempt happens
		// through the ungated retry under test.
		const fallbackAccount = makeAccount({
			id: "fallback-acc-b",
			name: "fallback-account-b",
			rate_limited_until: now - 1,
			rate_limited_reason: "upstream_529_overloaded_no_reset",
		});
		expect(getRateLimitProbeAdmission(fallbackAccount)).toBe("admitted");

		const combo: ComboWithSlots = {
			id: "combo-1",
			name: "delta2-6 combo",
			description: null,
			enabled: true,
			created_at: Date.now(),
			updated_at: Date.now(),
			slots: [
				{
					id: "slot-1",
					combo_id: "combo-1",
					account_id: comboAccount.id,
					model: "claude-sonnet-4-5",
					priority: 0,
					enabled: true,
				},
			],
		};

		const collectorSpy = stubUsageCollector();
		const realFetch = globalThis.fetch;
		let fetchCallCount = 0;
		globalThis.fetch = mock(async () => {
			fetchCallCount++;
			// Call 1: the combo main loop's normal (non-suppressed) attempt on
			// comboAccount — an ordinary 429 that fails the sole combo slot and
			// drives Step 10's fallback re-selection.
			if (fetchCallCount === 1) {
				return new Response(
					JSON.stringify({
						type: "error",
						error: { type: "rate_limit_error", message: "Rate limited" },
					}),
					{ status: 429, headers: { "content-type": "application/json" } },
				);
			}
			// Call 2: the Step-10 fallback pool's ungated retry (the block under
			// test) — fallbackAccount has recovered.
			return new Response(JSON.stringify({ type: "message", id: "msg_1" }), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		}) as unknown as typeof fetch;

		try {
			// getAllAccounts is called twice: once by the initial combo lookup
			// (must resolve comboAccount as the slot member) and once by Step
			// 10's skipCombo re-selection (must return fallbackAccount as the
			// only candidate).
			let getAllAccountsCallCount = 0;
			const ctx: ProxyContext = {
				strategy: { select: (accounts: Account[]) => accounts } as never,
				dbOps: {
					getAllAccounts: mock(async () => {
						getAllAccountsCallCount++;
						return getAllAccountsCallCount === 1
							? [comboAccount]
							: [fallbackAccount];
					}),
					getActiveComboForFamily: mock(async () => combo),
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
					parseRateLimit: (response: Response) => ({
						isRateLimited: response.status === 429 || response.status === 529,
						resetTime: undefined,
						statusHeader: undefined,
						remaining: undefined,
					}),
					isStreamingResponse: () => false,
				} as never,
				refreshInFlight: new Map(),
				asyncWriter: { enqueue: mock(() => {}) } as never,
			};

			const response = await handleProxy(
				makeRequest(),
				new URL("https://proxy.local/v1/messages"),
				ctx,
			);

			// Before a hypothetical regression of proxy.ts:605-629: the sole
			// fallback candidate would `continue` past the probe-gate
			// suppression check, anyFallbackAttempted would stay false, and
			// control would fall through to a generic 503
			// service_unavailable_error instead of retrying the recovered
			// account.
			expect(response.status).toBe(200);
			expect(fetchCallCount).toBe(2);
		} finally {
			globalThis.fetch = realFetch;
			collectorSpy.mockRestore();
		}
	});
});

/**
 * Regression test for delta3-2: the ungated-retry blocks (fixed under
 * delta2-1, above) correctly compute `returnRateLimitedResponseOnExhaustion`
 * for the retry-after-all-suppressed path, but the main loop's OWN
 * `proxyWithAccount` calls still derived the flag from the loop index
 * (`i === accounts.length - 1`). That index is wrong whenever a LATER
 * candidate is probe-gate suppressed and skipped via `continue`: the
 * account actually being attempted is then the last one that will ever run,
 * even though its index isn't the pool's last index — so its final 529 was
 * swallowed into a generic 503 instead of being forwarded.
 */
describe("handleProxy — front candidate attempted, later candidate suppressed (delta3-2)", () => {
	afterEach(() => {
		resetRateLimitProbeGatesForTests();
	});

	it("forwards account A's final 529 instead of falling through to a generic 503 when trailing account B is probe-gate suppressed", async () => {
		const now = Date.now();
		// Account A: no rate-limit history at all, so the gate never arms for
		// it (getRateLimitProbeAdmission returns "not_required") — it is
		// attempted normally as the loop's first (and, per this scenario,
		// only actually-attempted) candidate.
		const accountA = makeAccount({
			id: "acc-a",
			name: "account-a",
		});
		// Account B: an expired overload cooldown with its single-flight probe
		// lease already held by a simulated concurrent request ("Request A"),
		// so the loop's second iteration hits the gate and `continue`s past it
		// without ever calling proxyWithAccount for it.
		const accountB = makeAccount({
			id: "acc-b",
			name: "account-b",
			rate_limited_until: now - 1,
			rate_limited_reason: "upstream_529_overloaded_no_reset",
		});
		expect(getRateLimitProbeAdmission(accountB)).toBe("admitted");

		const collectorSpy = stubUsageCollector();
		const realFetch = globalThis.fetch;
		// Disable the unrelated in-place 529 retry (proxy-operations.ts) so
		// this test isolates the terminal-flag computation under test — with
		// it enabled, account A's first 529 triggers one additional in-place
		// retry fetch before the (still 529) response reaches the terminal
		// check, which is legitimate existing behavior but not what this
		// regression test is about.
		const realOverloadRetryEnabled = process.env.CCFLARE_OVERLOAD_RETRY_ENABLED;
		process.env.CCFLARE_OVERLOAD_RETRY_ENABLED = "false";
		let fetchCallCount = 0;
		globalThis.fetch = mock(async () => {
			fetchCallCount++;
			return new Response(
				JSON.stringify({
					type: "error",
					error: { type: "overloaded_error", message: "Overloaded" },
				}),
				{ status: 529, headers: { "content-type": "application/json" } },
			);
		}) as unknown as typeof fetch;

		try {
			const ctx: ProxyContext = {
				strategy: { select: (accounts: Account[]) => accounts } as never,
				dbOps: {
					getAllAccounts: mock(async () => [accountA, accountB]),
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
						isRateLimited: true,
						resetTime: undefined,
						statusHeader: undefined,
						remaining: undefined,
					}),
					isStreamingResponse: () => false,
				} as never,
				refreshInFlight: new Map(),
				asyncWriter: { enqueue: mock(() => {}) } as never,
			};

			const response = await handleProxy(
				makeRequest(),
				new URL("https://proxy.local/v1/messages"),
				ctx,
			);

			// Before the delta3-2 fix: `i === accounts.length - 1` was `0 === 1`
			// (false) for account A's attempt, so its terminal 529 was treated
			// as non-terminal, returned null, and the loop moved on — landing on
			// the suppressed accountB via `continue`, exhausting the pool, and
			// throwing a generic 503 service_unavailable_error instead of
			// forwarding Anthropic's own overloaded_error body.
			expect(response.status).toBe(529);
			expect(fetchCallCount).toBe(1);
		} finally {
			globalThis.fetch = realFetch;
			if (realOverloadRetryEnabled === undefined) {
				delete process.env.CCFLARE_OVERLOAD_RETRY_ENABLED;
			} else {
				process.env.CCFLARE_OVERLOAD_RETRY_ENABLED = realOverloadRetryEnabled;
			}
			collectorSpy.mockRestore();
		}
	});
});
