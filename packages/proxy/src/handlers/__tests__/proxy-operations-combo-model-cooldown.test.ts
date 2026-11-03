import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	mock,
	setSystemTime,
} from "bun:test";
import { usageCache } from "@better-ccflare/providers";
import type { Account, RequestMeta } from "@better-ccflare/types";
import { setComboSlotInfo } from "../account-selector";
import { clearFamilyExhaustionCache } from "../model-capacity";
import { isModelCooling, resetModelCooldownsForTests } from "../model-cooldown";
import { proxyWithAccount } from "../proxy-operations";
import type { ProxyContext } from "../proxy-types";
import { resetRateLimitProbeGatesForTests } from "../rate-limit-cooldown";

/**
 * A combo-routed 429 must cool only the (account, model) pair it hit — never
 * bench the whole account — but ONLY when the combo definition proves the
 * account still has another, different-model slot to route to. Benching the
 * account in that case would also block the healthy sibling slot, which is the
 * real incident: CodeBuddy's free `deepseek-v4.1-flash` hits its daily quota,
 * and the SAME account's paid `deepseek-v4.1-flash-sg` slot becomes
 * unreachable.
 *
 * The conservative cases below (no combo, no sibling, passthrough sibling) pin
 * the opposite guarantee: if the combo does not prove a routable sibling,
 * nothing changes and the account-wide bench (the better-tested path) still
 * applies. A false positive here would leave a rate-limited account in
 * rotation and hammer it with retries.
 */

// A provider name that is deliberately NOT registered, so `getProvider(...)`
// misses and `proxyWithAccount` falls back to the stub on `ctx.provider` —
// mirrors proxy-operations-429-provider-reset.test.ts.
const STUB_PROVIDER = "stub-provider-combo-cooldown";

function makeAccount(overrides: Partial<Account> = {}): Account {
	return {
		id: "acc-combo-1",
		name: "codebuddy-test",
		provider: STUB_PROVIDER,
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

function makeRequestMeta(overrides: Partial<RequestMeta> = {}): RequestMeta {
	return {
		id: "req-combo-1",
		method: "POST",
		path: "/v1/messages",
		timestamp: Date.now(),
		headers: new Headers(),
		clientSessionId: "sess-combo-1",
		...overrides,
	};
}

function makeRequestBody(model: string) {
	const body = JSON.stringify({
		model,
		messages: [{ role: "user", content: "hello" }],
		max_tokens: 10,
	});
	return new TextEncoder().encode(body).buffer;
}

function makeRequest(body: ArrayBuffer) {
	return new Request("https://proxy.local/v1/messages", {
		method: "POST",
		body,
		headers: { "Content-Type": "application/json" },
	});
}

function makeCtx(): ProxyContext {
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
			getAccount: mock(() => Promise.resolve(null)),
			getAdapter: mock(() => ({
				run: mock(() => Promise.resolve()),
				get: mock(() => Promise.resolve(null)),
			})),
		} as never,
		runtime: { port: 8080, clientId: "test" } as never,
		provider: {
			name: STUB_PROVIDER,
			canHandle: () => true,
			buildUrl: () => "https://upstream.invalid/v1/messages",
			prepareHeaders: () => new Headers(),
			transformRequestBody: null,
			processResponse: async (r: Response) => r,
			parseRateLimit: () => ({
				isRateLimited: true,
				resetTime: undefined,
			}),
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

/** A 429 with no rate-limit metadata at all. The stub provider is not
 * Anthropic, so `isRetryable429` declines it and the request reaches the
 * account-wide / model-scoped classification under test. */
function plain429(): Response {
	return new Response(
		JSON.stringify({
			type: "error",
			error: { type: "rate_limit_error", message: "quota exhausted" },
		}),
		{ status: 429, headers: { "content-type": "application/json" } },
	);
}

async function runProxy(
	account: Account,
	ctx: ProxyContext,
	meta: RequestMeta,
	model: string,
): Promise<Response | null> {
	const bodyBuffer = makeRequestBody(model);
	return proxyWithAccount(
		makeRequest(bodyBuffer),
		new URL("https://proxy.local/v1/messages"),
		account,
		meta,
		bodyBuffer,
		() => undefined,
		0,
		ctx,
	);
}

const markCalls = (ctx: ProxyContext) =>
	(ctx.dbOps.markAccountRateLimited as ReturnType<typeof mock>).mock
		.calls as unknown as [string, number, string, boolean][];
const saveReasons = (ctx: ProxyContext) =>
	(ctx.dbOps.saveRequest as ReturnType<typeof mock>).mock.calls.map(
		(c) => (c as unknown[])[6],
	);
const saveCalls = (ctx: ProxyContext) =>
	(ctx.dbOps.saveRequest as ReturnType<typeof mock>).mock.calls as unknown[][];

const ACCOUNT_ID = "acc-combo-1";

describe("proxyWithAccount — combo 429 cools (account, model), not the account", () => {
	let originalFetch: typeof globalThis.fetch;

	beforeEach(() => {
		originalFetch = globalThis.fetch;
		resetModelCooldownsForTests();
		resetRateLimitProbeGatesForTests();
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
		setSystemTime();
		usageCache.clear();
		clearFamilyExhaustionCache();
		resetModelCooldownsForTests();
		resetRateLimitProbeGatesForTests();
	});

	it("cools only the slot's model when the account has a different-model sibling slot", async () => {
		globalThis.fetch = mock(async () => plain429());

		const meta = makeRequestMeta({ comboName: "my-combo" });
		setComboSlotInfo(meta, {
			comboName: "my-combo",
			slots: [
				{ accountId: ACCOUNT_ID, modelOverride: "model-a" },
				{ accountId: ACCOUNT_ID, modelOverride: "model-b" },
			],
		});

		const ctx = makeCtx();
		const account = makeAccount();

		const result = await runProxy(account, ctx, meta, "model-a");

		// Fail over to the next slot in the same request.
		expect(result).toBeNull();
		// Account is NOT benched: no rate_limited_until, no counter bump, no
		// markAccountRateLimited (and therefore no RateLimitError/breaker).
		expect(account.rate_limited_until).toBeNull();
		expect(account.rate_limited_reason).toBeNull();
		expect(account.consecutive_rate_limits).toBe(0);
		expect(markCalls(ctx)).toHaveLength(0);
		// The slot itself is cooling.
		expect(isModelCooling(ACCOUNT_ID, "model-a")).toBe(true);
		// The sibling model is untouched.
		expect(isModelCooling(ACCOUNT_ID, "model-b")).toBe(false);
		// The audit row still records the 429.
		expect(saveReasons(ctx)).toContain("model_fallback_429");
	});

	it("uses definitionSlots, not the per-request filtered slots, to find a sibling", async () => {
		globalThis.fetch = mock(async () => plain429());

		// The request's routable `slots` list contains ONLY the failed model's
		// slot — model-b is cooling and was filtered out of the returned
		// accounts. `definitionSlots` is the stable combo definition and still
		// knows the account has a different-model slot. Without the definition
		// the sibling check would find nothing and bench the whole account,
		// which would also block model-b once its own cooldown expired.
		const meta = makeRequestMeta({ comboName: "my-combo" });
		setComboSlotInfo(meta, {
			comboName: "my-combo",
			slots: [{ accountId: ACCOUNT_ID, modelOverride: "model-a" }],
			definitionSlots: [
				{ accountId: ACCOUNT_ID, modelOverride: "model-a" },
				{ accountId: ACCOUNT_ID, modelOverride: "model-b" },
			],
		});

		const ctx = makeCtx();
		const account = makeAccount();

		const result = await runProxy(account, ctx, meta, "model-a");

		expect(result).toBeNull();
		// Model-scoped: the definition proves a sibling, so the account is NOT
		// benched — only the failed model cools.
		expect(account.rate_limited_until).toBeNull();
		expect(markCalls(ctx)).toHaveLength(0);
		expect(isModelCooling(ACCOUNT_ID, "model-a")).toBe(true);
		expect(isModelCooling(ACCOUNT_ID, "model-b")).toBe(false);
		expect(saveReasons(ctx)).toContain("model_fallback_429");
	});

	it("falls back to slots when definitionSlots is absent (benches when no sibling there)", async () => {
		globalThis.fetch = mock(async () => plain429());

		// No definitionSlots populated: the sibling check must fall back to the
		// per-request `slots` list, which here holds only the failed model.
		const meta = makeRequestMeta({ comboName: "my-combo" });
		setComboSlotInfo(meta, {
			comboName: "my-combo",
			slots: [{ accountId: ACCOUNT_ID, modelOverride: "model-a" }],
		});

		const ctx = makeCtx();
		const account = makeAccount();

		const result = await runProxy(account, ctx, meta, "model-a");

		expect(result).toBeNull();
		// Old behaviour preserved: no sibling in `slots` → account-wide bench.
		expect(typeof account.rate_limited_until).toBe("number");
		expect(account.rate_limited_reason).toBe("model_fallback_429");
		expect(markCalls(ctx)).toHaveLength(1);
		expect(isModelCooling(ACCOUNT_ID, "model-a")).toBe(false);
	});

	it("falls back to slots when definitionSlots IS absent but a sibling lives there", async () => {
		globalThis.fetch = mock(async () => plain429());

		// Same fallback, the other direction: with no definitionSlots the two
		// routable slots ARE the definition, so the sibling is still found and
		// the cooldown stays model-scoped.
		const meta = makeRequestMeta({ comboName: "my-combo" });
		setComboSlotInfo(meta, {
			comboName: "my-combo",
			slots: [
				{ accountId: ACCOUNT_ID, modelOverride: "model-a" },
				{ accountId: ACCOUNT_ID, modelOverride: "model-b" },
			],
		});

		const ctx = makeCtx();
		const account = makeAccount();

		const result = await runProxy(account, ctx, meta, "model-a");

		expect(result).toBeNull();
		expect(account.rate_limited_until).toBeNull();
		expect(markCalls(ctx)).toHaveLength(0);
		expect(isModelCooling(ACCOUNT_ID, "model-a")).toBe(true);
	});

	it("cools with the store's 5-minute fallback TTL when the 429 names no reset", async () => {
		globalThis.fetch = mock(async () => plain429());

		const meta = makeRequestMeta({ comboName: "my-combo" });
		setComboSlotInfo(meta, {
			comboName: "my-combo",
			slots: [
				{ accountId: ACCOUNT_ID, modelOverride: "model-a" },
				{ accountId: ACCOUNT_ID, modelOverride: "model-b" },
			],
		});

		const ctx = makeCtx();
		const account = makeAccount();

		const result = await runProxy(account, ctx, meta, "model-a");

		expect(result).toBeNull();
		expect(account.rate_limited_until).toBeNull();
		expect(markCalls(ctx)).toHaveLength(0);
		// No reset was resolved, so the cooldown must fall back to the store's
		// DEFAULT_MODEL_COOLDOWN_TTL_MS (5 min) — NOT the 60s `default` cooldown
		// deadline that `extractCooldownUntilWithSource` invents.
		const now = Date.now();
		expect(isModelCooling(ACCOUNT_ID, "model-a", now + 4 * 60_000)).toBe(true);
		expect(isModelCooling(ACCOUNT_ID, "model-a", now + 6 * 60_000)).toBe(false);
	});

	it("write the same audit-row shape as the account-wide path", async () => {
		globalThis.fetch = mock(async () => plain429());

		const meta = makeRequestMeta({ comboName: "my-combo" });
		setComboSlotInfo(meta, {
			comboName: "my-combo",
			slots: [
				{ accountId: ACCOUNT_ID, modelOverride: "model-a" },
				{ accountId: ACCOUNT_ID, modelOverride: "model-b" },
			],
		});

		const ctx = makeCtx();
		const account = makeAccount();

		await runProxy(account, ctx, meta, "model-a");

		expect(saveCalls(ctx)).toHaveLength(1);
		const args = saveCalls(ctx)[0];
		// (id, method, path, accountId, status, success, reason, responseTime,
		//  failoverAttempts, usage, ...)
		expect(args[3]).toBe(ACCOUNT_ID);
		expect(args[4]).toBe(429);
		expect(args[5]).toBe(false);
		expect(args[6]).toBe("model_fallback_429");
		expect(args[9]).toEqual({ model: "model-a" });
		// Correlated with its client session, like every other 429 audit row.
		expect(args[21]).toBe("sess-combo-1");
	});

	it("benches the account when comboName was cleared (stale ComboSlotInfo, post-step-10 SessionStrategy fallback)", async () => {
		globalThis.fetch = mock(async () => plain429());

		// proxy.ts step 10 clears comboName before re-selecting with
		// SessionStrategy, but the WeakMap entry from the failed combo selection
		// is still there. It must NOT authorise the model-scoped branch.
		const meta = makeRequestMeta({ comboName: null });
		setComboSlotInfo(meta, {
			comboName: "my-combo",
			slots: [
				{ accountId: ACCOUNT_ID, modelOverride: "model-a" },
				{ accountId: ACCOUNT_ID, modelOverride: "model-b" },
			],
		});

		const ctx = makeCtx();
		const account = makeAccount();

		const result = await runProxy(account, ctx, meta, "model-a");

		expect(result).toBeNull();
		// Old behaviour preserved: account-wide bench.
		expect(typeof account.rate_limited_until).toBe("number");
		expect(account.rate_limited_reason).toBe("model_fallback_429");
		expect(markCalls(ctx)).toHaveLength(1);
		expect(markCalls(ctx)[0][2]).toBe("model_fallback_429");
		expect(isModelCooling(ACCOUNT_ID, "model-a")).toBe(false);
		expect(saveReasons(ctx)).toContain("model_fallback_429");
	});

	it("benches the account when the combo has no different-model slot for this account", async () => {
		globalThis.fetch = mock(async () => plain429());

		const meta = makeRequestMeta({ comboName: "my-combo" });
		setComboSlotInfo(meta, {
			comboName: "my-combo",
			slots: [{ accountId: ACCOUNT_ID, modelOverride: "model-a" }],
		});

		const ctx = makeCtx();
		const account = makeAccount();

		const result = await runProxy(account, ctx, meta, "model-a");

		expect(result).toBeNull();
		expect(typeof account.rate_limited_until).toBe("number");
		expect(account.rate_limited_reason).toBe("model_fallback_429");
		expect(markCalls(ctx)).toHaveLength(1);
		expect(isModelCooling(ACCOUNT_ID, "model-a")).toBe(false);
	});

	it("benches the account when the only sibling slot is a passthrough (empty modelOverride)", async () => {
		globalThis.fetch = mock(async () => plain429());

		const meta = makeRequestMeta({ comboName: "my-combo" });
		setComboSlotInfo(meta, {
			comboName: "my-combo",
			slots: [
				{ accountId: ACCOUNT_ID, modelOverride: "model-a" },
				{ accountId: ACCOUNT_ID, modelOverride: "" },
			],
		});

		const ctx = makeCtx();
		const account = makeAccount();

		const result = await runProxy(account, ctx, meta, "model-a");

		expect(result).toBeNull();
		// Conservative: a passthrough slot sends the request's own model, so it
		// is not provably a different model. Keep the account-wide bench.
		expect(typeof account.rate_limited_until).toBe("number");
		expect(account.rate_limited_reason).toBe("model_fallback_429");
		expect(markCalls(ctx)).toHaveLength(1);
		expect(isModelCooling(ACCOUNT_ID, "model-a")).toBe(false);
	});

	it("honours the reset named in a CodeBuddy 6004 body", async () => {
		// The upstream window ("将在 <wall clock> 重置") is the cooldown deadline.
		// The real CodeBuddy provider parses it in parseRateLimitFromBody, so the
		// account stays the real one and only the fetch is stubbed.
		const resetMs =
			Math.floor((Date.now() + 4 * 24 * 60 * 60 * 1000) / 1000) * 1000;
		const iso = new Date(resetMs).toISOString().replace(/\.\d{3}Z$/, "Z");

		globalThis.fetch = mock(
			async () =>
				new Response(
					JSON.stringify({
						code: 6004,
						msg: `您的使用量已超出频率限制，将在 ${iso} 重置，请稍后再试`,
					}),
					{
						status: 429,
						headers: { "content-type": "application/json" },
					},
				),
		);

		const meta = makeRequestMeta({ comboName: "my-combo" });
		setComboSlotInfo(meta, {
			comboName: "my-combo",
			slots: [
				{ accountId: ACCOUNT_ID, modelOverride: "deepseek-v4.1-flash" },
				{ accountId: ACCOUNT_ID, modelOverride: "deepseek-v4.1-flash-sg" },
			],
		});

		const ctx = makeCtx();
		const account = makeAccount({ provider: "codebuddy" });

		const result = await runProxy(account, ctx, meta, "deepseek-v4.1-flash");

		expect(result).toBeNull();
		expect(account.rate_limited_until).toBeNull();
		expect(markCalls(ctx)).toHaveLength(0);
		// Cooling until approximately the body-named reset: still cooling one
		// second before it, expired shortly after. A default 5-minute TTL would
		// fail the first assertion; ignoring the body would too.
		expect(
			isModelCooling(ACCOUNT_ID, "deepseek-v4.1-flash", resetMs - 1_000),
		).toBe(true);
		expect(
			isModelCooling(ACCOUNT_ID, "deepseek-v4.1-flash", resetMs + 5_000),
		).toBe(false);
		expect(saveReasons(ctx)).toContain("model_fallback_429");
	});
});
