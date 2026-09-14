import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import type { Account, RequestMeta } from "@better-ccflare/types";
import { clearFamilyExhaustionCache } from "../model-capacity";
import { proxyWithAccount } from "../proxy-operations";
import type { ProxyContext } from "../proxy-types";
import { resetRateLimitProbeGatesForTests } from "../rate-limit-cooldown";

/**
 * Every upstream-error classification in `proxyWithAccount` — 403
 * `permission_error`, 400 `extra_usage_exhausted`, 429 `out_of_credits`, the
 * windowless 429 — used to run on the FIRST response only. Both in-place retry
 * loops (529 overload, transient 5xx) overwrite `response` with whatever the
 * retry returned, and afterwards only 401 was re-checked. So a `500 → 403
 * permission_error` sequence handed the client a 403 with the account left
 * unbenched and still at the front of the priority order, while the identical
 * 403 on the first attempt benched and failed over.
 *
 * These cases pin the retry response to the SAME classification the first
 * response gets. Fixtures mirror `proxy-operations-5xx-failover.test.ts`; the
 * 403 body is the one from `proxy-operations-org-permission-denied.test.ts` and
 * the 429 bodies come from `proxy-operations-out-of-credits.test.ts` /
 * `proxy-operations-windowless-429.test.ts`.
 */

function makeAccount(overrides: Partial<Account> = {}): Account {
	return {
		id: "acc-1",
		name: "anthropic-test",
		provider: "anthropic",
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

function makeRequestMeta(overrides: Partial<RequestMeta> = {}): RequestMeta {
	return {
		id: "req-1",
		method: "POST",
		path: "/v1/messages",
		timestamp: Date.now(),
		headers: new Headers(),
		clientSessionId: "sess-reclassify",
		...overrides,
	};
}

function makeRequestBody() {
	const body = JSON.stringify({
		model: "claude-sonnet-4-5",
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
					Promise.resolve({ consecutiveRateLimits: 1, applied: true }),
			),
			saveRequest: mock((..._args: unknown[]) => Promise.resolve()),
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
			name: "anthropic",
			canHandle: () => true,
			buildUrl: () => "https://api.anthropic.com/v1/messages",
			prepareHeaders: () => new Headers(),
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
	};
}

function makeRequest(body: ArrayBuffer) {
	return new Request("https://proxy.local/v1/messages", {
		method: "POST",
		body,
		headers: { "Content-Type": "application/json" },
	});
}

const serverErrorBody =
	'{"type":"error","error":{"type":"api_error","message":"Internal server error"}}';
const successBody =
	'{"id":"msg_1","type":"message","content":[],"model":"claude-sonnet-4-5","stop_reason":"end_turn","usage":{"input_tokens":1,"output_tokens":1}}';

function serverErrorResponse(status: number) {
	return new Response(serverErrorBody, {
		status,
		headers: { "content-type": "application/json" },
	});
}

/** The reset-less 529 that drives the in-place overload retry loop. */
function overloaded529() {
	return new Response(
		JSON.stringify({
			type: "error",
			error: { type: "overloaded_error", message: "Overloaded" },
		}),
		{ status: 529, headers: { "content-type": "application/json" } },
	);
}

/** Verbatim from `proxy-operations-org-permission-denied.test.ts`. */
function orgPermissionDenied403() {
	return new Response(
		JSON.stringify({
			type: "error",
			error: {
				type: "permission_error",
				message:
					"OAuth authentication is currently not allowed for this organization.",
				details: {
					error_visibility: "user_facing",
					error_code: "oauth_not_allowed_for_organization",
				},
			},
			request_id: "req_011CeJWapJc7LETV42WEGiAD",
		}),
		{
			status: 403,
			headers: {
				"content-type": "application/json",
				"x-should-retry": "false",
			},
		},
	);
}

/** Verbatim from `proxy-operations-out-of-credits.test.ts`. */
function outOfCredits429() {
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

/** Verbatim from `proxy-operations-extra-usage-exhausted.test.ts`. */
const EXTRA_USAGE_MESSAGE =
	"Third-party apps now draw from your extra usage, not your plan limits. Add more at claude.ai/settings/usage and keep going.";

function extraUsageExhausted400() {
	return new Response(
		JSON.stringify({
			type: "error",
			error: {
				type: "invalid_request_error",
				message: EXTRA_USAGE_MESSAGE,
			},
		}),
		{ status: 400, headers: { "content-type": "application/json" } },
	);
}

/** Verbatim from `proxy-operations-windowless-429.test.ts`. */
function windowless429() {
	return new Response(
		JSON.stringify({
			type: "error",
			error: { type: "rate_limit_error", message: "rate limit exceeded" },
		}),
		{
			status: 429,
			headers: {
				"content-type": "application/json",
				"x-robots-tag": "none",
				"x-should-retry": "true",
			},
		},
	);
}

function ok200() {
	return new Response(successBody, {
		status: 200,
		headers: { "content-type": "application/json" },
	});
}

/**
 * Runs proxyWithAccount, swallowing only the UsageCollector error that
 * forwardToClient throws in unit tests. Reaching it proves the response was
 * forwarded to the client rather than failed over.
 */
async function runProxy(
	req: Request,
	account: Account,
	bodyBuffer: ArrayBuffer,
	ctx: ProxyContext,
): Promise<{ result: Response | null; forwarded: boolean }> {
	let forwarded = false;
	let result: Response | null = null;
	try {
		result = await proxyWithAccount(
			req,
			new URL("https://proxy.local/v1/messages"),
			account,
			makeRequestMeta(),
			bodyBuffer,
			() => undefined,
			0,
			ctx,
		);
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		if (!msg.includes("UsageCollector not initialized")) throw e;
		forwarded = true;
	}
	return { result, forwarded };
}

const saveReasons = (ctx: ProxyContext) =>
	(
		(ctx.dbOps.saveRequest as ReturnType<typeof mock>).mock
			.calls as unknown as unknown[][]
	).map((args) => args[6]);

const markCalls = (ctx: ProxyContext) =>
	(ctx.dbOps.markAccountRateLimited as ReturnType<typeof mock>).mock
		.calls as unknown as unknown[][];

/**
 * Drives one full proxy attempt against a scripted sequence of upstream
 * responses and returns everything the classification is observable through.
 */
async function runSequence(responses: Array<() => Response>) {
	let callCount = 0;
	globalThis.fetch = mock(async () => {
		const factory = responses[Math.min(callCount, responses.length - 1)];
		callCount++;
		return factory();
	});

	const ctx = makeProxyContext();
	const account = makeAccount();
	const bodyBuffer = makeRequestBody();
	const { result, forwarded } = await runProxy(
		makeRequest(bodyBuffer),
		account,
		bodyBuffer,
		ctx,
	);
	return { account, ctx, result, forwarded, callCount };
}

describe("proxyWithAccount — a retried response is classified like a first response", () => {
	let originalFetch: typeof globalThis.fetch;

	beforeEach(() => {
		originalFetch = globalThis.fetch;
		// Zero-delay backoff so tests don't sleep.
		process.env.CCFLARE_OVERLOAD_RETRY_BASE_MS = "0";
		process.env.CCFLARE_OVERLOAD_RETRY_MAX_MS = "0";
		delete process.env.CCFLARE_OVERLOAD_RETRY_ENABLED;
		delete process.env.CCFLARE_OVERLOAD_RETRY_MAX_ATTEMPTS;
		delete process.env.CCFLARE_SERVER_ERROR_RETRY_ENABLED;
		delete process.env.CCFLARE_SERVER_ERROR_COOLDOWN_MS;
		clearFamilyExhaustionCache();
		resetRateLimitProbeGatesForTests();
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
		delete process.env.CCFLARE_OVERLOAD_RETRY_BASE_MS;
		delete process.env.CCFLARE_OVERLOAD_RETRY_MAX_MS;
		delete process.env.CCFLARE_OVERLOAD_RETRY_ENABLED;
		delete process.env.CCFLARE_OVERLOAD_RETRY_MAX_ATTEMPTS;
		delete process.env.CCFLARE_SERVER_ERROR_RETRY_ENABLED;
		delete process.env.CCFLARE_SERVER_ERROR_COOLDOWN_MS;
		clearFamilyExhaustionCache();
		resetRateLimitProbeGatesForTests();
	});

	it("benches org_permission_denied and fails over when a 500 retry answers 403", async () => {
		const { account, ctx, result, forwarded, callCount } = await runSequence([
			() => serverErrorResponse(500),
			() => orgPermissionDenied403(),
		]);

		expect(callCount).toBe(2);
		expect(forwarded).toBe(false);
		expect(result).toBeNull();
		expect(account.rate_limited_reason).toBe("org_permission_denied");
		expect(account.rate_limited_until).not.toBeNull();
		expect(markCalls(ctx)).toHaveLength(1);
		expect(markCalls(ctx)[0][2]).toBe("org_permission_denied");
		expect(saveReasons(ctx)).toContain("org_permission_denied");
	});

	it("benches org_permission_denied and fails over when a 529 retry answers 403", async () => {
		const { account, ctx, result, forwarded, callCount } = await runSequence([
			() => overloaded529(),
			() => orgPermissionDenied403(),
		]);

		expect(callCount).toBe(2);
		expect(forwarded).toBe(false);
		expect(result).toBeNull();
		expect(account.rate_limited_reason).toBe("org_permission_denied");
		expect(markCalls(ctx)).toHaveLength(1);
		expect(markCalls(ctx)[0][2]).toBe("org_permission_denied");
		expect(saveReasons(ctx)).toContain("org_permission_denied");
	});

	it("applies the out_of_credits handling when a 500 retry answers 429 out_of_credits", async () => {
		const { account, ctx, result, forwarded } = await runSequence([
			() => serverErrorResponse(500),
			() => outOfCredits429(),
		]);

		expect(forwarded).toBe(false);
		expect(result).toBeNull();
		// out_of_credits is model/beta-scoped: no bench, no streak bump.
		expect(account.rate_limited_until).toBeNull();
		expect(account.rate_limited_reason).toBeNull();
		expect(account.consecutive_rate_limits).toBe(0);
		expect(markCalls(ctx)).toHaveLength(0);
		expect(saveReasons(ctx)).toEqual(["out_of_credits"]);
	});

	it("passes a 400 extra_usage_exhausted behind a 500 straight to the client, stripped of the internal request-path header", async () => {
		const { account, ctx, result, forwarded, callCount } = await runSequence([
			() => serverErrorResponse(500),
			() => extraUsageExhausted400(),
		]);

		expect(callCount).toBe(2);
		// Returned by the classification itself, not handed to forwardToClient.
		expect(forwarded).toBe(false);
		expect(result).not.toBeNull();
		expect(result?.status).toBe(400);
		// A billing rejection, not account exhaustion: no bench, no streak bump.
		expect(account.rate_limited_until).toBeNull();
		expect(account.rate_limited_reason).toBeNull();
		expect(account.consecutive_rate_limits).toBe(0);
		expect(markCalls(ctx)).toHaveLength(0);
		expect(saveReasons(ctx)).toEqual(["extra_usage_exhausted"]);
		// `reissueRequestInPlace` tags every retry response with the internal
		// request-path header so the provider can identify the response type.
		// A response returned straight out of the classification chain never
		// passes the client-bound exits in response-handler.ts that delete it,
		// so the chain has to delete it itself.
		expect(result?.headers.get("x-better-ccflare-request-path")).toBeNull();
	});

	it("classifies a windowless 429 behind a 500 exactly like a direct windowless 429", async () => {
		const direct = await runSequence([() => windowless429()]);
		const behind500 = await runSequence([
			() => serverErrorResponse(500),
			() => windowless429(),
		]);

		expect(behind500.result).toBe(direct.result);
		expect(behind500.forwarded).toBe(direct.forwarded);
		expect(behind500.account.rate_limited_reason).toBe(
			direct.account.rate_limited_reason,
		);
		expect(behind500.account.rate_limited_until === null).toBe(
			direct.account.rate_limited_until === null,
		);
		expect(behind500.account.consecutive_rate_limits).toBe(
			direct.account.consecutive_rate_limits,
		);
		expect(saveReasons(behind500.ctx)).toEqual(saveReasons(direct.ctx));
		expect(markCalls(behind500.ctx).length).toBe(markCalls(direct.ctx).length);
		// Sanity: the direct run really did take the windowless path.
		expect(saveReasons(direct.ctx)).toEqual(["windowless_429"]);
	});

	it("still forwards a 200 that resolved a 500", async () => {
		const { account, result, forwarded, callCount } = await runSequence([
			() => serverErrorResponse(500),
			() => ok200(),
		]);

		expect(callCount).toBe(2);
		expect(forwarded).toBe(true);
		expect(result).toBeNull();
		expect(account.rate_limited_until).toBeNull();
		expect(account.rate_limited_reason).toBeNull();
	});

	it("still forwards a 200 that resolved a 529", async () => {
		const { account, result, forwarded, callCount } = await runSequence([
			() => overloaded529(),
			() => ok200(),
		]);

		expect(callCount).toBe(2);
		expect(forwarded).toBe(true);
		expect(result).toBeNull();
		expect(account.rate_limited_until).toBeNull();
		expect(account.rate_limited_reason).toBeNull();
	});
});
