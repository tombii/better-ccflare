import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	mock,
	setSystemTime,
} from "bun:test";
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
		resetIsInferred?: boolean;
	},
	parseRateLimitFromBody?: (response: Response) => Promise<number | undefined>,
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
			...(parseRateLimitFromBody ? { parseRateLimitFromBody } : {}),
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

// The 1ms-backoff assertions expect the deadline to be `now + 1ms`. Against the
// real clock, a test that finishes the await more than 1ms later reads a
// negative remainder and fails on correct behaviour, so these tests freeze the
// clock (`setSystemTime`) and drive it forward themselves. The frozen clock is
// restored in `afterEach`.
const FROZEN_NOW = 1_800_000_000_000;

async function runProxyAtFrozenTime(
	account: Account,
	ctx: ProxyContext,
	advanceMs = 0,
): Promise<Response | null> {
	setSystemTime(FROZEN_NOW);
	const result = await runProxy(account, ctx);
	setSystemTime(FROZEN_NOW + advanceMs);
	return result;
}

const BACKOFF_ENV_VARS = [
	"CCFLARE_RATE_LIMIT_BACKOFF_BASE_MS",
	"CCFLARE_RATE_LIMIT_BACKOFF_MAX_MS",
	"CCFLARE_RATE_LIMIT_HONOR_EXPLICIT_RESET",
] as const;

describe("proxyWithAccount — 429 bench honours the provider-parsed reset", () => {
	let originalFetch: typeof globalThis.fetch;
	// A developer may have these exported in their own shell; restore whatever
	// was there rather than deleting the variables outright.
	let originalBackoffEnv: Record<string, string | undefined> = {};

	beforeEach(() => {
		originalFetch = globalThis.fetch;
		originalBackoffEnv = Object.fromEntries(
			BACKOFF_ENV_VARS.map((name) => [name, process.env[name]]),
		);
		// The 429 cooldown now honours an explicit reset directly. These env
		// vars stay wide so a regression back to the old
		// `min(resetTime, now + ramp)` formula fails the upper bound instead of
		// silently passing with a ramp that happens to match the reset.
		process.env.CCFLARE_RATE_LIMIT_BACKOFF_BASE_MS = String(
			30 * 24 * 60 * 60 * 1000,
		);
		process.env.CCFLARE_RATE_LIMIT_BACKOFF_MAX_MS = String(
			30 * 24 * 60 * 60 * 1000,
		);
		// Pin the switch these tests rely on: they assert that a real upstream
		// reset wins over the (deliberately wide) ramp. A developer with the
		// documented opt-out exported would otherwise clamp the reset and fail
		// them. The tests that exercise the switch off set it themselves.
		process.env.CCFLARE_RATE_LIMIT_HONOR_EXPLICIT_RESET = "true";
		resetRateLimitProbeGatesForTests();
	});

	afterEach(() => {
		setSystemTime();
		globalThis.fetch = originalFetch;
		for (const name of BACKOFF_ENV_VARS) {
			const previous = originalBackoffEnv[name];
			if (previous === undefined) {
				delete process.env[name];
			} else {
				process.env[name] = previous;
			}
		}
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

	it("keeps the backoff ramp when the provider reports no reset", async () => {
		// #506: a 429 naming no reset falls through to our own 60s default
		// (`source: "default"`). That default is not the account's window, so it
		// must stay on the adaptive ramp — 30 days here, so a regression back to
		// benching until the default is unmistakable. The honour-explicit-reset
		// switch is pinned on: even then, an invented deadline is not upstream.
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
		const benchMs = (account.rate_limited_until ?? 0) - Date.now();
		expect(benchMs).toBeGreaterThan(FOUR_DAYS_MS);
		expect(account.rate_limited_until ?? 0).toBeLessThanOrEqual(
			before + 30 * 24 * 60 * 60 * 1000 + 5_000,
		);
	});

	it("leaves a header-less 429 on a 1ms ramp when the backoff is disabled", async () => {
		// The reproduction from #506: with the ramp configured effectively off,
		// a 429 that names no window must not bench the account for the 60s
		// default.
		process.env.CCFLARE_RATE_LIMIT_BACKOFF_BASE_MS = "1";
		process.env.CCFLARE_RATE_LIMIT_BACKOFF_MAX_MS = "1";
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

		const result = await runProxyAtFrozenTime(account, ctx);

		expect(result).toBeNull();
		expect(account.rate_limited_reason).toBe("model_fallback_429");
		const benchMs = (account.rate_limited_until ?? 0) - FROZEN_NOW;
		expect(benchMs).toBeGreaterThanOrEqual(0);
		expect(benchMs).toBeLessThanOrEqual(5);
	});

	it("clamps a real retry-after to the ramp when honouring it is off", async () => {
		// The pre-3.5.101 behaviour, now opt-in: the ramp bounds even a real
		// upstream window, so a model-scoped 429 that the upstream reports for an
		// hour does not bench every model on the account.
		process.env.CCFLARE_RATE_LIMIT_HONOR_EXPLICIT_RESET = "false";
		process.env.CCFLARE_RATE_LIMIT_BACKOFF_BASE_MS = "1000";
		process.env.CCFLARE_RATE_LIMIT_BACKOFF_MAX_MS = "1000";
		globalThis.fetch = mock(
			async () =>
				new Response(rateLimitBody, {
					status: 429,
					headers: {
						"content-type": "application/json",
						"retry-after": "3600",
					},
				}),
		);

		const ctx = makeProxyContext(() => ({
			isRateLimited: false,
			resetTime: undefined,
		}));
		const account = makeAccount();

		const result = await runProxyAtFrozenTime(account, ctx);

		expect(result).toBeNull();
		const benchMs = (account.rate_limited_until ?? 0) - FROZEN_NOW;
		expect(benchMs).toBeGreaterThanOrEqual(0);
		expect(benchMs).toBeLessThanOrEqual(1_000);
	});

	it("benches until the reset the provider parsed out of the 429 body", async () => {
		// CodeBuddy publishes the window in the body (`6004 … UTC+8 重置`) and
		// no header, so header-only parsing fell back to the 30-60s ramp and
		// re-probed a quota window that was hours away.
		const resetTime = Date.now() + FOUR_DAYS_MS;
		globalThis.fetch = mock(
			async () =>
				new Response(rateLimitBody, {
					status: 429,
					headers: { "content-type": "application/json" },
				}),
		);

		const ctx = makeProxyContext(
			() => ({ isRateLimited: true, resetTime: undefined }),
			async () => resetTime,
		);
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

	it("keeps a real retry-after wait when the provider's own reset is inferred", async () => {
		// Anthropic sets resetIsInferred:true when it falls back to its 60s
		// default, but a `retry-after` header on the same response is a real
		// upstream instruction and outranks that default. Pairing the selected
		// deadline with the provider's flag would downgrade the hour-long wait
		// to the backoff ramp (widened to 30 days here, so a regression is
		// unmistakable).
		const before = Date.now();
		globalThis.fetch = mock(
			async () =>
				new Response(rateLimitBody, {
					status: 429,
					headers: {
						"content-type": "application/json",
						"retry-after": "3600",
					},
				}),
		);

		const ctx = makeProxyContext(() => ({
			isRateLimited: true,
			resetTime: before + 60_000,
			resetIsInferred: true,
		}));
		const account = makeAccount();

		const result = await runProxy(account, ctx);

		expect(result).toBeNull();
		const benchMs = (account.rate_limited_until ?? 0) - Date.now();
		expect(benchMs).toBeGreaterThan(3_500_000);
		expect(benchMs).toBeLessThanOrEqual(3_600_000);
	});

	it("keeps a header-less all-models 429 on the backoff ramp", async () => {
		// The second 429 site (`all_models_exhausted_429`): a model-mapping list
		// makes every model answer 429 with no reset. The account must land on
		// the ramp, not on our own 60s default (#506).
		process.env.CCFLARE_RATE_LIMIT_BACKOFF_BASE_MS = "1";
		process.env.CCFLARE_RATE_LIMIT_BACKOFF_MAX_MS = "1";
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
		const account = makeAccount({
			model_mappings: JSON.stringify({
				"claude-sonnet-4-5": ["gpt-a", "gpt-b"],
			}),
		});

		const result = await runProxyAtFrozenTime(account, ctx);

		expect(result).toBeNull();
		expect(account.rate_limited_reason).toBe("all_models_exhausted_429");
		const benchMs = (account.rate_limited_until ?? 0) - FROZEN_NOW;
		expect(benchMs).toBeGreaterThanOrEqual(0);
		expect(benchMs).toBeLessThanOrEqual(5);
	});

	it("falls back to the header parse when the body parser throws", async () => {
		const resetTime = Date.now() + FOUR_DAYS_MS;
		globalThis.fetch = mock(
			async () =>
				new Response(rateLimitBody, {
					status: 429,
					headers: { "content-type": "application/json" },
				}),
		);

		const ctx = makeProxyContext(
			() => ({ isRateLimited: true, resetTime }),
			async () => {
				throw new Error("body parser exploded");
			},
		);
		const account = makeAccount();

		const result = await runProxy(account, ctx);

		expect(result).toBeNull();
		expect(account.rate_limited_until ?? 0).toBeGreaterThanOrEqual(
			resetTime - 5_000,
		);
		expect(account.rate_limited_until ?? 0).toBeLessThanOrEqual(
			resetTime + 5_000,
		);
	});
});
