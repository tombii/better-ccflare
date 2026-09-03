import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import type { Account, RequestMeta } from "@better-ccflare/types";
import { proxyWithAccount } from "../proxy-operations";
import type { ProxyContext } from "../proxy-types";

/**
 * The in-place 529 retry must not be gated on rlInfo.isRateLimited.
 * BaseProvider/ZaiProvider.parseRateLimit answers isRateLimited only for
 * 429, so on a reset-less 529 it always returns false — if proxyWithAccount
 * consulted isRateLimited here, the in-place retry branch was dead for zai
 * and the inner loop broke out after one attempt regardless of
 * CCFLARE_OVERLOAD_RETRY_MAX_ATTEMPTS. Behavioral test through the
 * proxyWithAccount seam (replacing an earlier source-regex test).
 */

function makeAccount(): Account {
	return {
		id: "acc-1",
		name: "retry-gate-test",
		// Unregistered name so the stub provider below is used
		provider: "stub-retry-gate",
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

function makeRequestBody() {
	const body = JSON.stringify({
		model: "glm-4.6",
		messages: [{ role: "user", content: "hello" }],
		max_tokens: 10,
	});
	return new TextEncoder().encode(body).buffer;
}

function makeProxyContext(provider: object): ProxyContext {
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
		provider: provider as never,
		refreshInFlight: new Map(),
		asyncWriter: { enqueue: mock(() => {}) } as never,
		config: { getStorePayloads: () => true } as never,
		internalProbeSecret: "test-secret",
	};
}

function error529() {
	return new Response(
		JSON.stringify({
			type: "error",
			error: { type: "overloaded_error", message: "Overloaded" },
		}),
		{ status: 529, headers: { "Content-Type": "application/json" } },
	);
}

function ok200() {
	return new Response(
		JSON.stringify({
			id: "msg_1",
			type: "message",
			role: "assistant",
			content: [{ type: "text", text: "hi" }],
			model: "glm-4.6",
			stop_reason: "end_turn",
			usage: { input_tokens: 1, output_tokens: 1 },
		}),
		{ status: 200, headers: { "Content-Type": "application/json" } },
	);
}

async function run(
	provider: object,
	fetchImpl: typeof globalThis.fetch,
): Promise<void> {
	const originalFetch = globalThis.fetch;
	globalThis.fetch = fetchImpl as never;
	const bodyBuffer = makeRequestBody();
	const req = new Request("https://proxy.local/v1/messages", {
		method: "POST",
		body: bodyBuffer,
		headers: { "Content-Type": "application/json" },
	});
	try {
		await proxyWithAccount(
			req,
			new URL("https://proxy.local/v1/messages"),
			makeAccount(),
			makeRequestMeta(),
			bodyBuffer,
			() => undefined,
			0,
			makeProxyContext(provider),
		);
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		if (!msg.includes("UsageCollector not initialized")) throw e;
	} finally {
		globalThis.fetch = originalFetch;
	}
}

describe("proxyWithAccount — 529 in-place retry gate", () => {
	const savedEnv: Record<string, string | undefined> = {};
	const ENV_KEYS = [
		"CCFLARE_OVERLOAD_RETRY_ENABLED",
		"CCFLARE_OVERLOAD_RETRY_MAX_ATTEMPTS",
		"CCFLARE_OVERLOAD_RETRY_BASE_MS",
		"CCFLARE_OVERLOAD_RETRY_MAX_MS",
	];

	beforeEach(() => {
		for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
		process.env.CCFLARE_OVERLOAD_RETRY_ENABLED = "true";
		process.env.CCFLARE_OVERLOAD_RETRY_BASE_MS = "0";
		process.env.CCFLARE_OVERLOAD_RETRY_MAX_MS = "0";
	});

	afterEach(() => {
		for (const key of ENV_KEYS) {
			if (savedEnv[key] === undefined) delete process.env[key];
			else process.env[key] = savedEnv[key];
		}
	});

	it("retries in place on a 529 where isRateLimited is false (zai-like provider)", async () => {
		process.env.CCFLARE_OVERLOAD_RETRY_MAX_ATTEMPTS = "2";
		let fetchCount = 0;
		// ZaiProvider.parseRateLimit: isRateLimited only for 429, never a
		// resetTime on a 529 — the old gate made the retry branch dead here.
		const zaiLikeProvider = {
			name: "stub-retry-gate",
			canHandle: () => true,
			buildUrl: () => "https://upstream.local/v1/messages",
			prepareHeaders: () => new Headers(),
			processResponse: async (response: Response) => response,
			parseRateLimit: (response: Response) => ({
				isRateLimited: response.status === 429,
				resetTime: undefined,
			}),
			isStreamingResponse: () => false,
		};

		await run(
			zaiLikeProvider,
			mock(async () => {
				fetchCount++;
				return fetchCount === 1 ? error529() : ok200();
			}),
		);

		expect(fetchCount).toBe(2);
	});

	it("honors the full retry budget on persistent reset-less 529s", async () => {
		process.env.CCFLARE_OVERLOAD_RETRY_MAX_ATTEMPTS = "3";
		let fetchCount = 0;
		const zaiLikeProvider = {
			name: "stub-retry-gate",
			canHandle: () => true,
			buildUrl: () => "https://upstream.local/v1/messages",
			prepareHeaders: () => new Headers(),
			processResponse: async (response: Response) => response,
			parseRateLimit: (response: Response) => ({
				isRateLimited: response.status === 429,
				resetTime: undefined,
			}),
			isStreamingResponse: () => false,
		};

		await run(
			zaiLikeProvider,
			mock(async () => {
				fetchCount++;
				return error529();
			}),
		);

		expect(fetchCount).toBe(3);
	});

	it("does not retry in place when the 529 carries a reset time", async () => {
		process.env.CCFLARE_OVERLOAD_RETRY_MAX_ATTEMPTS = "3";
		let fetchCount = 0;
		const providerWithReset = {
			name: "stub-retry-gate",
			canHandle: () => true,
			buildUrl: () => "https://upstream.local/v1/messages",
			prepareHeaders: () => new Headers(),
			processResponse: async (response: Response) => response,
			parseRateLimit: (response: Response) => ({
				isRateLimited: response.status === 529,
				resetTime: response.status === 529 ? Date.now() + 60_000 : undefined,
			}),
			isStreamingResponse: () => false,
		};

		await run(
			providerWithReset,
			mock(async () => {
				fetchCount++;
				return error529();
			}),
		);

		// Reset hint means processProxyResponse applies the cooldown instead.
		expect(fetchCount).toBe(1);
	});
});
