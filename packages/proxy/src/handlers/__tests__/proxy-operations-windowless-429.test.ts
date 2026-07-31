import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	mock,
	spyOn,
} from "bun:test";
import { usageCache } from "@better-ccflare/providers";
import type { Account, RequestMeta } from "@better-ccflare/types";
import * as usageCollectorModule from "../../usage-collector";
import { clearFamilyExhaustionCache } from "../model-capacity";
import { proxyWithAccount } from "../proxy-operations";
import type { ProxyContext } from "../proxy-types";

function stubUsageCollector() {
	return spyOn(usageCollectorModule, "getUsageCollector").mockReturnValue({
		handleStart: mock(() => {}),
		handleChunk: mock(() => {}),
		handleEnd: mock(() => Promise.resolve()),
	} as unknown as usageCollectorModule.UsageCollector);
}

function makeAccount(overrides: Partial<Account> = {}): Account {
	return {
		id: "acc-anthropic-1",
		name: "claude-pro",
		provider: "anthropic",
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
		id: "req-1",
		method: "POST",
		path: "/v1/messages",
		timestamp: Date.now(),
		headers: new Headers(),
	};
}

function makeRequestBody(model = "claude-sonnet-4-5") {
	const body = JSON.stringify({
		model,
		messages: [{ role: "user", content: "hello" }],
		max_tokens: 10,
	});
	return new TextEncoder().encode(body).buffer;
}

function makeRequest(body: ArrayBuffer, headers: Record<string, string> = {}) {
	return new Request("https://proxy.local/v1/messages", {
		method: "POST",
		body,
		headers: { "Content-Type": "application/json", ...headers },
	});
}

/**
 * The windowless 429, captured verbatim from Anthropic on 2026-07-31: an
 * explicit retry instruction and no rate-limit window state at all.
 *
 * Live measurement showed this shape to be REQUEST-scoped, not account-wide.
 * The same account served 200s two seconds before and 38 seconds after the
 * rejection, on the same model, while every other account in the pool rejected
 * the same client request with the same bare 429.
 *
 * Passing window headers via `extra` models a genuine limit, which also carries
 * `x-should-retry: true` and MUST still bench.
 */
function burst429(extra: Record<string, string> = {}): Response {
	return new Response(
		JSON.stringify({
			type: "error",
			error: { type: "rate_limit_error", message: "rate limit exceeded" },
		}),
		{
			status: 429,
			headers: {
				"content-type": "application/json",
				"x-robots-tag": "none",
				"x-should-retry": "true",
				...extra,
			},
		},
	);
}

function ok200(): Response {
	return new Response(
		JSON.stringify({
			id: "msg_1",
			type: "message",
			role: "assistant",
			model: "claude-sonnet-4-5",
			content: [{ type: "text", text: "hi" }],
			stop_reason: "end_turn",
			usage: { input_tokens: 5, output_tokens: 2 },
		}),
		{ status: 200, headers: { "content-type": "application/json" } },
	);
}

function makeCtx(): ProxyContext {
	return {
		strategy: { getNextAccount: () => null } as never,
		dbOps: {
			markAccountRateLimited: mock(
				(_id: string, _until: number, _reason: string) =>
					Promise.resolve({ consecutiveRateLimits: 1, applied: true }),
			),
			saveRequest: mock((..._args: unknown[]) => Promise.resolve()),
			updateAccountUsage: mock(() => Promise.resolve()),
			getAdapter: mock(() => ({
				run: mock(() => Promise.resolve()),
				get: mock(() => Promise.resolve(null)),
			})),
		} as never,
		runtime: { port: 8080, clientId: "test" } as never,
		// NOTE: getProvider("anthropic") from the registry wins over this, by
		// design — the real parser and processResponse run.
		provider: { name: "anthropic" } as never,
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

async function runProxy(
	account: Account,
	ctx: ProxyContext,
	req: Request,
	body: ArrayBuffer,
) {
	return proxyWithAccount(
		req,
		new URL("https://proxy.local/v1/messages"),
		account,
		makeRequestMeta(),
		body,
		() => undefined,
		0,
		ctx,
	);
}

const marks = (ctx: ProxyContext) =>
	(ctx.dbOps.markAccountRateLimited as ReturnType<typeof mock>).mock.calls
		.length;
const saveReasons = (ctx: ProxyContext) =>
	(ctx.dbOps.saveRequest as ReturnType<typeof mock>).mock.calls.map(
		(c) => (c as unknown[])[6],
	);
/** markAccountRateLimited(accountId, until, reason, incrementStreak) */
const markCalls = (ctx: ProxyContext) =>
	(ctx.dbOps.markAccountRateLimited as ReturnType<typeof mock>).mock
		.calls as unknown as [string, number, string, boolean][];

describe("proxyWithAccount — windowless 429 is not benched (issue #301)", () => {
	let originalFetch: typeof globalThis.fetch;
	let collectorSpy: ReturnType<typeof stubUsageCollector>;

	beforeEach(() => {
		originalFetch = globalThis.fetch;
		collectorSpy = stubUsageCollector();
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
		collectorSpy.mockRestore();
		usageCache.clear();
		clearFamilyExhaustionCache();
	});

	// The core claim. A bare 429 is request-scoped, so it must fail over per
	// request WITHOUT a cooldown, without touching the consecutive-429 counter,
	// and without a second upstream attempt — three retries spanning 11.2s were
	// measured returning three identical bare 429s, and not once did one succeed.
	it("fails over without benching on a bare 429", async () => {
		let calls = 0;
		globalThis.fetch = mock(async () => {
			calls++;
			return burst429();
		});

		const ctx = makeCtx();
		const account = makeAccount();
		const body = makeRequestBody();

		const result = await runProxy(account, ctx, makeRequest(body), body);

		// Exactly one upstream call — no in-place retry.
		expect(calls).toBe(1);
		// null = fail over to the next account.
		expect(result).toBeNull();
		expect(marks(ctx)).toBe(0);
		expect(account.rate_limited_until).toBeNull();
		expect(account.rate_limited_reason).toBeNull();
		expect(account.consecutive_rate_limits).toBe(0);
		expect(saveReasons(ctx)).toContain("windowless_429");
		expect(saveReasons(ctx)).not.toContain("model_fallback_429");
	});

	// The operational point of not benching: the account is immediately routable
	// again, exactly as production showed it to be (200s two seconds either side
	// of the rejected request).
	it("leaves the account routable for the very next request", async () => {
		let calls = 0;
		globalThis.fetch = mock(async () => {
			calls++;
			return calls === 1 ? burst429() : ok200();
		});

		const ctx = makeCtx();
		const account = makeAccount();
		const body = makeRequestBody();

		expect(await runProxy(account, ctx, makeRequest(body), body)).toBeNull();

		const second = await runProxy(account, ctx, makeRequest(body), body);
		expect(second?.status).toBe(200);
		expect(marks(ctx)).toBe(0);
		expect(account.rate_limited_until).toBeNull();
	});

	// Regression guard: a 429 that reports a reset is a REAL window limit and
	// must bench exactly as it did before this change.
	it("still benches a 429 carrying a reset hint", async () => {
		let calls = 0;
		globalThis.fetch = mock(async () => {
			calls++;
			return burst429({
				"anthropic-ratelimit-unified-reset": String(
					Math.floor(Date.now() / 1000) + 300,
				),
			});
		});

		const ctx = makeCtx();
		const account = makeAccount();
		const body = makeRequestBody();

		const result = await runProxy(account, ctx, makeRequest(body), body);

		expect(calls).toBe(1);
		expect(result).toBeNull();
		expect(markCalls(ctx)).toHaveLength(1);
		expect(markCalls(ctx)[0][2]).toBe("model_fallback_429");
		expect(typeof account.rate_limited_until).toBe("number");
		expect(saveReasons(ctx)).toContain("model_fallback_429");
		expect(saveReasons(ctx)).not.toContain("windowless_429");
	});

	// The fail-closed property, end to end. A genuinely spent window was measured
	// carrying ONLY per-window headers — no aggregate `-unified-reset` — while
	// still setting `x-should-retry: true`. The predicate scans header-name
	// prefixes rather than probing known names, so this benches too.
	it("still benches a 429 carrying only per-window headers", async () => {
		let calls = 0;
		globalThis.fetch = mock(async () => {
			calls++;
			return burst429({
				"anthropic-ratelimit-unified-5h-status": "rejected",
				"anthropic-ratelimit-unified-5h-reset": String(
					Math.floor(Date.now() / 1000) + 300,
				),
			});
		});

		const ctx = makeCtx();
		const account = makeAccount();
		const body = makeRequestBody();

		const result = await runProxy(account, ctx, makeRequest(body), body);

		expect(calls).toBe(1);
		expect(result).toBeNull();
		expect(markCalls(ctx)).toHaveLength(1);
		expect(markCalls(ctx)[0][2]).toBe("model_fallback_429");
		expect(saveReasons(ctx)).not.toContain("windowless_429");
	});

	// Hard blocks and billing problems all carry rate-limit metadata, so they are
	// declined by the predicate and keep the unchanged bench-and-failover path.
	it.each([
		"blocked",
		"payment_required",
		"queueing_hard",
		"rejected",
	])("still benches unified status %s", async (status) => {
		let calls = 0;
		globalThis.fetch = mock(async () => {
			calls++;
			return burst429({ "anthropic-ratelimit-unified-status": status });
		});

		const ctx = makeCtx();
		const body = makeRequestBody();
		await runProxy(makeAccount(), ctx, makeRequest(body), body);

		expect(calls).toBe(1);
		expect(marks(ctx)).toBe(1);
		expect(saveReasons(ctx)).not.toContain("windowless_429");
	});

	// out_of_credits (issue #261) is the model-scoped sibling of this fix and is
	// handled earlier in the path. It must keep its own audit reason.
	it("leaves the out_of_credits path unchanged", async () => {
		let calls = 0;
		globalThis.fetch = mock(async () => {
			calls++;
			return burst429({
				"anthropic-ratelimit-unified-overage-disabled-reason": "out_of_credits",
			});
		});

		const ctx = makeCtx();
		const account = makeAccount();
		const body = makeRequestBody("claude-sonnet-4-5");

		const result = await runProxy(account, ctx, makeRequest(body), body);

		expect(calls).toBe(1);
		expect(result).toBeNull();
		expect(account.rate_limited_until).toBeNull();
		expect(marks(ctx)).toBe(0);
		expect(saveReasons(ctx)).toContain("out_of_credits");
		expect(saveReasons(ctx)).not.toContain("windowless_429");
	});

	// Pre-existing behaviour: a synthetic keepalive replay's 429 is neither
	// benched nor recorded — the burst is the scheduler's own doing.
	it("records nothing for a keepalive probe's bare 429", async () => {
		let calls = 0;
		globalThis.fetch = mock(async () => {
			calls++;
			return burst429();
		});

		const ctx = makeCtx();
		const account = makeAccount();
		const body = makeRequestBody();
		const req = makeRequest(body, {
			"x-better-ccflare-keepalive": "true",
			"x-better-ccflare-internal-probe-secret": "test-secret",
		});

		const result = await runProxy(account, ctx, req, body);

		expect(calls).toBe(1);
		expect(result).toBeNull();
		expect(marks(ctx)).toBe(0);
		expect(account.rate_limited_until).toBeNull();
		expect(saveReasons(ctx)).toHaveLength(0);
	});
});
