import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	mock,
	spyOn,
} from "bun:test";
import type { Account, RequestMeta } from "@better-ccflare/types";
import { proxyWithAccount } from "../handlers/proxy-operations";
import type { ProxyContext } from "../handlers/proxy-types";
import { canAttemptStaleTokenRefresh } from "../handlers/stale-token-retry";
import * as usageCollectorModule from "../usage-collector";

function makeOAuthAccount(overrides: Partial<Account> = {}): Account {
	return {
		id: "oauth-acc-1",
		name: "claude-oauth-test",
		provider: "claude-oauth",
		api_key: null,
		refresh_token: "refresh-token",
		access_token: "stale-access-token",
		expires_at: Date.now() + 60 * 60 * 1000,
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
		refresh_token_issued_at: Date.now(),
		consecutive_rate_limits: 0,
		...overrides,
	};
}

function makeRequestMeta(): RequestMeta {
	return {
		id: "req-stale-1",
		method: "POST",
		path: "/v1/messages",
		timestamp: Date.now(),
		headers: new Headers(),
	};
}

function makeRequestBody() {
	return new TextEncoder().encode(
		JSON.stringify({
			model: "claude-sonnet-4-5",
			messages: [{ role: "user", content: "hello" }],
			max_tokens: 10,
		}),
	).buffer;
}

function jsonResponse(body: object, status: number) {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

function makeOAuthProxyContext(
	refreshToken = mock(() =>
		Promise.resolve({
			accessToken: "fresh-access-token",
			expiresAt: Date.now() + 60 * 60 * 1000,
			refreshToken: "refresh-token",
		}),
	),
): ProxyContext {
	return {
		strategy: { getNextAccount: () => null } as never,
		dbOps: {
			markAccountRateLimited: mock(() => Promise.resolve(1)),
			saveRequest: mock(() => Promise.resolve()),
			updateAccountUsage: mock(() => Promise.resolve()),
			updateAccountTokens: mock(() => Promise.resolve()),
			getAccount: mock(() => Promise.resolve(null)),
			getAdapter: mock(() => ({
				run: mock(() => Promise.resolve()),
				get: mock(() => Promise.resolve(null)),
			})),
		} as never,
		runtime: { port: 8080, clientId: "test-client" } as never,
		provider: {
			name: "anthropic",
			canHandle: () => true,
			buildUrl: () => "https://api.anthropic.com/v1/messages",
			prepareHeaders: (_headers: Headers, token: string) =>
				new Headers({ Authorization: `Bearer ${token}` }),
			transformRequestBody: null,
			processResponse: async (r: Response) => r,
			parseRateLimit: () => ({
				isRateLimited: false,
				resetTime: undefined,
				statusHeader: undefined,
				remaining: undefined,
			}),
			isStreamingResponse: () => false,
			refreshToken,
		} as never,
		refreshInFlight: new Map(),
		asyncWriter: { enqueue: mock((fn: () => Promise<void>) => fn()) } as never,
		config: { getStorePayloads: () => false } as never,
	};
}

describe("canAttemptStaleTokenRefresh", () => {
	it("returns true for OAuth accounts with refresh tokens", () => {
		expect(canAttemptStaleTokenRefresh(makeOAuthAccount())).toBe(true);
	});

	it("returns false for API-key-only providers", () => {
		expect(
			canAttemptStaleTokenRefresh(
				makeOAuthAccount({
					provider: "openai-compatible",
					api_key: "key",
					refresh_token: "key",
					access_token: null,
				}),
			),
		).toBe(false);
	});
});

describe("proxyWithAccount — stale token refresh retry", () => {
	let originalFetch: typeof globalThis.fetch;

	beforeEach(() => {
		originalFetch = globalThis.fetch;
		spyOn(usageCollectorModule, "getUsageCollector").mockReturnValue({
			handleStart: mock(() => {}),
			handleEnd: mock(() => Promise.resolve()),
			handleChunk: mock(() => {}),
		} as unknown as usageCollectorModule.UsageCollector);
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	it("refreshes and retries once when upstream returns 401 for OAuth account", async () => {
		let fetchCalls = 0;
		globalThis.fetch = mock(async () => {
			fetchCalls++;
			if (fetchCalls === 1) {
				return jsonResponse(
					{
						error: {
							type: "authentication_error",
							message: "Invalid bearer token",
						},
					},
					401,
				);
			}
			return jsonResponse(
				{
					id: "msg_1",
					type: "message",
					role: "assistant",
					content: [{ type: "text", text: "ok" }],
					model: "claude-sonnet-4-5",
					stop_reason: "end_turn",
					usage: { input_tokens: 1, output_tokens: 1 },
				},
				200,
			);
		});

		const refreshToken = mock(() =>
			Promise.resolve({
				accessToken: "fresh-access-token",
				expiresAt: Date.now() + 60 * 60 * 1000,
				refreshToken: "refresh-token",
			}),
		);
		const ctx = makeOAuthProxyContext(refreshToken);
		const bodyBuffer = makeRequestBody();
		const req = new Request("https://proxy.local/v1/messages", {
			method: "POST",
			body: bodyBuffer,
			headers: { "Content-Type": "application/json" },
		});

		const result = await proxyWithAccount(
			req,
			new URL("https://proxy.local/v1/messages"),
			makeOAuthAccount(),
			makeRequestMeta(),
			bodyBuffer,
			() => undefined,
			0,
			ctx,
		);

		expect(result).not.toBeNull();
		expect(result?.status).toBe(200);
		expect(fetchCalls).toBe(2);
		expect(refreshToken).toHaveBeenCalledTimes(1);
	});

	it("fails over when refresh fails after upstream 401", async () => {
		globalThis.fetch = mock(async () =>
			jsonResponse(
				{
					error: {
						type: "authentication_error",
						message: "Invalid bearer token",
					},
				},
				401,
			),
		);

		const refreshToken = mock(() => Promise.reject(new Error("invalid_grant")));
		const ctx = makeOAuthProxyContext(refreshToken);
		const bodyBuffer = makeRequestBody();
		const req = new Request("https://proxy.local/v1/messages", {
			method: "POST",
			body: bodyBuffer,
			headers: { "Content-Type": "application/json" },
		});

		const result = await proxyWithAccount(
			req,
			new URL("https://proxy.local/v1/messages"),
			makeOAuthAccount(),
			makeRequestMeta(),
			bodyBuffer,
			() => undefined,
			0,
			ctx,
		);

		expect(result).toBeNull();
		expect(refreshToken).toHaveBeenCalledTimes(1);
	});
});
