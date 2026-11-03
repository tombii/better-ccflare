import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import type { Account, RequestMeta } from "@better-ccflare/types";
import { isRateLimitReason } from "@better-ccflare/types";
import { shouldCountAsCircuitFailure } from "../../circuit-breaker";
import { proxyWithAccount } from "../proxy-operations";
import type { ProxyContext } from "../proxy-types";

// Reseller-style openai-compatible account (Mistral / OpenRouter / NanoGPT
// shape): credits are bought with money, so an upstream 402 means "top up",
// not "come back in an hour".
function makeAccount(overrides: Partial<Account> = {}): Account {
	return {
		id: "acc-openrouter-1",
		name: "openrouter",
		provider: "openai-compatible",
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
		custom_endpoint: "https://openrouter.ai/api/v1",
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
	const bytes = new TextEncoder().encode(body);
	return bytes.buffer.slice(
		bytes.byteOffset,
		bytes.byteOffset + bytes.byteLength,
	) as ArrayBuffer;
}

function makeProxyContext(): ProxyContext {
	const markAccountRateLimited = mock(
		(_accountId: string, _until: number, _reason: string) =>
			Promise.resolve({ consecutiveRateLimits: 1, applied: true }),
	);
	const saveRequest = mock((..._args: unknown[]) => Promise.resolve());
	return {
		strategy: { getNextAccount: () => null } as never,
		dbOps: {
			markAccountRateLimited,
			saveRequest,
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
			name: "openai-compatible",
			canHandle: () => true,
			buildUrl: (_path: string, _search: string) =>
				"https://openrouter.ai/api/v1/messages",
			prepareHeaders: (_headers: Headers) => new Headers(),
			transformRequestBody: null,
			processResponse: async (r: Response) => r,
			parseRateLimit: () => ({
				isRateLimited: false,
				resetTime: undefined,
				statusHeader: "allowed",
				remaining: undefined,
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
		forwardToClient: capturingForward,
	};
}

/** Captures the Response the proxy hands to the client (same seam as
 *  proxy-operations-5xx-failover.test.ts). */
let capturedForward: Response | null = null;

const capturingForward = (async ({ response }: { response: Response }) => {
	capturedForward = response;
	return response;
}) as unknown as NonNullable<ProxyContext["forwardToClient"]>;

async function runProxy(
	account: Account,
	bodyBuffer: ArrayBuffer,
	ctx: ProxyContext,
	failoverAttempts = 0,
): Promise<Response | null> {
	return proxyWithAccount(
		makeRequest(bodyBuffer),
		new URL("https://proxy.local/v1/messages"),
		account,
		makeRequestMeta(),
		bodyBuffer,
		() => undefined,
		failoverAttempts,
		ctx,
	);
}

function makeRequest(body: ArrayBuffer) {
	return new Request("https://proxy.local/v1/messages", {
		method: "POST",
		body,
		headers: { "Content-Type": "application/json" },
	});
}

function upstream402(): Response {
	return new Response(
		JSON.stringify({
			error: {
				code: 402,
				message: "Insufficient credits. Please top up your account.",
				type: "invalid_request_error",
			},
		}),
		{ status: 402, headers: { "content-type": "application/json" } },
	);
}

function success200(): Response {
	return new Response(
		JSON.stringify({
			id: "msg_1",
			type: "message",
			role: "assistant",
			content: [{ type: "text", text: "hello" }],
			model: "some-model",
			stop_reason: "end_turn",
			usage: { input_tokens: 1, output_tokens: 1 },
		}),
		{ status: 200, headers: { "content-type": "application/json" } },
	);
}

function saveReasons(ctx: ProxyContext): unknown[] {
	const saveMock = ctx.dbOps.saveRequest as ReturnType<typeof mock>;
	return saveMock.mock.calls.map((call) => (call as unknown[])[6]);
}

describe("proxyWithAccount — upstream 402 (out of credits upstream)", () => {
	let originalFetch: typeof globalThis.fetch;

	beforeEach(() => {
		originalFetch = globalThis.fetch;
		capturedForward = null;
		// Zero-delay backoff: the retry test goes 500 -> in-place retry.
		process.env.CCFLARE_OVERLOAD_RETRY_BASE_MS = "0";
		process.env.CCFLARE_OVERLOAD_RETRY_MAX_MS = "0";
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
		capturedForward = null;
		delete process.env.CCFLARE_OVERLOAD_RETRY_BASE_MS;
		delete process.env.CCFLARE_OVERLOAD_RETRY_MAX_MS;
	});

	it("fails over (returns null for the account) on a 402 without benching it", async () => {
		globalThis.fetch = mock(async () => upstream402());

		const ctx = makeProxyContext();
		const account = makeAccount();
		const bodyBuffer = makeRequestBody();
		const result = await runProxy(account, bodyBuffer, ctx);

		// null = the caller moves on to the next account.
		expect(result).toBeNull();

		// NOT benched: no cooldown deadline, no streak bump.
		expect(account.rate_limited_until).toBeNull();
		expect(account.rate_limited_reason).toBeNull();
		expect(account.rate_limited_at).toBeNull();
		expect(account.consecutive_rate_limits).toBe(0);

		const markMock = ctx.dbOps.markAccountRateLimited as ReturnType<
			typeof mock
		>;
		expect(markMock.mock.calls.length).toBe(0);
	});

	it("records the request with reason upstream_402_out_of_credits", async () => {
		globalThis.fetch = mock(async () => upstream402());

		const ctx = makeProxyContext();
		const bodyBuffer = makeRequestBody("claude-sonnet-4-5");
		await runProxy(makeAccount(), bodyBuffer, ctx);

		const saveMock = ctx.dbOps.saveRequest as ReturnType<typeof mock>;
		expect(saveMock.mock.calls.length).toBe(1);
		const args = saveMock.mock.calls[0] as unknown[];
		expect(args[3]).toBe("acc-openrouter-1");
		expect(args[4]).toBe(402);
		expect(args[5]).toBe(false);
		expect(args[6]).toBe("upstream_402_out_of_credits");
		expect(args[9]).toEqual({ model: "claude-sonnet-4-5" });
	});

	it("threads gateway hint headers through to the 402 saveRequest call", async () => {
		globalThis.fetch = mock(async () => upstream402());

		const ctx = makeProxyContext();
		const bodyBuffer = makeRequestBody();
		const req = new Request("https://proxy.local/v1/messages", {
			method: "POST",
			body: bodyBuffer,
			headers: {
				"Content-Type": "application/json",
				"x-claude-code-request-class": "primary",
				"x-claude-code-agent-type": "explore",
			},
		});

		await proxyWithAccount(
			req,
			new URL("https://proxy.local/v1/messages"),
			makeAccount(),
			makeRequestMeta(),
			bodyBuffer,
			() => undefined,
			0,
			ctx,
		);

		const saveMock = ctx.dbOps.saveRequest as ReturnType<typeof mock>;
		const args = saveMock.mock.calls[0] as unknown[];
		expect(args[22]).toBe("primary");
		expect(args[23]).toBe("explore");
	});

	it("fails over to the next account and the client gets that account's 200", async () => {
		// Drives the caller's failover loop (proxy.ts's per-account loop) by
		// hand: account A 402s, account B is healthy.
		const ctx = makeProxyContext();
		const bodyBuffer = makeRequestBody();
		const first = makeAccount({ id: "acc-a", name: "a" });
		const second = makeAccount({ id: "acc-b", name: "b" });

		globalThis.fetch = mock(async () => upstream402());
		const firstResult = await runProxy(first, bodyBuffer, ctx);
		expect(firstResult).toBeNull();
		expect(capturedForward).toBeNull();

		globalThis.fetch = mock(async () => success200());
		const secondResult = await runProxy(second, bodyBuffer, ctx, 1);
		expect(secondResult?.status).toBe(200);
		expect(capturedForward?.status).toBe(200);

		// The 402 left the first account routable: still no bench, so the
		// selector offers it again on the next request.
		expect(first.rate_limited_until).toBeNull();
		const markMock = ctx.dbOps.markAccountRateLimited as ReturnType<
			typeof mock
		>;
		expect(markMock.mock.calls.length).toBe(0);
		expect(saveReasons(ctx)).toEqual(["upstream_402_out_of_credits"]);
	});

	it("classifies a 402 that survives an in-place retry the same way", async () => {
		// First attempt 500 (transient server error → in-place retry), retry
		// answers 402. The retry re-runs the classification chain.
		let calls = 0;
		globalThis.fetch = mock(async () => {
			calls++;
			if (calls === 1)
				return new Response(
					JSON.stringify({ error: { message: "Internal error" } }),
					{ status: 500, headers: { "content-type": "application/json" } },
				);
			return upstream402();
		});

		const ctx = makeProxyContext();
		const account = makeAccount();
		const bodyBuffer = makeRequestBody();

		const result = await runProxy(account, bodyBuffer, ctx);

		expect(result).toBeNull();
		expect(account.rate_limited_until).toBeNull();
		expect(saveReasons(ctx)).toContain("upstream_402_out_of_credits");
	});

	it("fails over when a model-fallback retry answers 402 after the primary 404s", async () => {
		// Greptile P1 on #526: the model-cycling loop runs AFTER the
		// first-response classification, so a 402 from a fallback model left the
		// loop and was forwarded to the client instead of failing over.
		// The primary answers 429 (rate-limited) because a 404 with no fallback
		// models is forwarded by design; 429 always enters the model list.
		const sentModels: string[] = [];
		globalThis.fetch = mock(async (input: RequestInfo | URL) => {
			const req = input instanceof Request ? input : new Request(String(input));
			const body = JSON.parse(await req.text().catch(() => "{}"));
			sentModels.push(body.model);
			// The primary is the first mapping entry; every later request is a
			// fallback and answers 402.
			if (sentModels.length === 1) {
				return new Response(
					JSON.stringify({
						error: {
							type: "rate_limit_error",
							message: "Rate limit exceeded: limit_rpm/model/abc",
						},
					}),
					{ status: 429, headers: { "content-type": "application/json" } },
				);
			}
			return upstream402();
		});

		const ctx = makeProxyContext();
		// Entry 0 is what the first request is rewritten to (the proxy maps the
		// client's Claude id through the mapping, so the fallback list is looked
		// up by the mapped name); entry 1 is the fallback tried on 429.
		const account = makeAccount({
			model_mappings: JSON.stringify({
				sonnet: ["primary-model", "fallback-model"],
			}),
		});
		const bodyBuffer = makeRequestBody();

		const result = await runProxy(account, bodyBuffer, ctx);

		// Fallback was actually tried, then the 402 caused failover.
		expect(sentModels.length).toBe(2);
		expect(result).toBeNull();
		expect(capturedForward).toBeNull();
		expect(account.rate_limited_until).toBeNull();
		expect(saveReasons(ctx)).toContain("upstream_402_out_of_credits");
	});
});

describe("upstream_402_out_of_credits reason plumbing", () => {
	it("is a runtime-recognised RateLimitReason", () => {
		expect(isRateLimitReason("upstream_402_out_of_credits")).toBe(true);
	});

	it("does NOT count as a circuit-breaker failure", () => {
		expect(shouldCountAsCircuitFailure("upstream_402_out_of_credits")).toBe(
			false,
		);
	});
});
