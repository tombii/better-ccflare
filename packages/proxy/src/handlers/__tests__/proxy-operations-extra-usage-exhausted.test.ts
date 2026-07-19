import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import type { Account, RequestMeta } from "@better-ccflare/types";
import { proxyWithAccount } from "../proxy-operations";
import type { ProxyContext } from "../proxy-types";

// Anthropic account fixture — the extra_usage_exhausted body is Anthropic-specific.
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

const EXTRA_USAGE_MESSAGE =
	"Third-party apps now draw from your extra usage, not your plan limits. Add more at claude.ai/settings/usage and keep going.";

// 400 invalid_request_error with the extra-usage-exhausted message.
function extraUsageExhaustedResponse(): Response {
	return new Response(
		JSON.stringify({
			type: "error",
			error: {
				type: "invalid_request_error",
				message: EXTRA_USAGE_MESSAGE,
			},
		}),
		{
			status: 400,
			headers: {
				"content-type": "application/json",
			},
		},
	);
}

describe("proxyWithAccount — extra_usage_exhausted (issue #293)", () => {
	let originalFetch: typeof globalThis.fetch;

	beforeEach(() => {
		originalFetch = globalThis.fetch;
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	it("does NOT bench the account and passes the 400 through to the client unchanged", async () => {
		globalThis.fetch = mock(async () => extraUsageExhaustedResponse());

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

		// Response is passed through to the client, not swallowed/nulled for failover.
		expect(result).not.toBeNull();
		expect(result?.status).toBe(400);
		const responseBody = await result?.json();
		expect(responseBody).toEqual({
			type: "error",
			error: {
				type: "invalid_request_error",
				message: EXTRA_USAGE_MESSAGE,
			},
		});

		// Account was NOT benched.
		expect(account.rate_limited_until).toBeNull();
		expect(account.consecutive_rate_limits).toBe(0);

		// markAccountRateLimited was never called (no bench).
		const markMock = ctx.dbOps.markAccountRateLimited as ReturnType<
			typeof mock
		>;
		expect(markMock.mock.calls.length).toBe(0);

		// saveRequest was called once with reason "extra_usage_exhausted",
		// status 400, success false, and usage { model: <requested model> }.
		const saveMock = ctx.dbOps.saveRequest as ReturnType<typeof mock>;
		expect(saveMock.mock.calls.length).toBe(1);
		const args = saveMock.mock.calls[0] as unknown[];
		// 5th positional arg is the `statusCode` parameter.
		expect(args[4]).toBe(400);
		// 6th positional arg is the `success` parameter.
		expect(args[5]).toBe(false);
		// 7th positional arg is the `reason` parameter.
		expect(args[6]).toBe("extra_usage_exhausted");
		// 10th positional arg is the `usage` parameter.
		expect(args[9]).toEqual({ model: "claude-sonnet-4-5" });
	});

	it("passes requestMeta attribution sources and rewritten models through to saveRequest", async () => {
		globalThis.fetch = mock(async () => extraUsageExhaustedResponse());

		const ctx = makeProxyContextWithAsyncExec();
		const account = makeAccount();
		const bodyBuffer = makeRequestBody("claude-sonnet-4-5");
		const req = makeRequest(bodyBuffer);

		await proxyWithAccount(
			req,
			new URL("https://proxy.local/v1/messages"),
			account,
			{
				...makeRequestMeta(),
				project: "Harness",
				agentUsed: "reviewer",
				projectAttributionSource: "header_project",
				agentAttributionSource: "header_agent",
				originalModel: "claude-sonnet-4-5",
				appliedModel: "claude-opus-4-6",
			},
			bodyBuffer,
			() => undefined,
			0,
			ctx,
		);

		const saveMock = ctx.dbOps.saveRequest as ReturnType<typeof mock>;
		expect(saveMock.mock.calls.length).toBe(1);
		const args = saveMock.mock.calls[0] as unknown[];
		// Full positional order (0-indexed): id, method, path, accountUsed,
		// statusCode, success, errorMessage, responseTime, failoverAttempts,
		// usage, agentUsed, apiKeyId, apiKeyName, project, billingType,
		// comboName, originalModel, appliedModel, projectAttributionSource,
		// agentAttributionSource.
		expect(args[6]).toBe("extra_usage_exhausted");
		expect(args[10]).toBe("reviewer");
		expect(args[13]).toBe("Harness");
		expect(args[16]).toBe("claude-sonnet-4-5");
		expect(args[17]).toBe("claude-opus-4-6");
		expect(args[18]).toBe("header_project");
		expect(args[19]).toBe("header_agent");
	});

	it("persists null/null originalModel/appliedModel when requestMeta carries an unmodified pair", async () => {
		globalThis.fetch = mock(async () => extraUsageExhaustedResponse());

		const ctx = makeProxyContextWithAsyncExec();
		const account = makeAccount();
		const bodyBuffer = makeRequestBody("claude-sonnet-4-5");
		const req = makeRequest(bodyBuffer);

		await proxyWithAccount(
			req,
			new URL("https://proxy.local/v1/messages"),
			account,
			{
				...makeRequestMeta(),
				// Agent-detected but NOT rewritten: original === applied. The
				// direct extra_usage_exhausted save path must match the other
				// direct persistence sites and gate through isModelRewrite.
				originalModel: "claude-sonnet-4-5",
				appliedModel: "claude-sonnet-4-5",
				projectAttributionSource: "path_project",
				agentAttributionSource: "prompt_agent",
			},
			bodyBuffer,
			() => undefined,
			0,
			ctx,
		);

		const saveMock = ctx.dbOps.saveRequest as ReturnType<typeof mock>;
		expect(saveMock.mock.calls.length).toBe(1);
		const args = saveMock.mock.calls[0] as unknown[];
		expect(args[16]).toBeNull();
		expect(args[17]).toBeNull();
		expect(args[18]).toBe("path_project");
		expect(args[19]).toBe("prompt_agent");
	});
});
