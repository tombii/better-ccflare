import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import type { Account, RequestMeta } from "@better-ccflare/types";
import { proxyWithAccount } from "../proxy-operations";
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
		session_start: null,
		session_request_count: 0,
		paused: false,
		rate_limit_reset: null,
		rate_limit_status: null,
		rate_limit_remaining: null,
		priority: 0,
		auto_fallback_enabled: false,
		auto_refresh_enabled: false,
		custom_endpoint: "https://openrouter.ai/api/v1",
		model_mappings: JSON.stringify({ sonnet: "qwen/qwen3.6-plus:free" }),
		cross_region_mode: null,
		model_fallbacks: null,
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

function makeProxyContext(): ProxyContext {
	return {
		strategy: { getNextAccount: () => null } as never,
		dbOps: {
			markAccountRateLimited: mock(() => Promise.resolve()),
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
		usageWorker: { postMessage: mock(() => {}) } as never,
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

		expect(result).not.toBeNull();
		expect(result?.status).toBe(200);
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
		const result = await proxyWithAccount(
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

		expect(result).not.toBeNull();
		expect(result?.status).toBe(200);
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

		expect(result).not.toBeNull();
		expect(result?.status).toBe(200);
	});
});
