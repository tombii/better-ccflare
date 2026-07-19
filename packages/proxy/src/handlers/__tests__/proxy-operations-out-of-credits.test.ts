import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { usageCache } from "@better-ccflare/providers";
import type { Account, RequestMeta } from "@better-ccflare/types";
import {
	clearFamilyExhaustionCache,
	isFamilyExhausted,
} from "../model-capacity";
import { proxyWithAccount } from "../proxy-operations";
import type { ProxyContext } from "../proxy-types";

// Anthropic account fixture — the out_of_credits header is Anthropic-specific.
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

function makeProxyContextWithAsyncExec(): ProxyContext {
	const markAccountRateLimited = mock(
		(_accountId: string, _until: number, _reason: string) => Promise.resolve(1),
	);
	const saveRequest = mock((..._args: unknown[]) => Promise.resolve());
	return {
		strategy: { getNextAccount: () => null } as never,
		dbOps: {
			markAccountRateLimited,
			saveRequest,
			updateAccountUsage: mock(() => Promise.resolve()),
			getAdapter: mock(() => ({
				run: mock(() => Promise.resolve()),
				get: mock(() => Promise.resolve(null)),
			})),
		} as never,
		runtime: { port: 8080, clientId: "test" } as never,
		provider: {
			name: "anthropic",
			canHandle: () => true,
			buildUrl: (_path: string, _search: string) =>
				"https://api.anthropic.com/v1/messages",
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
	};
}

function makeRequest(body: ArrayBuffer) {
	return new Request("https://proxy.local/v1/messages", {
		method: "POST",
		body,
		headers: { "Content-Type": "application/json" },
	});
}

// 429 with the out_of_credits overage-disabled-reason header (no reset header).
function outOfCreditsResponse(): Response {
	return new Response(
		JSON.stringify({
			type: "error",
			error: {
				type: "rate_limit_error",
				message: "request rate limit exceeded",
			},
		}),
		{
			status: 429,
			headers: {
				"content-type": "application/json",
				"anthropic-ratelimit-unified-overage-disabled-reason": "out_of_credits",
				"x-should-retry": "true",
			},
		},
	);
}

describe("proxyWithAccount — out_of_credits (issue #261)", () => {
	let originalFetch: typeof globalThis.fetch;

	beforeEach(() => {
		originalFetch = globalThis.fetch;
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
		usageCache.clear();
		clearFamilyExhaustionCache();
	});

	it("does NOT bench the account and fails over on out_of_credits 429", async () => {
		globalThis.fetch = mock(async () => outOfCreditsResponse());

		const ctx = makeProxyContextWithAsyncExec();
		const account = makeAccount();
		const bodyBuffer = makeRequestBody("claude-sonnet-4-5");
		const req = makeRequest(bodyBuffer);

		const result = await proxyWithAccount(
			req,
			new URL("https://proxy.local/v1/messages"),
			account,
			makeRequestMeta(),
			bodyBuffer,
			() => undefined,
			0,
			ctx,
		);

		// Failed over to the next account.
		expect(result).toBeNull();

		// Account was NOT benched.
		expect(account.rate_limited_until).toBeNull();
		expect(account.consecutive_rate_limits).toBe(0);

		// markAccountRateLimited was never called (no bench).
		const markMock = ctx.dbOps.markAccountRateLimited as ReturnType<
			typeof mock
		>;
		expect(markMock.mock.calls.length).toBe(0);

		// saveRequest was called once with reason "out_of_credits" and
		// usage { model: <requested model> }.
		const saveMock = ctx.dbOps.saveRequest as ReturnType<typeof mock>;
		expect(saveMock.mock.calls.length).toBe(1);
		const args = saveMock.mock.calls[0] as unknown[];
		// 7th positional arg is the `reason` parameter.
		expect(args[6]).toBe("out_of_credits");
		// 10th positional arg is the `usage` parameter.
		expect(args[9]).toEqual({ model: "claude-sonnet-4-5" });
	});

	it("returns null without recording an audit row on keepalive out_of_credits 429", async () => {
		globalThis.fetch = mock(async () => outOfCreditsResponse());

		const ctx = makeProxyContextWithAsyncExec();
		const account = makeAccount();
		const bodyBuffer = makeRequestBody();
		const req = new Request("https://proxy.local/v1/messages", {
			method: "POST",
			body: bodyBuffer,
			headers: {
				"Content-Type": "application/json",
				"x-better-ccflare-keepalive": "true",
			},
		});

		const result = await proxyWithAccount(
			req,
			new URL("https://proxy.local/v1/messages"),
			account,
			makeRequestMeta(),
			bodyBuffer,
			() => undefined,
			0,
			ctx,
		);

		expect(result).toBeNull();
		expect(account.rate_limited_until).toBeNull();

		// keepalive path skips the audit row entirely.
		const saveMock = ctx.dbOps.saveRequest as ReturnType<typeof mock>;
		expect(saveMock.mock.calls.length).toBe(0);
	});

	it("marks the account's model family exhausted in the negative cache on out_of_credits", async () => {
		globalThis.fetch = mock(async () => outOfCreditsResponse());

		const ctx = makeProxyContextWithAsyncExec();
		const account = makeAccount();
		const bodyBuffer = makeRequestBody("claude-sonnet-4-5");
		const req = makeRequest(bodyBuffer);

		expect(isFamilyExhausted(account.id, "sonnet")).toBe(false);

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

		expect(isFamilyExhausted(account.id, "sonnet")).toBe(true);
	});

	it("seeds the negative-cache TTL from the account's known weekly_scoped reset when available", async () => {
		globalThis.fetch = mock(async () => outOfCreditsResponse());

		const now = Date.now();
		const account = makeAccount();
		const resetAt = now + 10 * 60 * 1000; // 10 minutes out — beyond the 5min default
		usageCache.set(account.id, {
			limits: [
				{
					kind: "weekly_scoped",
					percent: 40,
					resets_at: new Date(resetAt).toISOString(),
					scope: { model: { id: null, display_name: "Sonnet" }, surface: null },
				},
			],
		} as never);

		const ctx = makeProxyContextWithAsyncExec();
		const bodyBuffer = makeRequestBody("claude-sonnet-4-5");
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

		// Still exhausted just past the default 5-minute TTL — proves the real
		// scoped reset (10 min out), not the 5-minute fallback, was used.
		expect(isFamilyExhausted(account.id, "sonnet", now + 6 * 60 * 1000)).toBe(
			true,
		);
		// Expired once the real reset time passes.
		expect(isFamilyExhausted(account.id, "sonnet", resetAt + 1_000)).toBe(
			false,
		);
	});

	it("also marks the negative cache on a keepalive out_of_credits probe", async () => {
		globalThis.fetch = mock(async () => outOfCreditsResponse());

		const ctx = makeProxyContextWithAsyncExec();
		const account = makeAccount();
		const bodyBuffer = makeRequestBody("claude-sonnet-4-5");
		const req = new Request("https://proxy.local/v1/messages", {
			method: "POST",
			body: bodyBuffer,
			headers: {
				"Content-Type": "application/json",
				"x-better-ccflare-keepalive": "true",
			},
		});

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

		expect(isFamilyExhausted(account.id, "sonnet")).toBe(true);
	});
});
