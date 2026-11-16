import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import {
	SERVED_ACCOUNT_HEADER,
	SERVED_MODEL_HEADER,
} from "@better-ccflare/core";
import type { Account, RequestMeta } from "@better-ccflare/types";
import { proxyUnauthenticated, proxyWithAccount } from "../proxy-operations";
import type { ForwardToClient, ProxyContext } from "../proxy-types";

/**
 * x-better-ccflare-served-model / x-better-ccflare-served-account tell the
 * client which account and which upstream model answered. The response body's
 * `model` echoes the requested alias, so without these a combo that remaps an
 * alias onto another provider's model is invisible to the caller.
 */

function makeAccount(overrides: Partial<Account> = {}): Account {
	return {
		id: "acc-served-1",
		name: "served-test",
		// Unregistered provider name: proxyWithAccount falls back to ctx.provider.
		provider: "stub-served-headers",
		api_key: "sk-secret-never-in-headers",
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
		custom_endpoint: "https://upstream.local/v1",
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
		id: "req-served-1",
		method: "POST",
		path: "/v1/messages",
		timestamp: Date.now(),
		headers: new Headers(),
	};
}

function makeBody(model = "claude-sonnet-4-5", stream = false): ArrayBuffer {
	return new TextEncoder().encode(
		JSON.stringify({
			model,
			messages: [{ role: "user", content: "hello" }],
			max_tokens: 10,
			stream,
		}),
	).buffer;
}

function makeRequest(body: ArrayBuffer): Request {
	return new Request("https://proxy.local/v1/messages", {
		method: "POST",
		body,
		headers: { "Content-Type": "application/json" },
	});
}

/** Forwarding seam that skips the usage collector and returns the response. */
const passthroughForward: ForwardToClient = async (options) => options.response;

interface StubOptions {
	/** Simulates provider model mapping: rewrites body.model before sending. */
	mapModel?: (model: string) => string;
	/** Simulates Vertex: the model is addressed in the URL and removed from the body. */
	dropModelFromBody?: boolean;
	/** The provider's answer to "which model is in the URL" (Vertex only). */
	targetModel?: string;
	streaming?: boolean;
}

function makeProxyContext(stub: StubOptions = {}): ProxyContext {
	return {
		strategy: { getNextAccount: () => null } as never,
		dbOps: {
			markAccountRateLimited: mock(() =>
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
		provider: {
			name: "openai-compatible",
			canHandle: () => true,
			buildUrl: () => "https://upstream.local/v1/messages",
			prepareHeaders: () => new Headers(),
			getTargetModel: stub.targetModel ? () => stub.targetModel : undefined,
			transformRequestBody: stub.dropModelFromBody
				? async (request: Request) => {
						const body = (await request.clone().json()) as Record<
							string,
							unknown
						>;
						delete body.model;
						return new Request(request.url, {
							method: request.method,
							headers: request.headers,
							body: JSON.stringify(body),
						});
					}
				: stub.mapModel
					? async (request: Request) => {
							const body = (await request.clone().json()) as {
								model: string;
							};
							const mapModel = stub.mapModel as (model: string) => string;
							return new Request(request.url, {
								method: request.method,
								headers: request.headers,
								body: JSON.stringify({ ...body, model: mapModel(body.model) }),
							});
						}
					: null,
			processResponse: async (response: Response) => response,
			parseRateLimit: () => ({
				isRateLimited: false,
				resetTime: undefined,
				statusHeader: "allowed",
				remaining: undefined,
			}),
			isStreamingResponse: () => stub.streaming ?? false,
		} as never,
		refreshInFlight: new Map(),
		asyncWriter: { enqueue: mock(() => {}) } as never,
		config: { getStorePayloads: () => true } as never,
		internalProbeSecret: "test-secret",
		forwardToClient: passthroughForward,
	};
}

function messageJson(model: string, status = 200): Response {
	return new Response(
		JSON.stringify({
			id: "msg_1",
			type: "message",
			role: "assistant",
			content: [{ type: "text", text: "hi" }],
			model,
			stop_reason: "end_turn",
			usage: { input_tokens: 1, output_tokens: 1 },
		}),
		{ status, headers: { "Content-Type": "application/json" } },
	);
}

const SSE_BODY =
	'event: message_start\ndata: {"type":"message_start","message":{"model":"x"}}\n\n' +
	'event: message_stop\ndata: {"type":"message_stop"}\n\n';

describe("proxyWithAccount — served model/account response headers", () => {
	let originalFetch: typeof globalThis.fetch;
	let sentModels: string[];

	beforeEach(() => {
		originalFetch = globalThis.fetch;
		sentModels = [];
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	function captureSentModel(input: RequestInfo | URL): Promise<string> {
		const request = input instanceof Request ? input : null;
		return request
			? request
					.clone()
					.json()
					.then((b) => {
						const model = (b as { model: string }).model;
						sentModels.push(model);
						return model;
					})
			: Promise.resolve("");
	}

	it("plain routing, non-stream: reports the account and the model after provider mapping", async () => {
		globalThis.fetch = mock(async (input: RequestInfo | URL) => {
			const model = await captureSentModel(input);
			return messageJson(model);
		}) as unknown as typeof fetch;

		const body = makeBody("claude-sonnet-4-5");
		const response = await proxyWithAccount(
			makeRequest(body),
			new URL("https://proxy.local/v1/messages"),
			makeAccount({ name: "openrouter-main" }),
			makeRequestMeta(),
			body,
			() => undefined,
			0,
			makeProxyContext({ mapModel: () => "qwen/qwen3-coder" }),
		);

		expect(response).not.toBeNull();
		expect(sentModels).toEqual(["qwen/qwen3-coder"]);
		expect(response?.headers.get(SERVED_MODEL_HEADER)).toBe("qwen/qwen3-coder");
		expect(response?.headers.get(SERVED_ACCOUNT_HEADER)).toBe(
			"openrouter-main",
		);
		// The body is untouched by the decoration.
		expect(((await response?.json()) as { model: string }).model).toBe(
			"qwen/qwen3-coder",
		);
	});

	it("URL-addressed model (Vertex): reports the provider's target model, never the requested alias", async () => {
		globalThis.fetch = mock(async () =>
			messageJson("claude-sonnet-4-6"),
		) as unknown as typeof fetch;

		const body = makeBody("claude-sonnet-4-6");
		const response = await proxyWithAccount(
			makeRequest(body),
			new URL("https://proxy.local/v1/messages"),
			makeAccount({ name: "vertex-main" }),
			makeRequestMeta(),
			body,
			() => undefined,
			0,
			makeProxyContext({
				dropModelFromBody: true,
				targetModel: "claude-haiku-4-5@20251001",
			}),
		);

		expect(response).not.toBeNull();
		expect(response?.headers.get(SERVED_MODEL_HEADER)).toBe(
			"claude-haiku-4-5@20251001",
		);
		expect(response?.headers.get(SERVED_ACCOUNT_HEADER)).toBe("vertex-main");
	});

	it("combo slot override: reports the slot model (routing suffix stripped), not the requested alias", async () => {
		globalThis.fetch = mock(async (input: RequestInfo | URL) => {
			const model = await captureSentModel(input);
			return messageJson(model);
		}) as unknown as typeof fetch;

		const body = makeBody("claude-opus-4-5");
		const response = await proxyWithAccount(
			makeRequest(body),
			new URL("https://proxy.local/v1/messages"),
			makeAccount({ name: "zai-slot" }),
			makeRequestMeta(),
			body,
			() => undefined,
			0,
			makeProxyContext(),
			'glm-5.1 {"only":["z-ai"]}',
		);

		expect(sentModels).toEqual(["glm-5.1"]);
		expect(response?.headers.get(SERVED_MODEL_HEADER)).toBe("glm-5.1");
		expect(response?.headers.get(SERVED_ACCOUNT_HEADER)).toBe("zai-slot");
	});

	it("combo slot override is still subject to provider model mapping", async () => {
		globalThis.fetch = mock(async (input: RequestInfo | URL) => {
			const model = await captureSentModel(input);
			return messageJson(model);
		}) as unknown as typeof fetch;

		const body = makeBody("claude-opus-4-5");
		const response = await proxyWithAccount(
			makeRequest(body),
			new URL("https://proxy.local/v1/messages"),
			makeAccount({ name: "mapped-slot" }),
			makeRequestMeta(),
			body,
			() => undefined,
			0,
			makeProxyContext({ mapModel: (m) => `vendor/${m}` }),
			"claude-sonnet-4-5",
		);

		expect(sentModels).toEqual(["vendor/claude-sonnet-4-5"]);
		expect(response?.headers.get(SERVED_MODEL_HEADER)).toBe(
			"vendor/claude-sonnet-4-5",
		);
	});

	it("streaming: headers are set and the SSE body passes through unchanged", async () => {
		globalThis.fetch = mock(async (input: RequestInfo | URL) => {
			await captureSentModel(input);
			return new Response(SSE_BODY, {
				status: 200,
				headers: { "Content-Type": "text/event-stream" },
			});
		}) as unknown as typeof fetch;

		const body = makeBody("claude-sonnet-4-5", true);
		const response = await proxyWithAccount(
			makeRequest(body),
			new URL("https://proxy.local/v1/messages"),
			makeAccount({ name: "stream-acct" }),
			makeRequestMeta(),
			body,
			() => undefined,
			0,
			makeProxyContext({ streaming: true }),
			"kimi-k2",
		);

		expect(response?.headers.get("content-type")).toBe("text/event-stream");
		expect(response?.headers.get(SERVED_MODEL_HEADER)).toBe("kimi-k2");
		expect(response?.headers.get(SERVED_ACCOUNT_HEADER)).toBe("stream-acct");
		expect(await response?.text()).toBe(SSE_BODY);
	});

	it("upstream error passed through to the client still carries the headers", async () => {
		globalThis.fetch = mock(async (input: RequestInfo | URL) => {
			await captureSentModel(input);
			return new Response(
				JSON.stringify({
					type: "error",
					error: { type: "invalid_request_error", message: "bad field" },
				}),
				{ status: 400, headers: { "Content-Type": "application/json" } },
			);
		}) as unknown as typeof fetch;

		const body = makeBody("claude-sonnet-4-5");
		const response = await proxyWithAccount(
			makeRequest(body),
			new URL("https://proxy.local/v1/messages"),
			makeAccount({ name: "err-acct" }),
			makeRequestMeta(),
			body,
			() => undefined,
			0,
			makeProxyContext(),
		);

		expect(response?.status).toBe(400);
		expect(response?.headers.get(SERVED_MODEL_HEADER)).toBe(
			"claude-sonnet-4-5",
		);
		expect(response?.headers.get(SERVED_ACCOUNT_HEADER)).toBe("err-acct");
	});

	it("overwrites served headers an upstream (e.g. a chained proxy) already set", async () => {
		globalThis.fetch = mock(async () => {
			const response = messageJson("whatever");
			response.headers.set(SERVED_MODEL_HEADER, "spoofed-model");
			response.headers.set(SERVED_ACCOUNT_HEADER, "spoofed-account");
			return response;
		}) as unknown as typeof fetch;

		const body = makeBody("claude-sonnet-4-5");
		const response = await proxyWithAccount(
			makeRequest(body),
			new URL("https://proxy.local/v1/messages"),
			makeAccount({ name: "real-acct" }),
			makeRequestMeta(),
			body,
			() => undefined,
			0,
			makeProxyContext(),
		);

		expect(response?.headers.get(SERVED_MODEL_HEADER)).toBe(
			"claude-sonnet-4-5",
		);
		expect(response?.headers.get(SERVED_ACCOUNT_HEADER)).toBe("real-acct");
	});

	it("never exposes the account id or key, and encodes a name that is not a valid header value", async () => {
		globalThis.fetch = mock(async () =>
			messageJson("m"),
		) as unknown as typeof fetch;

		const body = makeBody("claude-sonnet-4-5");
		const response = await proxyWithAccount(
			makeRequest(body),
			new URL("https://proxy.local/v1/messages"),
			makeAccount({ name: "Équipe 1" }),
			makeRequestMeta(),
			body,
			() => undefined,
			0,
			makeProxyContext(),
		);

		expect(response?.headers.get(SERVED_ACCOUNT_HEADER)).toBe(
			encodeURIComponent("Équipe 1"),
		);
		const all = [...(response?.headers.entries() ?? [])]
			.map(([k, v]) => `${k}:${v}`)
			.join("\n");
		expect(all).not.toContain("acc-served-1");
		expect(all).not.toContain("sk-secret-never-in-headers");
	});

	it("a failed attempt that fails over returns null (nothing to decorate)", async () => {
		globalThis.fetch = mock(
			async () => new Response("unauthorized", { status: 401 }),
		) as unknown as typeof fetch;

		const body = makeBody("claude-sonnet-4-5");
		const response = await proxyWithAccount(
			makeRequest(body),
			new URL("https://proxy.local/v1/messages"),
			makeAccount(),
			makeRequestMeta(),
			body,
			() => undefined,
			0,
			makeProxyContext(),
		);

		expect(response).toBeNull();
	});
});

describe("proxyWithAccount — served model after the model-fallback loop", () => {
	let originalFetch: typeof globalThis.fetch;

	beforeEach(() => {
		originalFetch = globalThis.fetch;
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	it("reports the fallback model that actually answered, not the first one tried", async () => {
		// Real openai-compatible provider (registered), so its model mapping and
		// model_fallbacks cycling run exactly as in production.
		const sent: string[] = [];
		globalThis.fetch = mock(async (input: RequestInfo | URL) => {
			const request = input as Request;
			const body = (await request.clone().json()) as { model: string };
			sent.push(body.model);
			if (sent.length === 1) {
				return new Response(
					JSON.stringify({
						error: {
							type: "api_error",
							message: "Rate limit exceeded: limit_rpm/model/abc",
						},
					}),
					{ status: 429, headers: { "Content-Type": "application/json" } },
				);
			}
			return new Response(
				JSON.stringify({
					id: "chatcmpl-1",
					object: "chat.completion",
					model: body.model,
					choices: [
						{
							index: 0,
							message: { role: "assistant", content: "hi" },
							finish_reason: "stop",
						},
					],
					usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);
		}) as unknown as typeof fetch;

		const body = makeBody("claude-sonnet-4-5");
		const ctx = makeProxyContext();
		const response = await proxyWithAccount(
			makeRequest(body),
			new URL("https://proxy.local/v1/messages"),
			makeAccount({
				name: "kilo-fallback",
				provider: "openai-compatible",
				custom_endpoint: "https://openrouter.ai/api/v1",
				model_mappings: JSON.stringify({ sonnet: "qwen/qwen3.6-plus:free" }),
				model_fallbacks: JSON.stringify({
					sonnet: "bytedance-seed/dola-seed-2.0-pro:free",
				}),
			}),
			makeRequestMeta(),
			body,
			() => undefined,
			0,
			ctx,
		);

		expect(sent).toEqual([
			"qwen/qwen3.6-plus:free",
			"bytedance-seed/dola-seed-2.0-pro:free",
		]);
		expect(response?.status).toBe(200);
		expect(response?.headers.get(SERVED_MODEL_HEADER)).toBe(
			"bytedance-seed/dola-seed-2.0-pro:free",
		);
		expect(response?.headers.get(SERVED_ACCOUNT_HEADER)).toBe("kilo-fallback");
	});
});

describe("proxyUnauthenticated — no account, no served headers", () => {
	let originalFetch: typeof globalThis.fetch;

	beforeEach(() => {
		originalFetch = globalThis.fetch;
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	it("does not add served headers when no account was used", async () => {
		globalThis.fetch = mock(async () =>
			messageJson("m"),
		) as unknown as typeof fetch;
		const body = makeBody("claude-sonnet-4-5");
		const response = await proxyUnauthenticated(
			makeRequest(body),
			new URL("https://proxy.local/v1/messages"),
			makeRequestMeta(),
			body,
			() => undefined,
			makeProxyContext(),
		);
		expect(response.headers.has(SERVED_MODEL_HEADER)).toBe(false);
		expect(response.headers.has(SERVED_ACCOUNT_HEADER)).toBe(false);
	});
});
