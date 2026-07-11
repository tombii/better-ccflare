import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import type { Account, RequestMeta } from "@better-ccflare/types";
import { isModelUnavailableError, proxyWithAccount } from "../proxy-operations";
import type { ProxyContext } from "../proxy-types";

// Minimal Account fixture for openai-compatible provider
function makeAccount(overrides: Partial<Account> = {}): Account {
	return {
		id: "acc-1",
		name: "kilo-test",
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
		model_mappings: JSON.stringify({ sonnet: "qwen/qwen3.6-plus:free" }),
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
		id: "req-1",
		method: "POST",
		path: "/v1/messages",
		timestamp: Date.now(),
		headers: new Headers(),
		...overrides,
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

function makeProxyContext(): ProxyContext {
	return {
		strategy: { getNextAccount: () => null } as never,
		dbOps: {
			markAccountRateLimited: mock(
				(_accountId: string, _until: number, _reason: string) =>
					Promise.resolve(1),
			),
			saveRequest: mock((..._args: unknown[]) => Promise.resolve()),
			updateAccountUsage: mock(() => Promise.resolve()),
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
		asyncWriter: { enqueue: mock(() => {}) } as never,
		config: { getStorePayloads: () => true } as never,
	};
}

function makeRequest(body: ArrayBuffer) {
	return new Request("https://proxy.local/v1/messages", {
		method: "POST",
		body,
		headers: { "Content-Type": "application/json" },
	});
}

function jsonResponse(body: object, status: number) {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

describe("proxyWithAccount — 429 failover", () => {
	let originalFetch: typeof globalThis.fetch;

	beforeEach(() => {
		originalFetch = globalThis.fetch;
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	it("returns null (failover) when upstream returns 429 and no fallback is configured", async () => {
		globalThis.fetch = mock(async () =>
			jsonResponse(
				{
					error: {
						type: "api_error",
						message:
							"Rate limit exceeded: limit_rpm/qwen/qwen3.6-plus:free/abc123",
					},
				},
				429,
			),
		);

		const bodyBuffer = makeRequestBody();
		const req = makeRequest(bodyBuffer);
		const result = await proxyWithAccount(
			req,
			new URL("https://proxy.local/v1/messages"),
			makeAccount(), // no model_fallbacks
			makeRequestMeta(),
			bodyBuffer,
			() => undefined,
			0,
			makeProxyContext(),
		);

		expect(result).toBeNull();
	});

	it("retries with fallback model on 429, returns response when fallback succeeds", async () => {
		const fetchCalls: string[] = [];
		globalThis.fetch = mock(async (input: RequestInfo | URL) => {
			// Capture request body to verify model was swapped on retry
			const req = input instanceof Request ? input : new Request(String(input));
			const bodyText = await req.text().catch(() => "{}");
			const body = JSON.parse(bodyText);
			fetchCalls.push(body.model ?? "unknown");

			if (fetchCalls.length === 1) {
				// Primary model: 429
				return jsonResponse(
					{
						error: {
							type: "api_error",
							message:
								"Rate limit exceeded: limit_rpm/qwen/qwen3.6-plus:free/abc",
						},
					},
					429,
				);
			}
			// Fallback model: success
			return jsonResponse(
				{
					id: "msg_1",
					type: "message",
					role: "assistant",
					content: [{ type: "text", text: "hi" }],
					model: body.model,
					stop_reason: "end_turn",
					usage: { input_tokens: 1, output_tokens: 1 },
				},
				200,
			);
		});

		const bodyBuffer = makeRequestBody();
		const req = makeRequest(bodyBuffer);
		// proxyWithAccount reaches forwardToClient on success, which requires
		// UsageCollector initialization (not wired in unit tests). Catch that
		// specific error while still verifying the retry fired.
		let result: Response | null = null;
		try {
			result = await proxyWithAccount(
				req,
				new URL("https://proxy.local/v1/messages"),
				makeAccount({
					model_fallbacks: JSON.stringify({
						sonnet: "bytedance-seed/dola-seed-2.0-pro:free",
					}),
				}),
				makeRequestMeta(),
				bodyBuffer,
				() => undefined,
				0,
				makeProxyContext(),
			);
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			if (!msg.includes("UsageCollector not initialized")) throw e;
		}

		if (result) {
			expect(result.status).toBe(200);
		}
		expect(fetchCalls).toHaveLength(2);
		// Second call should use the fallback model
		expect(fetchCalls[1]).toBe("bytedance-seed/dola-seed-2.0-pro:free");
	});

	it("returns null (failover) when both primary and fallback model return 429", async () => {
		globalThis.fetch = mock(async () =>
			jsonResponse(
				{
					error: {
						type: "api_error",
						message: "Rate limit exceeded: limit_rpm/model/abc",
					},
				},
				429,
			),
		);

		const bodyBuffer = makeRequestBody();
		const req = makeRequest(bodyBuffer);
		const result = await proxyWithAccount(
			req,
			new URL("https://proxy.local/v1/messages"),
			makeAccount({
				model_fallbacks: JSON.stringify({
					sonnet: "bytedance-seed/dola-seed-2.0-pro:free",
				}),
			}),
			makeRequestMeta(),
			bodyBuffer,
			() => undefined,
			0,
			makeProxyContext(),
		);

		expect(result).toBeNull();
	});

	it("cycles through 3-model array: first two 429, third succeeds", async () => {
		const fetchCalls: string[] = [];
		globalThis.fetch = mock(async (input: RequestInfo | URL) => {
			const req = input instanceof Request ? input : new Request(String(input));
			const bodyText = await req.text().catch(() => "{}");
			const body = JSON.parse(bodyText);
			fetchCalls.push(body.model ?? "unknown");

			if (fetchCalls.length < 3) {
				return jsonResponse(
					{
						error: {
							type: "api_error",
							message: "Rate limit exceeded: limit_rpm/model/abc",
						},
					},
					429,
				);
			}
			return jsonResponse(
				{
					id: "msg_1",
					type: "message",
					role: "assistant",
					content: [{ type: "text", text: "hi" }],
					model: body.model,
					stop_reason: "end_turn",
					usage: { input_tokens: 1, output_tokens: 1 },
				},
				200,
			);
		});

		const bodyBuffer = makeRequestBody();
		const req = makeRequest(bodyBuffer);
		// proxyWithAccount reaches forwardToClient on success, which requires
		// UsageCollector initialization (not wired in unit tests). Catch that
		// specific error while still verifying the retry fired.
		let result: Response | null = null;
		try {
			result = await proxyWithAccount(
				req,
				new URL("https://proxy.local/v1/messages"),
				makeAccount({
					model_mappings: JSON.stringify({
						sonnet: [
							"qwen/qwen3.6-plus:free",
							"bytedance-seed/dola-seed-2.0-pro:free",
							"meta-llama/llama-3.3-70b:free",
						],
					}),
				}),
				makeRequestMeta(),
				bodyBuffer,
				() => undefined,
				0,
				makeProxyContext(),
			);
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			if (!msg.includes("UsageCollector not initialized")) throw e;
		}

		if (result) {
			expect(result.status).toBe(200);
		}
		expect(fetchCalls).toHaveLength(3);
		expect(fetchCalls[0]).toBe("qwen/qwen3.6-plus:free");
		expect(fetchCalls[1]).toBe("bytedance-seed/dola-seed-2.0-pro:free");
		expect(fetchCalls[2]).toBe("meta-llama/llama-3.3-70b:free");
	});

	it("returns null when all models in the array are exhausted", async () => {
		globalThis.fetch = mock(async () =>
			jsonResponse(
				{
					error: {
						type: "api_error",
						message: "Rate limit exceeded: limit_rpm/model/abc",
					},
				},
				429,
			),
		);

		const bodyBuffer = makeRequestBody();
		const req = makeRequest(bodyBuffer);
		const result = await proxyWithAccount(
			req,
			new URL("https://proxy.local/v1/messages"),
			makeAccount({
				model_mappings: JSON.stringify({
					sonnet: [
						"qwen/qwen3.6-plus:free",
						"bytedance-seed/dola-seed-2.0-pro:free",
					],
				}),
			}),
			makeRequestMeta(),
			bodyBuffer,
			() => undefined,
			0,
			makeProxyContext(),
		);

		expect(result).toBeNull();
	});
});

function makeProxyContextWithAsyncExec(): ProxyContext {
	const ctx = makeProxyContext();
	return {
		...ctx,
		asyncWriter: {
			enqueue: mock(async (job: () => void | Promise<void>) => {
				await job();
			}),
		} as never,
	};
}

describe("proxyWithAccount — rate limit audit trail (issue #178)", () => {
	let originalFetch: typeof globalThis.fetch;

	beforeEach(() => {
		originalFetch = globalThis.fetch;
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	it("calls markAccountRateLimited with reason='model_fallback_429' on no-fallback 429", async () => {
		globalThis.fetch = mock(async () =>
			jsonResponse(
				{
					error: {
						type: "api_error",
						message:
							"Rate limit exceeded: limit_rpm/qwen/qwen3.6-plus:free/abc",
					},
				},
				429,
			),
		);

		const ctx = makeProxyContextWithAsyncExec();
		const bodyBuffer = makeRequestBody();
		const req = makeRequest(bodyBuffer);

		await proxyWithAccount(
			req,
			new URL("https://proxy.local/v1/messages"),
			makeAccount(), // no model_fallbacks
			makeRequestMeta(),
			bodyBuffer,
			() => undefined,
			0,
			ctx,
		);

		// The asyncWriter.enqueue mock captures calls; markAccountRateLimited
		// is called inside the enqueued job. Since asyncWriter.enqueue is mocked
		// (does not execute the job), we verify via markAccountRateLimited directly.
		// The feature requires markAccountRateLimited to receive a third `reason` arg.
		const markMock = ctx.dbOps.markAccountRateLimited as ReturnType<
			typeof mock
		>;
		expect(markMock.mock.calls.length).toBeGreaterThan(0);
		const [, , reason] = markMock.mock.calls[0] as [string, number, string];
		expect(reason).toBe("model_fallback_429");
	});

	it("calls markAccountRateLimited with reason='all_models_exhausted_429' when all models fail", async () => {
		// All fetch calls return 429 — primary + every fallback model
		globalThis.fetch = mock(async () =>
			jsonResponse(
				{
					error: {
						type: "api_error",
						message: "Rate limit exceeded: limit_rpm/model/abc",
					},
				},
				429,
			),
		);

		const ctx = makeProxyContextWithAsyncExec();
		const bodyBuffer = makeRequestBody();
		const req = makeRequest(bodyBuffer);

		await proxyWithAccount(
			req,
			new URL("https://proxy.local/v1/messages"),
			makeAccount({
				model_mappings: JSON.stringify({
					sonnet: [
						"qwen/qwen3.6-plus:free",
						"bytedance-seed/dola-seed-2.0-pro:free",
					],
				}),
			}),
			makeRequestMeta(),
			bodyBuffer,
			() => undefined,
			0,
			ctx,
		);

		const markMock = ctx.dbOps.markAccountRateLimited as ReturnType<
			typeof mock
		>;
		// At least one call should carry the all_models_exhausted_429 reason
		const reasons = markMock.mock.calls.map(
			(args: unknown[]) => args[2] as string,
		);
		expect(reasons).toContain("all_models_exhausted_429");
	});
});

describe("proxyWithAccount — attribution source pass-through to saveRequest (P2)", () => {
	let originalFetch: typeof globalThis.fetch;

	beforeEach(() => {
		originalFetch = globalThis.fetch;
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	it("passes requestMeta.projectAttributionSource/agentAttributionSource through to saveRequest at positions 18/19 on the model_fallback_429 failover path", async () => {
		globalThis.fetch = mock(async () =>
			jsonResponse(
				{
					error: {
						type: "api_error",
						message:
							"Rate limit exceeded: limit_rpm/qwen/qwen3.6-plus:free/abc",
					},
				},
				429,
			),
		);

		const ctx = makeProxyContextWithAsyncExec();
		const bodyBuffer = makeRequestBody();
		const req = makeRequest(bodyBuffer);

		await proxyWithAccount(
			req,
			new URL("https://proxy.local/v1/messages"),
			makeAccount(), // no model_fallbacks -> model_fallback_429 path
			makeRequestMeta({
				projectAttributionSource: "header_project",
				agentAttributionSource: "header_agent",
			}),
			bodyBuffer,
			() => undefined,
			0,
			ctx,
		);

		const saveRequestMock = ctx.dbOps.saveRequest as ReturnType<typeof mock>;
		expect(saveRequestMock.mock.calls.length).toBeGreaterThan(0);
		const args = saveRequestMock.mock.calls[0] as unknown[];
		// Full positional order (0-indexed): id, method, path, accountUsed,
		// statusCode, success, errorMessage, responseTime, failoverAttempts,
		// usage, agentUsed, apiKeyId, apiKeyName, project, billingType,
		// comboName, originalModel, appliedModel, projectAttributionSource,
		// agentAttributionSource.
		expect(args[18]).toBe("header_project");
		expect(args[19]).toBe("header_agent");
	});

	it("passes null attribution sources through to saveRequest when requestMeta omits them", async () => {
		globalThis.fetch = mock(async () =>
			jsonResponse(
				{
					error: {
						type: "api_error",
						message: "Rate limit exceeded: limit_rpm/model/abc",
					},
				},
				429,
			),
		);

		const ctx = makeProxyContextWithAsyncExec();
		const bodyBuffer = makeRequestBody();
		const req = makeRequest(bodyBuffer);

		await proxyWithAccount(
			req,
			new URL("https://proxy.local/v1/messages"),
			makeAccount({
				model_mappings: JSON.stringify({
					sonnet: [
						"qwen/qwen3.6-plus:free",
						"bytedance-seed/dola-seed-2.0-pro:free",
					],
				}),
			}),
			makeRequestMeta(), // no attribution source overrides
			bodyBuffer,
			() => undefined,
			0,
			ctx,
		);

		const saveRequestMock = ctx.dbOps.saveRequest as ReturnType<typeof mock>;
		const reasons = saveRequestMock.mock.calls.map(
			(args: unknown[]) => args[6] as string,
		);
		expect(reasons).toContain("all_models_exhausted_429");
		const call = saveRequestMock.mock.calls.find(
			(args: unknown[]) => args[6] === "all_models_exhausted_429",
		) as unknown[];
		expect(call[18]).toBeNull();
		expect(call[19]).toBeNull();
	});
});

describe("proxyWithAccount — originalModel/appliedModel gated by isModelRewrite on direct 429 saveRequest paths (P2)", () => {
	let originalFetch: typeof globalThis.fetch;

	beforeEach(() => {
		originalFetch = globalThis.fetch;
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	it("persists null/null (not the equal pair) on the model_fallback_429 path when requestMeta carries an unmodified originalModel/appliedModel pair", async () => {
		globalThis.fetch = mock(async () =>
			jsonResponse(
				{
					error: {
						type: "api_error",
						message:
							"Rate limit exceeded: limit_rpm/qwen/qwen3.6-plus:free/abc",
					},
				},
				429,
			),
		);

		const ctx = makeProxyContextWithAsyncExec();
		const bodyBuffer = makeRequestBody();
		const req = makeRequest(bodyBuffer);

		await proxyWithAccount(
			req,
			new URL("https://proxy.local/v1/messages"),
			makeAccount(), // no model_fallbacks -> model_fallback_429 path
			makeRequestMeta({
				// Agent-detected but NOT rewritten: original === applied. Before the
				// fix this bypassed isModelRewrite and persisted the equal pair,
				// making an untouched request look like a real rewrite.
				originalModel: "claude-sonnet-4-5",
				appliedModel: "claude-sonnet-4-5",
			}),
			bodyBuffer,
			() => undefined,
			0,
			ctx,
		);

		const saveRequestMock = ctx.dbOps.saveRequest as ReturnType<typeof mock>;
		expect(saveRequestMock.mock.calls.length).toBeGreaterThan(0);
		const args = saveRequestMock.mock.calls[0] as unknown[];
		expect(args[16]).toBeNull();
		expect(args[17]).toBeNull();
	});

	it("still persists a genuine originalModel/appliedModel rewrite pair on the all_models_exhausted_429 path", async () => {
		globalThis.fetch = mock(async () =>
			jsonResponse(
				{
					error: {
						type: "api_error",
						message: "Rate limit exceeded: limit_rpm/model/abc",
					},
				},
				429,
			),
		);

		const ctx = makeProxyContextWithAsyncExec();
		const bodyBuffer = makeRequestBody();
		const req = makeRequest(bodyBuffer);

		await proxyWithAccount(
			req,
			new URL("https://proxy.local/v1/messages"),
			makeAccount({
				model_mappings: JSON.stringify({
					sonnet: [
						"qwen/qwen3.6-plus:free",
						"bytedance-seed/dola-seed-2.0-pro:free",
					],
				}),
			}),
			makeRequestMeta({
				originalModel: "claude-sonnet-4-5",
				appliedModel: "qwen/qwen3.6-plus:free",
			}),
			bodyBuffer,
			() => undefined,
			0,
			ctx,
		);

		const saveRequestMock = ctx.dbOps.saveRequest as ReturnType<typeof mock>;
		const call = saveRequestMock.mock.calls.find(
			(args: unknown[]) => args[6] === "all_models_exhausted_429",
		) as unknown[];
		expect(call).toBeDefined();
		expect(call[16]).toBe("claude-sonnet-4-5");
		expect(call[17]).toBe("qwen/qwen3.6-plus:free");
	});
});

describe("proxyWithAccount — in-memory cooldown mutation (issue #178 fix)", () => {
	let originalFetch: typeof globalThis.fetch;

	beforeEach(() => {
		originalFetch = globalThis.fetch;
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	it("sets account.rate_limited_until on model_fallback_429 path", async () => {
		globalThis.fetch = mock(async () =>
			jsonResponse(
				{
					error: {
						type: "api_error",
						message:
							"Rate limit exceeded: limit_rpm/qwen/qwen3.6-plus:free/abc",
					},
				},
				429,
			),
		);

		const ctx = makeProxyContextWithAsyncExec();
		const account = makeAccount();
		const before = Date.now();
		const bodyBuffer = makeRequestBody();
		const req = makeRequest(bodyBuffer);

		await proxyWithAccount(
			req,
			new URL("https://proxy.local/v1/messages"),
			account,
			makeRequestMeta(),
			bodyBuffer,
			() => undefined,
			0,
			ctx,
		);

		// In-memory mutation should be set immediately (before DB write completes)
		expect(account.rate_limited_until).not.toBeNull();
		expect(account.rate_limited_until ?? 0).toBeGreaterThan(before);
		// Exponential backoff for count=1 is 30s (RATE_LIMIT_BACKOFF_BASE_MS)
		expect(account.rate_limited_until ?? 0).toBeGreaterThanOrEqual(
			before + 30_000,
		);
	});

	it("sets account.rate_limited_until on all_models_exhausted_429 path", async () => {
		globalThis.fetch = mock(async () =>
			jsonResponse(
				{
					error: {
						type: "api_error",
						message: "Rate limit exceeded: limit_rpm/model/abc",
					},
				},
				429,
			),
		);

		const ctx = makeProxyContextWithAsyncExec();
		const account = makeAccount({
			model_mappings: JSON.stringify({
				sonnet: [
					"qwen/qwen3.6-plus:free",
					"bytedance-seed/dola-seed-2.0-pro:free",
				],
			}),
		});
		const before = Date.now();
		const bodyBuffer = makeRequestBody();
		const req = makeRequest(bodyBuffer);

		await proxyWithAccount(
			req,
			new URL("https://proxy.local/v1/messages"),
			account,
			makeRequestMeta(),
			bodyBuffer,
			() => undefined,
			0,
			ctx,
		);

		expect(account.rate_limited_until).not.toBeNull();
		expect(account.rate_limited_until ?? 0).toBeGreaterThan(before);
		// Exponential backoff for count=1 is 30s (RATE_LIMIT_BACKOFF_BASE_MS)
		expect(account.rate_limited_until ?? 0).toBeGreaterThanOrEqual(
			before + 30_000,
		);
	});
});

describe("getModelList — model_fallbacks merge", () => {
	it("merges model_fallbacks into the model list", async () => {
		const { getModelList } = await import("@better-ccflare/core");
		const account = makeAccount({
			model_mappings: JSON.stringify({ sonnet: "qwen/qwen3.6-plus:free" }),
			model_fallbacks: JSON.stringify({
				sonnet: "bytedance-seed/dola-seed-2.0-pro:free",
			}),
		});
		const list = getModelList("claude-sonnet-4-5", account);
		expect(list).toEqual([
			"qwen/qwen3.6-plus:free",
			"bytedance-seed/dola-seed-2.0-pro:free",
		]);
	});

	it("returns single-element list when no fallbacks", async () => {
		const { getModelList } = await import("@better-ccflare/core");
		const list = getModelList("claude-sonnet-4-5", makeAccount());
		expect(list).toEqual(["qwen/qwen3.6-plus:free"]);
	});

	it("returns array directly when model_mappings value is an array", async () => {
		const { getModelList } = await import("@better-ccflare/core");
		const account = makeAccount({
			model_mappings: JSON.stringify({
				sonnet: ["qwen/qwen3.6-plus:free", "meta-llama/llama-3.3-70b:free"],
			}),
		});
		const list = getModelList("claude-sonnet-4-5", account);
		expect(list).toEqual([
			"qwen/qwen3.6-plus:free",
			"meta-llama/llama-3.3-70b:free",
		]);
	});
});

describe("proxyWithAccount — 529 failover", () => {
	let originalFetch: typeof globalThis.fetch;

	beforeEach(() => {
		originalFetch = globalThis.fetch;
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	it("returns null (failover) when upstream returns 529 and provider parseRateLimit says isRateLimited:true", async () => {
		globalThis.fetch = mock(
			async () =>
				new Response(
					'{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}',
					{
						status: 529,
						headers: { "content-type": "application/json" },
					},
				),
		);

		const bodyBuffer = makeRequestBody();
		const req = makeRequest(bodyBuffer);

		// Override the proxy context to have a provider that treats 529 as rate-limited
		// (matching the Anthropic provider's parseRateLimit behaviour for 529).
		const ctx = makeProxyContext();
		(ctx as { provider: typeof ctx.provider }).provider = {
			...ctx.provider,
			parseRateLimit: (r: Response) => ({
				isRateLimited: r.status === 529 || r.status === 429,
				resetTime: r.status === 529 ? Date.now() + 60_000 : undefined,
				statusHeader: undefined,
				remaining: undefined,
			}),
		} as typeof ctx.provider;

		const result = await proxyWithAccount(
			req,
			new URL("https://proxy.local/v1/messages"),
			makeAccount({
				provider: "anthropic",
				api_key: "test-key",
				access_token: null,
			}),
			makeRequestMeta(),
			bodyBuffer,
			() => undefined,
			0,
			ctx,
		);

		expect(result).toBeNull();
	});

	it("returns upstream 529 on the final account attempt instead of pool exhaustion", async () => {
		globalThis.fetch = mock(
			async () =>
				new Response(
					'{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}',
					{
						status: 529,
						headers: { "content-type": "application/json" },
					},
				),
		);

		const bodyBuffer = makeRequestBody();
		const req = makeRequest(bodyBuffer);
		const ctx = makeProxyContext();
		// proxyWithAccount reaches forwardToClient on the final-attempt passthrough,
		// which requires UsageCollector initialization (not wired in unit tests).
		// Catch that specific error while still verifying the passthrough path
		// (not pool exhaustion) was reached.
		let result: Response | null = null;
		let threwUsageCollectorError = false;
		try {
			result = await proxyWithAccount(
				req,
				new URL("https://proxy.local/v1/messages"),
				makeAccount({
					provider: "anthropic",
					api_key: "test-key",
					access_token: null,
				}),
				makeRequestMeta(),
				bodyBuffer,
				() => undefined,
				0,
				ctx,
				undefined,
				undefined,
				undefined,
				undefined,
				true,
			);
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			if (!msg.includes("UsageCollector not initialized")) throw e;
			threwUsageCollectorError = true;
		}

		if (result) {
			expect(result.status).toBe(529);
			const body = (await result.json()) as {
				error: { type: string; message: string };
			};
			expect(body.error.type).toBe("overloaded_error");
			expect(body.error.message).toBe("Overloaded");
		} else {
			// Reaching forwardToClient (which throws UsageCollector not initialized)
			// itself proves the final-attempt passthrough was taken, not pool
			// exhaustion (which would return null without reaching forwardToClient).
			expect(threwUsageCollectorError).toBe(true);
		}
	});

	it("isModelUnavailableError returns false for 529 overloaded responses", async () => {
		const response = new Response(
			'{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}',
			{ status: 529, headers: { "content-type": "application/json" } },
		);
		expect(await isModelUnavailableError(response)).toBe(false);
	});
});

describe("proxyWithAccount — 529 in-place retry", () => {
	let originalFetch: typeof globalThis.fetch;
	const overloadBody =
		'{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}';
	const successBody =
		'{"id":"msg_1","type":"message","content":[],"model":"claude-sonnet-4-5","stop_reason":"end_turn","usage":{"input_tokens":1,"output_tokens":1}}';

	beforeEach(() => {
		originalFetch = globalThis.fetch;
		// Zero-delay backoff so tests don't sleep
		process.env.CCFLARE_OVERLOAD_RETRY_BASE_MS = "0";
		process.env.CCFLARE_OVERLOAD_RETRY_MAX_MS = "0";
		delete process.env.CCFLARE_OVERLOAD_RETRY_ENABLED;
		delete process.env.CCFLARE_OVERLOAD_RETRY_MAX_ATTEMPTS;
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
		delete process.env.CCFLARE_OVERLOAD_RETRY_BASE_MS;
		delete process.env.CCFLARE_OVERLOAD_RETRY_MAX_MS;
		delete process.env.CCFLARE_OVERLOAD_RETRY_ENABLED;
		delete process.env.CCFLARE_OVERLOAD_RETRY_MAX_ATTEMPTS;
	});

	function make529NoResetCtx() {
		const ctx = makeProxyContext();
		(ctx as { provider: typeof ctx.provider }).provider = {
			...ctx.provider,
			parseRateLimit: (r: Response) => ({
				isRateLimited: r.status === 529,
				resetTime: undefined, // no reset — triggers in-place retry path
				statusHeader: undefined,
				remaining: undefined,
			}),
		} as typeof ctx.provider;
		return ctx;
	}

	it("retries in-place on 529 no-reset and makes exactly 2 fetch calls before succeeding", async () => {
		let callCount = 0;
		globalThis.fetch = mock(async () => {
			callCount++;
			if (callCount === 1) {
				return new Response(overloadBody, {
					status: 529,
					headers: { "content-type": "application/json" },
				});
			}
			return new Response(successBody, {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		});

		process.env.CCFLARE_OVERLOAD_RETRY_MAX_ATTEMPTS = "2";
		const ctx = make529NoResetCtx();
		const bodyBuffer = makeRequestBody();
		// proxyWithAccount reaches forwardToClient on success, which requires
		// UsageCollector initialization (not wired in unit tests). Catch that
		// specific error while still verifying the retry fired.
		try {
			await proxyWithAccount(
				makeRequest(bodyBuffer),
				new URL("https://proxy.local/v1/messages"),
				makeAccount({
					provider: "anthropic",
					api_key: "test-key",
					access_token: null,
				}),
				makeRequestMeta(),
				bodyBuffer,
				() => undefined,
				0,
				ctx,
			);
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			if (!msg.includes("UsageCollector not initialized")) throw e;
		}

		// fetch was called twice: initial 529 + 1 in-place retry
		expect(callCount).toBe(2);
		// markAccountRateLimited should NOT have been called — no cooldown on successful retry
		expect(ctx.dbOps.markAccountRateLimited).not.toHaveBeenCalled();
	});

	it("falls through to cooldown/failover when all retries are exhausted", async () => {
		globalThis.fetch = mock(
			async () =>
				new Response(overloadBody, {
					status: 529,
					headers: { "content-type": "application/json" },
				}),
		);

		process.env.CCFLARE_OVERLOAD_RETRY_MAX_ATTEMPTS = "3";
		const ctx = make529NoResetCtx();
		const bodyBuffer = makeRequestBody();
		const result = await proxyWithAccount(
			makeRequest(bodyBuffer),
			new URL("https://proxy.local/v1/messages"),
			makeAccount({
				provider: "anthropic",
				api_key: "test-key",
				access_token: null,
			}),
			makeRequestMeta(),
			bodyBuffer,
			() => undefined,
			0,
			ctx,
		);

		// All retries exhausted → null (cooldown applied, failover to next account)
		expect(result).toBeNull();
	});

	it("skips in-place retry when CCFLARE_OVERLOAD_RETRY_ENABLED=false", async () => {
		let callCount = 0;
		globalThis.fetch = mock(async () => {
			callCount++;
			return new Response(overloadBody, {
				status: 529,
				headers: { "content-type": "application/json" },
			});
		});

		process.env.CCFLARE_OVERLOAD_RETRY_ENABLED = "false";
		const ctx = make529NoResetCtx();
		const bodyBuffer = makeRequestBody();
		await proxyWithAccount(
			makeRequest(bodyBuffer),
			new URL("https://proxy.local/v1/messages"),
			makeAccount({
				provider: "anthropic",
				api_key: "test-key",
				access_token: null,
			}),
			makeRequestMeta(),
			bodyBuffer,
			() => undefined,
			0,
			ctx,
		);

		// Disabled — only the initial request, no retries
		expect(callCount).toBe(1);
	});

	it("skips in-place retry for synthetic keepalive requests", async () => {
		let callCount = 0;
		globalThis.fetch = mock(async () => {
			callCount++;
			return new Response(overloadBody, {
				status: 529,
				headers: { "content-type": "application/json" },
			});
		});

		process.env.CCFLARE_OVERLOAD_RETRY_MAX_ATTEMPTS = "3";
		const ctx = make529NoResetCtx();
		const bodyBuffer = makeRequestBody();
		const keepaliveReq = new Request("https://proxy.local/v1/messages", {
			method: "POST",
			body: bodyBuffer,
			headers: {
				"Content-Type": "application/json",
				"x-better-ccflare-keepalive": "true",
			},
		});
		await proxyWithAccount(
			keepaliveReq,
			new URL("https://proxy.local/v1/messages"),
			makeAccount({
				provider: "anthropic",
				api_key: "test-key",
				access_token: null,
			}),
			makeRequestMeta(),
			bodyBuffer,
			() => undefined,
			0,
			ctx,
		);

		// Keepalive — only the initial request, no in-place retries
		expect(callCount).toBe(1);
	});
});

describe("proxyWithAccount — 401 failover", () => {
	let originalFetch: typeof globalThis.fetch;

	beforeEach(() => {
		originalFetch = globalThis.fetch;
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	it("returns null (failover) when upstream returns 401", async () => {
		globalThis.fetch = mock(async () =>
			jsonResponse(
				{ error: { type: "authentication_error", message: "Invalid API key" } },
				401,
			),
		);

		const bodyBuffer = makeRequestBody();
		const req = makeRequest(bodyBuffer);
		const result = await proxyWithAccount(
			req,
			new URL("https://proxy.local/v1/messages"),
			makeAccount(),
			makeRequestMeta(),
			bodyBuffer,
			() => undefined,
			0,
			makeProxyContext(),
		);

		expect(result).toBeNull();
	});

	it("does not failover on successful 200 response", async () => {
		globalThis.fetch = mock(async () =>
			jsonResponse(
				{
					id: "msg_1",
					type: "message",
					role: "assistant",
					content: [{ type: "text", text: "hello" }],
					model: "qwen/qwen3.6-plus:free",
					stop_reason: "end_turn",
					usage: { input_tokens: 1, output_tokens: 1 },
				},
				200,
			),
		);

		const bodyBuffer = makeRequestBody();
		const req = makeRequest(bodyBuffer);
		// proxyWithAccount reaches forwardToClient on success, which requires
		// UsageCollector initialization (not wired in unit tests). Catch that
		// specific error while still verifying no failover (null) occurred.
		let result: Response | null = null;
		let threwUsageCollectorError = false;
		try {
			result = await proxyWithAccount(
				req,
				new URL("https://proxy.local/v1/messages"),
				makeAccount(),
				makeRequestMeta(),
				bodyBuffer,
				() => undefined,
				0,
				makeProxyContext(),
			);
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			if (!msg.includes("UsageCollector not initialized")) throw e;
			threwUsageCollectorError = true;
		}

		if (result) {
			expect(result.status).toBe(200);
		} else {
			// Reaching forwardToClient (which throws UsageCollector not initialized)
			// itself proves the success path was taken and no failover (null) occurred.
			expect(threwUsageCollectorError).toBe(true);
		}
	});
});
