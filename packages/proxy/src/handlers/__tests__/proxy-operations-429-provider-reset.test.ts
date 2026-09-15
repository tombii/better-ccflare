import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import type { Account, RequestMeta } from "@better-ccflare/types";
import { proxyWithAccount } from "../proxy-operations";
import type { ProxyContext } from "../proxy-types";
import { resetRateLimitProbeGatesForTests } from "../rate-limit-cooldown";

/**
 * A 429 with no `retry-after` must be benched for the window the account's own
 * provider parsed off the response, not the 60s "no reset hint" default. The
 * production case is Codex: OpenAI refuses on a spent WEEKLY window and says so
 * in `x-codex-secondary-reset-at`, days out, while the usage cache holds
 * nothing. A 60s bench put the account straight back in the auto-refresh
 * scheduler's eligibility query, which re-probed it every minute for 10 hours.
 *
 * Fixtures mirror `proxy-operations-5xx-failover.test.ts`. The one difference:
 * the account's provider name is deliberately NOT a registered one, so
 * `getProvider(account.provider)` misses and `proxyWithAccount` falls back to
 * the stub on `ctx.provider` — which is what lets the test control
 * `parseRateLimit`.
 */

const FOUR_DAYS_MS = 4 * 24 * 60 * 60 * 1000;

function makeAccount(overrides: Partial<Account> = {}): Account {
	return {
		id: "acc-429",
		name: "codex-like-test",
		provider: "stub-provider-429",
		api_key: "test-key",
		refresh_token: "",
		access_token: null,
		expires_at: null,
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

function makeRequestMeta(): RequestMeta {
	return {
		id: "req-429",
		method: "POST",
		path: "/v1/messages",
		timestamp: Date.now(),
		headers: new Headers(),
		clientSessionId: "sess-429",
	};
}

function makeRequestBody() {
	const body = JSON.stringify({
		model: "claude-sonnet-4-5",
		messages: [{ role: "user", content: "hello" }],
		max_tokens: 10,
	});
	return new TextEncoder().encode(body).buffer;
}

function makeProxyContext(
	parseRateLimit: () => {
		isRateLimited: boolean;
		resetTime: number | undefined;
	},
): ProxyContext {
	return {
		strategy: { getNextAccount: () => null } as never,
		dbOps: {
			markAccountRateLimited: mock(
				(_accountId: string, _until: number, _reason: string) =>
					Promise.resolve({ consecutiveRateLimits: 1, applied: true }),
			),
			saveRequest: mock((..._args: unknown[]) => Promise.resolve()),
			updateAccountUsage: mock(() => Promise.resolve()),
			updateAccountRateLimitMeta: mock((..._args: unknown[]) =>
				Promise.resolve(),
			),
			getAdapter: mock(() => ({
				run: mock(() => Promise.resolve()),
				get: mock(() => Promise.resolve(null)),
			})),
		} as never,
		runtime: { port: 8080, clientId: "test" } as never,
		provider: {
			name: "stub-provider-429",
			canHandle: () => true,
			buildUrl: () => "https://upstream.invalid/v1/messages",
			prepareHeaders: () => new Headers(),
			transformRequestBody: null,
			processResponse: async (r: Response) => r,
			parseRateLimit,
			isStreamingResponse: () => false,
		} as never,
		refreshInFlight: new Map(),
		asyncWriter: {
			enqueue: mock(async (job: () => void | Promise<void>) => {
				await job();
			}),
		} as never,
		config: { getStorePayloads: () => true } as never,
		internalProbeSecret: "test-secret",
	};
}

function makeRequest(body: ArrayBuffer) {
	return new Request("https://proxy.local/v1/messages", {
		method: "POST",
		body,
		headers: { "Content-Type": "application/json" },
	});
}

const rateLimitBody =
	'{"type":"error","error":{"type":"rate_limit_error","message":"quota exhausted"}}';

async function runProxy(
	account: Account,
	ctx: ProxyContext,
): Promise<Response | null> {
	const bodyBuffer = makeRequestBody();
	return proxyWithAccount(
		makeRequest(bodyBuffer),
		new URL("https://proxy.local/v1/messages"),
		account,
		makeRequestMeta(),
		bodyBuffer,
		() => undefined,
		0,
		ctx,
		undefined,
		undefined,
		undefined,
		undefined,
		false,
	);
}

describe("proxyWithAccount — 429 bench honours the provider-parsed reset", () => {
	let originalFetch: typeof globalThis.fetch;

	beforeEach(() => {
		originalFetch = globalThis.fetch;
		// The exponential 429 ramp (`min(resetTime, now + backoff)` in
		// applyRateLimitCooldown) would otherwise clamp every bench here to
		// 30s-5min and hide the difference this test is about. Widening it past
		// both candidate durations isolates extractCooldownUntil's contribution.
		process.env.CCFLARE_RATE_LIMIT_BACKOFF_BASE_MS = String(
			30 * 24 * 60 * 60 * 1000,
		);
		process.env.CCFLARE_RATE_LIMIT_BACKOFF_MAX_MS = String(
			30 * 24 * 60 * 60 * 1000,
		);
		resetRateLimitProbeGatesForTests();
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
		delete process.env.CCFLARE_RATE_LIMIT_BACKOFF_BASE_MS;
		delete process.env.CCFLARE_RATE_LIMIT_BACKOFF_MAX_MS;
		resetRateLimitProbeGatesForTests();
	});

	it("benches until the provider-reported window reset and fails over", async () => {
		const resetTime = Date.now() + FOUR_DAYS_MS;
		globalThis.fetch = mock(
			async () =>
				new Response(rateLimitBody, {
					status: 429,
					headers: { "content-type": "application/json" },
				}),
		);

		const ctx = makeProxyContext(() => ({
			isRateLimited: true,
			resetTime,
		}));
		const account = makeAccount();

		const result = await runProxy(account, ctx);

		expect(result).toBeNull();
		expect(account.rate_limited_reason).toBe("model_fallback_429");
		expect(account.rate_limited_until ?? 0).toBeGreaterThanOrEqual(
			resetTime - 5_000,
		);
		expect(account.rate_limited_until ?? 0).toBeLessThanOrEqual(
			resetTime + 5_000,
		);
	});

	it("keeps the 60s default when the provider reports no reset", async () => {
		const before = Date.now();
		globalThis.fetch = mock(
			async () =>
				new Response(rateLimitBody, {
					status: 429,
					headers: { "content-type": "application/json" },
				}),
		);

		const ctx = makeProxyContext(() => ({
			isRateLimited: false,
			resetTime: undefined,
		}));
		const account = makeAccount();

		const result = await runProxy(account, ctx);

		expect(result).toBeNull();
		expect(account.rate_limited_reason).toBe("model_fallback_429");
		expect(account.rate_limited_until ?? 0).toBeGreaterThanOrEqual(
			before + 60_000 - 5_000,
		);
		expect(account.rate_limited_until ?? 0).toBeLessThanOrEqual(
			Date.now() + 60_000 + 5_000,
		);
	});
});
