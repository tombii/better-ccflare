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
import type { Account } from "@better-ccflare/types";
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
