import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import type { Account, RequestMeta } from "@better-ccflare/types";
import { proxyWithAccount } from "../proxy-operations";
import type { ProxyContext } from "../proxy-types";

/**
 * The in-place 529 retry re-invokes processResponse with a re-tagged retry
 * response. Providers (codex) read x-better-ccflare-request-stream and
 * x-better-ccflare-codex-custom-tools from response headers, with only a
 * 30s-TTL map as fallback — a long backoff plus a concurrent sweep can evict
 * that entry, so the retry response must carry the same metadata headers the
 * first response got, not just the request ID.
 */

function makeAccount(overrides: Partial<Account> = {}): Account {
	return {
		id: "acc-1",
		name: "retry-tagging-test",
		// Unregistered name: proxyWithAccount resolves getProvider(account.provider)
		// first and only falls back to ctx.provider when the registry misses, so a
		// real provider name would shadow the stub below.
		provider: "stub-retry-tagging",
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

function makeRequestBody() {
	const body = JSON.stringify({
		model: "gpt-5.1-codex",
		messages: [{ role: "user", content: "hello" }],
		max_tokens: 10,
		stream: true,
	});
	return new TextEncoder().encode(body).buffer;
}

interface SeenHeaders {
	requestId: string | null;
	requestStream: string | null;
	customTools: string | null;
	status: number;
}

function makeProxyContext(seen: SeenHeaders[]): ProxyContext {
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
			// Mirror the codex provider: stamp internal metadata headers onto the
			// transformed request so proxy-operations can tag responses from them.
			transformRequestBody: async (request: Request) => {
				const headers = new Headers(request.headers);
				headers.set("x-better-ccflare-request-stream", "true");
				headers.set("x-better-ccflare-codex-custom-tools", "true");
				return new Request(request.url, {
					method: request.method,
					headers,
					body: await request.clone().arrayBuffer(),
				});
			},
			processResponse: async (response: Response) => {
				seen.push({
					requestId: response.headers.get("x-better-ccflare-request-id"),
					requestStream: response.headers.get(
						"x-better-ccflare-request-stream",
					),
					customTools: response.headers.get(
						"x-better-ccflare-codex-custom-tools",
					),
					status: response.status,
				});
				return response;
			},
			parseRateLimit: (response: Response) => ({
				isRateLimited: response.status === 529,
				resetTime: undefined,
				statusHeader: undefined,
				remaining: undefined,
			}),
			isStreamingResponse: () => false,
		} as never,
		refreshInFlight: new Map(),
		asyncWriter: { enqueue: mock(() => {}) } as never,
		config: { getStorePayloads: () => true } as never,
		internalProbeSecret: "test-secret",
	};
}

describe("proxyWithAccount — 529 in-place retry response tagging", () => {
	let originalFetch: typeof globalThis.fetch;
	const savedEnv: Record<string, string | undefined> = {};
	const ENV_KEYS = [
		"CCFLARE_OVERLOAD_RETRY_ENABLED",
		"CCFLARE_OVERLOAD_RETRY_MAX_ATTEMPTS",
		"CCFLARE_OVERLOAD_RETRY_BASE_MS",
		"CCFLARE_OVERLOAD_RETRY_MAX_MS",
	];

	beforeEach(() => {
		originalFetch = globalThis.fetch;
		for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
		process.env.CCFLARE_OVERLOAD_RETRY_ENABLED = "true";
		process.env.CCFLARE_OVERLOAD_RETRY_MAX_ATTEMPTS = "2";
		process.env.CCFLARE_OVERLOAD_RETRY_BASE_MS = "0";
		process.env.CCFLARE_OVERLOAD_RETRY_MAX_MS = "0";
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
		for (const key of ENV_KEYS) {
			if (savedEnv[key] === undefined) delete process.env[key];
			else process.env[key] = savedEnv[key];
		}
	});

	it("re-tags stream and custom-tools metadata headers on the retry response", async () => {
		let fetchCount = 0;
		globalThis.fetch = mock(async () => {
			fetchCount++;
			if (fetchCount === 1) {
				return new Response(
					JSON.stringify({
						type: "error",
						error: { type: "overloaded_error", message: "Overloaded" },
					}),
					{ status: 529, headers: { "Content-Type": "application/json" } },
				);
			}
			return new Response(
				JSON.stringify({
					id: "msg_1",
					type: "message",
					role: "assistant",
					content: [{ type: "text", text: "hi" }],
					model: "gpt-5.1-codex",
					stop_reason: "end_turn",
					usage: { input_tokens: 1, output_tokens: 1 },
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);
		});

		const seen: SeenHeaders[] = [];
		const bodyBuffer = makeRequestBody();
		const req = new Request("https://proxy.local/v1/messages", {
			method: "POST",
			body: bodyBuffer,
			headers: { "Content-Type": "application/json" },
		});

		// forwardToClient requires UsageCollector wiring absent in unit tests;
		// the retry and both processResponse calls happen before that point.
		try {
			await proxyWithAccount(
				req,
				new URL("https://proxy.local/v1/messages"),
				makeAccount(),
				makeRequestMeta(),
				bodyBuffer,
				() => undefined,
				0,
				makeProxyContext(seen),
			);
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			if (!msg.includes("UsageCollector not initialized")) throw e;
		}

		expect(fetchCount).toBe(2);
		expect(seen).toHaveLength(2);

		expect(seen[0].status).toBe(529);
		expect(seen[0].requestId).toBe("req-1");
		expect(seen[0].requestStream).toBe("true");
		expect(seen[0].customTools).toBe("true");

		expect(seen[1].status).toBe(200);
		expect(seen[1].requestId).toBe("req-1");
		expect(seen[1].requestStream).toBe("true");
		expect(seen[1].customTools).toBe("true");
	});
});
