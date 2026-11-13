import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	mock,
	setSystemTime,
	spyOn,
} from "bun:test";
import { Logger } from "@better-ccflare/logger";
import { usageCache } from "@better-ccflare/providers";
import type { Account, RequestMeta } from "@better-ccflare/types";
import * as usageCollectorModule from "../../usage-collector";
import { clearFamilyExhaustionCache } from "../model-capacity";
import {
	getModelCooldownUntil,
	resetModelCooldownsForTests,
} from "../model-cooldown";
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
		clientSessionId: "sess-1",
	};
}

/**
 * clientSessionId sits six positional arguments from the end of saveRequest —
 * the five gatewayHint* fields (requestClass, agentType, prevToolDurations,
 * compaction, contextCompacted) follow it. Asserting from the tail rather
 * than a fixed index is deliberate: this branch originally dropped trailing
 * arguments because it was copied from a sibling 429 path that later grew
 * them, and a hardcoded index would not have caught that.
 */
const lastSaveArg = (ctx: ProxyContext) => {
	const calls = (ctx.dbOps.saveRequest as ReturnType<typeof mock>).mock.calls;
	const args = calls[calls.length - 1] as unknown[];
	return args[args.length - 6];
};

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
			resetConsecutiveRateLimits: mock(() => Promise.resolve()),
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

describe("proxyWithAccount — windowless 429 cooldown", () => {
	let originalFetch: typeof globalThis.fetch;
	let collectorSpy: ReturnType<typeof stubUsageCollector>;

	beforeEach(() => {
		originalFetch = globalThis.fetch;
		collectorSpy = stubUsageCollector();
		resetModelCooldownsForTests();
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
		collectorSpy.mockRestore();
		usageCache.clear();
		clearFamilyExhaustionCache();
		resetModelCooldownsForTests();
		setSystemTime();
	});

	it("cools only the upstream model and leaves every account quota field untouched", async () => {
		globalThis.fetch = mock(async () => burst429());
		const ctx = makeCtx();
		const account = makeAccount({
			consecutive_rate_limits: 3,
			rate_limited_until: Date.now() + 3_600_000,
			rate_limited_reason: "upstream_429_with_reset",
			rate_limited_at: Date.now() - 1_000,
			rate_limit_reset: Date.now() + 3_600_000,
			rate_limit_status: "allowed",
			rate_limit_remaining: 42,
		});
		const before = { ...account };
		const body = makeRequestBody("claude-haiku-5-5");
		expect(await runProxy(account, ctx, makeRequest(body), body)).toBeNull();
		expect(globalThis.fetch).toHaveBeenCalledTimes(1);
		expect(marks(ctx)).toBe(0);
		for (const field of [
			"rate_limited_until",
			"rate_limited_reason",
			"rate_limited_at",
			"rate_limit_reset",
			"rate_limit_status",
			"rate_limit_remaining",
			"consecutive_rate_limits",
		] as const) {
			expect(account[field]).toBe(before[field]);
		}
		expect(
			(getModelCooldownUntil(account.id, "claude-haiku-5-5") ?? 0) - Date.now(),
		).toBeGreaterThan(59_000);
		expect(getModelCooldownUntil(account.id, "claude-opus-5-5")).toBeNull();
		expect(saveReasons(ctx)).toContain("windowless_429");
		expect(lastSaveArg(ctx)).toBe("sess-1");
	});

	it("skips the cooled mapped haiku pair without an upstream call while opus still uses the account", async () => {
		const now = Date.now();
		setSystemTime(now);
		const sent: string[] = [];
		globalThis.fetch = mock(async (input: Request | string | URL) => {
			const model = (await (input as Request).json()).model as string;
			sent.push(model);
			return model === "claude-haiku-5-5" ? burst429() : ok200();
		}) as unknown as typeof fetch;
		const account = makeAccount({
			model_mappings: JSON.stringify({ haiku: "claude-haiku-5-5" }),
		});
		const ctx = makeCtx();
		const body = makeRequestBody("claude-haiku-alias");
		expect(await runProxy(account, ctx, makeRequest(body), body)).toBeNull();
		expect(getModelCooldownUntil(account.id, "claude-haiku-alias")).toBeNull();
		expect(
			getModelCooldownUntil(account.id, "claude-haiku-5-5"),
		).not.toBeNull();
		expect(await runProxy(account, ctx, makeRequest(body), body)).toBeNull();
		const opusBody = makeRequestBody("claude-opus-5-5");
		expect(
			(await runProxy(account, ctx, makeRequest(opusBody), opusBody))?.status,
		).toBe(200);
		expect(sent).toEqual(["claude-haiku-5-5", "claude-opus-5-5"]);
		expect(
			getModelCooldownUntil(account.id, "claude-haiku-5-5"),
		).not.toBeNull();
		setSystemTime(now + 60_000);
		await runProxy(account, ctx, makeRequest(body), body);
		// Opus succeeded, but Haiku's own consecutive streak still doubles.
		expect(getModelCooldownUntil(account.id, "claude-haiku-5-5")).toBe(
			now + 180_000,
		);
	});

	it("fails over immediately and records the mapped pair even with configured model fallbacks", async () => {
		globalThis.fetch = mock(async () => burst429());
		const account = makeAccount({
			model_mappings: JSON.stringify({
				haiku: ["claude-haiku-5-5", "claude-opus-5-5"],
			}),
		});
		const body = makeRequestBody("claude-haiku-alias");
		expect(
			await runProxy(account, makeCtx(), makeRequest(body), body),
		).toBeNull();
		expect(globalThis.fetch).toHaveBeenCalledTimes(1);
		expect(
			getModelCooldownUntil(account.id, "claude-haiku-5-5"),
		).not.toBeNull();
		expect(account.rate_limited_until).toBeNull();
	});

	it("scopes a windowless 429 reached after a model-not-found fallback to that fallback model", async () => {
		let calls = 0;
		globalThis.fetch = mock(async () =>
			++calls === 1
				? new Response(
						JSON.stringify({
							error: { type: "not_found_error", message: "model not found" },
						}),
						{ status: 404, headers: { "content-type": "application/json" } },
					)
				: burst429(),
		);
		const account = makeAccount({
			model_mappings: JSON.stringify({
				haiku: ["claude-haiku-missing", "claude-haiku-5-5"],
			}),
		});
		const body = makeRequestBody("claude-haiku-alias");
		const ctx = makeCtx();
		expect(await runProxy(account, ctx, makeRequest(body), body)).toBeNull();
		expect(calls).toBe(2);
		expect(
			getModelCooldownUntil(account.id, "claude-haiku-5-5"),
		).not.toBeNull();
		expect(
			getModelCooldownUntil(account.id, "claude-haiku-missing"),
		).toBeNull();
		expect(marks(ctx)).toBe(0);
		expect(account.consecutive_rate_limits).toBe(0);
	});

	it("logs one bench and one recovery while cooled requests stay silent", async () => {
		const warn = spyOn(Logger.prototype, "warn").mockImplementation(() => {});
		const info = spyOn(Logger.prototype, "info").mockImplementation(() => {});
		try {
			const account = makeAccount();
			const body = makeRequestBody("claude-haiku-5-5");
			const ctx = makeCtx();
			let now = Date.now();
			setSystemTime(now);
			globalThis.fetch = mock(async () => burst429());
			await runProxy(account, ctx, makeRequest(body), body);
			await runProxy(account, ctx, makeRequest(body), body);
			expect(
				warn.mock.calls.filter(([message]) =>
					String(message).includes("windowless_429 paused"),
				),
			).toHaveLength(1);
			now += 60_000;
			setSystemTime(now);
			globalThis.fetch = mock(async () => ok200());
			await runProxy(account, ctx, makeRequest(body), body);
			await runProxy(account, ctx, makeRequest(body), body);
			expect(
				info.mock.calls.filter(([message]) =>
					String(message).includes("recovered from windowless_429"),
				),
			).toHaveLength(1);
		} finally {
			warn.mockRestore();
			info.mockRestore();
		}
	});

	it("doubles across natural expiry, caps at fifteen minutes, and resets only on that pair's success", async () => {
		let now = Date.now();
		setSystemTime(now);
		const account = makeAccount();
		const ctx = makeCtx();
		const body = makeRequestBody("claude-haiku-5-5");
		globalThis.fetch = mock(async () => burst429());
		for (const expectedMs of [
			60_000, 120_000, 240_000, 480_000, 900_000, 900_000,
		]) {
			await runProxy(account, ctx, makeRequest(body), body);
			expect(getModelCooldownUntil(account.id, "claude-haiku-5-5")).toBe(
				now + expectedMs,
			);
			now += expectedMs;
			setSystemTime(now);
			expect(getModelCooldownUntil(account.id, "claude-haiku-5-5")).toBeNull();
		}
		globalThis.fetch = mock(async () => ok200());
		expect(
			(await runProxy(account, ctx, makeRequest(body), body))?.status,
		).toBe(200);
		globalThis.fetch = mock(async () => burst429());
		await runProxy(account, ctx, makeRequest(body), body);
		expect(getModelCooldownUntil(account.id, "claude-haiku-5-5")).toBe(
			now + 60_000,
		);
		expect(marks(ctx)).toBe(0);
		expect(account.consecutive_rate_limits).toBe(0);
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
		expect(getModelCooldownUntil(account.id, "claude-sonnet-4-5")).toBeNull();
	});
});
