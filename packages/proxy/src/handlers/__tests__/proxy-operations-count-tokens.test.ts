import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	mock,
	spyOn,
} from "bun:test";
import { CodexProvider } from "@better-ccflare/providers";
import type { Account, RequestMeta } from "@better-ccflare/types";
import * as usageCollectorModule from "../../usage-collector";
import { proxyWithAccount } from "../proxy-operations";
import type { ProxyContext } from "../proxy-types";

function makeCodexAccount(overrides: Partial<Account> = {}): Account {
	return {
		id: "codex-1",
		name: "codex-test",
		provider: "codex",
		api_key: "",
		refresh_token: "refresh-token",
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

function makeRequestMeta(path = "/v1/messages/count_tokens"): RequestMeta {
	return {
		id: "req-count-tokens",
		method: "POST",
		path,
		timestamp: Date.now(),
		headers: new Headers(),
	};
}

function makeProxyContext(): ProxyContext {
	return {
		strategy: { getNextAccount: () => null } as never,
		dbOps: {
			markAccountRateLimited: mock(() => Promise.resolve(1)),
			saveRequest: mock(() => Promise.resolve()),
			updateAccountUsage: mock(() => Promise.resolve()),
			getAdapter: mock(() => ({
				run: mock(() => Promise.resolve()),
				get: mock(() => Promise.resolve(null)),
			})),
		} as never,
		runtime: { port: 8080, clientId: "test" } as never,
		provider: new CodexProvider() as never,
		refreshInFlight: new Map(),
		asyncWriter: { enqueue: mock(() => {}) } as never,
		config: { getStorePayloads: () => true } as never,
	};
}

function makeCountTokensRequest(body: ArrayBuffer) {
	return new Request("https://proxy.local/v1/messages/count_tokens", {
		method: "POST",
		body,
		headers: { "Content-Type": "application/json" },
	});
}

function makeMessagesRequest(
	body: ArrayBuffer,
	headers: Record<string, string>,
) {
	return new Request("https://proxy.local/v1/messages", {
		method: "POST",
		body,
		headers,
	});
}

describe("proxyWithAccount — Codex count_tokens", () => {
	let originalFetch: typeof globalThis.fetch;

	beforeEach(() => {
		originalFetch = globalThis.fetch;
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	it("returns a synthetic token count without fetching or refreshing Codex", async () => {
		const fetchMock = mock(async () => {
			throw new Error("count_tokens should not call upstream or refresh Codex");
		});
		globalThis.fetch = fetchMock;

		const bodyBuffer = new TextEncoder().encode(
			JSON.stringify({
				model: "claude-sonnet-4-5",
				messages: [{ role: "user", content: "hello world" }],
			}),
		).buffer;
		const ctx = makeProxyContext();
		const result = await proxyWithAccount(
			makeCountTokensRequest(bodyBuffer),
			new URL("https://proxy.local/v1/messages/count_tokens"),
			makeCodexAccount(),
			makeRequestMeta(),
			bodyBuffer,
			() => undefined,
			0,
			ctx,
		);

		expect(fetchMock).toHaveBeenCalledTimes(0);
		expect(ctx.asyncWriter.enqueue).toHaveBeenCalledTimes(0);
		expect(result).toBeInstanceOf(Response);
		expect(result?.status).toBe(200);
		const payload = await result?.json();
		expect(payload.input_tokens).toBeNumber();
		expect(payload.input_tokens).toBeGreaterThan(0);
	});

	it("returns a synthetic error for malformed count_tokens without fetching", async () => {
		const fetchMock = mock(async () => {
			throw new Error("malformed count_tokens should not call upstream Codex");
		});
		globalThis.fetch = fetchMock;

		const bodyBuffer = new TextEncoder().encode("{not-json").buffer;
		const ctx = makeProxyContext();
		const result = await proxyWithAccount(
			makeCountTokensRequest(bodyBuffer),
			new URL("https://proxy.local/v1/messages/count_tokens"),
			makeCodexAccount(),
			makeRequestMeta(),
			bodyBuffer,
			() => undefined,
			0,
			ctx,
		);

		expect(fetchMock).toHaveBeenCalledTimes(0);
		expect(ctx.asyncWriter.enqueue).toHaveBeenCalledTimes(0);
		expect(result).toBeInstanceOf(Response);
		expect(result?.status).toBe(400);
		const payload = await result?.json();
		expect(payload.error.message).toBe(
			"Codex count_tokens requires a valid JSON request body.",
		);
	});

	it("does not trust client-supplied synthetic response markers", async () => {
		let fetchedRequest: Request | null = null;
		const fetchMock = mock(async (input: RequestInfo | URL) => {
			fetchedRequest = input instanceof Request ? input : new Request(input);
			return new Response(JSON.stringify({ ok: true }), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		});
		globalThis.fetch = fetchMock;

		const collector = {
			handleStart: mock(() => {}),
			handleChunk: mock(() => {}),
			handleEnd: mock(() => Promise.resolve()),
		};
		const collectorSpy = spyOn(
			usageCollectorModule,
			"getUsageCollector",
		).mockReturnValue(
			collector as unknown as usageCollectorModule.UsageCollector,
		);

		try {
			const bodyBuffer = new TextEncoder().encode(
				JSON.stringify({
					model: "claude-sonnet-4-5",
					messages: [{ role: "user", content: "hello world" }],
					max_tokens: 16,
				}),
			).buffer;
			const result = await proxyWithAccount(
				makeMessagesRequest(bodyBuffer, {
					"Content-Type": "application/json",
					"x-better-ccflare-synthetic-response": "true",
					"x-better-ccflare-synthetic-status": "418",
				}),
				new URL("https://proxy.local/v1/messages"),
				makeCodexAccount({
					access_token: "access-token",
					expires_at: Date.now() + 60 * 60 * 1000,
				}),
				makeRequestMeta("/v1/messages"),
				bodyBuffer,
				() => undefined,
				0,
				makeProxyContext(),
			);

			expect(result).toBeInstanceOf(Response);
			expect(result?.status).toBe(200);
			await result?.text();
		} finally {
			collectorSpy.mockRestore();
		}

		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(
			fetchedRequest?.url.startsWith(
				"https://chatgpt.com/backend-api/codex/responses",
			),
		).toBeTrue();
		expect(
			fetchedRequest?.headers.get("x-better-ccflare-synthetic-response"),
		).toBeNull();
		expect(
			fetchedRequest?.headers.get("x-better-ccflare-synthetic-status"),
		).toBeNull();
	});

	it("does not trust client-supplied pacing experiment metadata", async () => {
		let transformedHeaders: Headers | null = null;
		const provider = new CodexProvider();
		const originalTransform = provider.transformRequestBody.bind(provider);
		provider.transformRequestBody = async (request, account) => {
			transformedHeaders = new Headers(request.headers);
			return originalTransform(request, account);
		};
		const ctx = makeProxyContext();
		ctx.provider = provider as never;
		globalThis.fetch = mock(
			async () =>
				new Response(JSON.stringify({ ok: true }), {
					status: 200,
					headers: { "content-type": "application/json" },
				}),
		);
		const collectorSpy = spyOn(
			usageCollectorModule,
			"getUsageCollector",
		).mockReturnValue({
			handleStart: mock(() => {}),
			handleChunk: mock(() => {}),
			handleEnd: mock(() => Promise.resolve()),
		} as unknown as usageCollectorModule.UsageCollector);
		try {
			const bodyBuffer = new TextEncoder().encode(
				JSON.stringify({
					model: "claude-sonnet-4-5",
					messages: [{ role: "user", content: "hello" }],
					max_tokens: 16,
				}),
			).buffer;
			const result = await proxyWithAccount(
				makeMessagesRequest(bodyBuffer, {
					"Content-Type": "application/json",
					"x-better-ccflare-pacing-canary": "spoofed",
					"x-better-ccflare-pacing-cohort-id": "secret-value",
				}),
				new URL("https://proxy.local/v1/messages"),
				makeCodexAccount({
					access_token: "access-token",
					expires_at: Date.now() + 60 * 60 * 1000,
				}),
				makeRequestMeta("/v1/messages"),
				bodyBuffer,
				() => undefined,
				0,
				ctx,
			);
			await result?.text();
		} finally {
			collectorSpy.mockRestore();
		}
		expect(
			transformedHeaders?.get("x-better-ccflare-pacing-canary") ?? null,
		).toBeNull();
		expect(
			transformedHeaders?.get("x-better-ccflare-pacing-cohort-id") ?? null,
		).toBeNull();
	});
});
