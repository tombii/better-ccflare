import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	mock,
	spyOn,
} from "bun:test";
import { usageCache } from "@better-ccflare/providers";
import type { Account, RequestMeta } from "@better-ccflare/types";
import { resetDefaultCircuitBreaker } from "../../circuit-breaker";
import * as usageCollectorModule from "../../usage-collector";
import { clearFamilyExhaustionCache } from "../model-capacity";
import { proxyWithAccount } from "../proxy-operations";
import type { ProxyContext } from "../proxy-types";
import { resetRateLimitProbeGatesForTests } from "../rate-limit-cooldown";

function stubUsageCollector() {
	return spyOn(usageCollectorModule, "getUsageCollector").mockReturnValue({
		handleStart: mock(() => {}),
		handleChunk: mock(() => {}),
		handleEnd: mock(() => Promise.resolve()),
	} as unknown as usageCollectorModule.UsageCollector);
}

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
		clientSessionId: "sess-1",
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

function makeRequest(body: ArrayBuffer, headers: Record<string, string> = {}) {
	return new Request("https://proxy.local/v1/messages", {
		method: "POST",
		body,
		headers: { "Content-Type": "application/json", ...headers },
	});
}

/**
 * The 403 captured verbatim from Anthropic on 2026-08-22 (25 occurrences across
 * three accounts of one organization within the hour). `x-should-retry: false`
 * accompanied every instance.
 */
function orgPermissionDenied403(
	extraHeaders: Record<string, string> = {},
): Response {
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
				...extraHeaders,
			},
		},
	);
}

function makeCtx(): ProxyContext {
	return {
		strategy: { getNextAccount: () => null } as never,
		dbOps: {
			markAccountRateLimited: mock(
				(_id: string, _until: number, _reason: string) =>
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
		// getProvider("anthropic") from the registry wins over this, by design —
		// the real parseRateLimit and processResponse run.
		provider: { name: "anthropic" } as never,
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

async function runProxy(
	account: Account,
	ctx: ProxyContext,
	req: Request,
	body: ArrayBuffer,
) {
	return proxyWithAccount(
		req,
		new URL("https://proxy.local/v1/messages"),
		account,
		makeRequestMeta(),
		body,
		() => undefined,
		0,
		ctx,
	);
}

const saveCalls = (ctx: ProxyContext) =>
	(ctx.dbOps.saveRequest as ReturnType<typeof mock>).mock
		.calls as unknown as unknown[][];
/** markAccountRateLimited(accountId, until, reason, incrementStreak) */
const markCalls = (ctx: ProxyContext) =>
	(ctx.dbOps.markAccountRateLimited as ReturnType<typeof mock>).mock
		.calls as unknown as [string, number, string, boolean][];

describe("proxyWithAccount — org_permission_denied (403 permission_error)", () => {
	let originalFetch: typeof globalThis.fetch;
	let collectorSpy: ReturnType<typeof stubUsageCollector>;

	beforeEach(() => {
		originalFetch = globalThis.fetch;
		collectorSpy = stubUsageCollector();
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
		collectorSpy.mockRestore();
		usageCache.clear();
		clearFamilyExhaustionCache();
		resetRateLimitProbeGatesForTests();
		resetDefaultCircuitBreaker();
	});

	it("benches the account and fails over instead of forwarding the 403", async () => {
		globalThis.fetch = mock(async () => orgPermissionDenied403());

		const ctx = makeCtx();
		const account = makeAccount();
		const body = makeRequestBody();

		const result = await runProxy(account, ctx, makeRequest(body), body);

		// Failed over to the next account rather than handing the client a 403.
		expect(result).toBeNull();

		// Benched, exactly like an exhausted window.
		expect(typeof account.rate_limited_until).toBe("number");
		expect(account.rate_limited_reason).toBe("org_permission_denied");
		expect(markCalls(ctx)).toHaveLength(1);
		expect(markCalls(ctx)[0][2]).toBe("org_permission_denied");
		// Fourth arg is incrementStreak: this is not an overload reason, so the
		// consecutive counter must ramp the backoff on repeat offences.
		expect(markCalls(ctx)[0][3]).toBe(true);
		expect(account.consecutive_rate_limits).toBe(1);
	});

	it("records one audit row carrying status 403 and the org_permission_denied reason", async () => {
		globalThis.fetch = mock(async () => orgPermissionDenied403());

		const ctx = makeCtx();
		const account = makeAccount();
		const body = makeRequestBody();

		await runProxy(account, ctx, makeRequest(body), body);

		expect(saveCalls(ctx)).toHaveLength(1);
		const args = saveCalls(ctx)[0];
		// 5th positional arg is statusCode, 7th is reason, 10th is usage.
		expect(args[4]).toBe(403);
		expect(args[6]).toBe("org_permission_denied");
		expect(args[9]).toEqual({ model: "claude-sonnet-4-5" });
		// The tail arguments are easy to drop when copying a sibling branch.
		expect(args[args.length - 1]).toBe("sess-1");
	});

	it("matches on error.type, not on the message wording", async () => {
		// The wording Claude Code shows the user on /v1/messages differs from the
		// usage endpoint's. Anthropic owns that copy; the routing must not.
		globalThis.fetch = mock(
			async () =>
				new Response(
					JSON.stringify({
						type: "error",
						error: {
							type: "permission_error",
							message:
								"Your organization has disabled Claude subscription access for Claude Code. Use an Anthropic API key instead, or ask your admin to enable access.",
						},
					}),
					{ status: 403, headers: { "content-type": "application/json" } },
				),
		);

		const ctx = makeCtx();
		const account = makeAccount();
		const body = makeRequestBody();

		const result = await runProxy(account, ctx, makeRequest(body), body);

		expect(result).toBeNull();
		expect(markCalls(ctx)[0][2]).toBe("org_permission_denied");
	});

	it("benches on a keepalive probe but records no audit row", async () => {
		// A 403 from the organization is authoritative no matter who asked, so the
		// bench is real information — unlike a keepalive 429, which can be a
		// synthetic per-IP burst artifact. The history row is still suppressed:
		// no client ever saw this request.
		globalThis.fetch = mock(async () => orgPermissionDenied403());

		const ctx = makeCtx();
		const account = makeAccount();
		const body = makeRequestBody();
		const req = makeRequest(body, {
			"x-better-ccflare-keepalive": "true",
			"x-better-ccflare-internal-probe-secret": "test-secret",
		});

		const result = await runProxy(account, ctx, req, body);

		expect(result).toBeNull();
		expect(markCalls(ctx)).toHaveLength(1);
		expect(markCalls(ctx)[0][2]).toBe("org_permission_denied");
		expect(saveCalls(ctx)).toHaveLength(0);
	});

	it("leaves a 403 whose error.type is not permission_error untouched", async () => {
		globalThis.fetch = mock(
			async () =>
				new Response(
					JSON.stringify({
						type: "error",
						error: {
							type: "authentication_error",
							message: "invalid x-api-key",
						},
					}),
					{ status: 403, headers: { "content-type": "application/json" } },
				),
		);

		const ctx = makeCtx();
		const account = makeAccount();
		const body = makeRequestBody();

		const result = await runProxy(account, ctx, makeRequest(body), body);

		// Unchanged pre-existing behaviour: forwarded to the client, no bench.
		expect(result).not.toBeNull();
		expect(result?.status).toBe(403);
		expect(markCalls(ctx)).toHaveLength(0);
		expect(account.rate_limited_until).toBeNull();
	});

	it("leaves a non-JSON 403 untouched (edge/WAF block pages must not drain the pool)", async () => {
		// Such a block typically rejects every account identically. Benching one
		// account per attempt is the pool-drain failure mode of issue #301.
		globalThis.fetch = mock(
			async () =>
				new Response("<html>403 Forbidden</html>", {
					status: 403,
					headers: { "content-type": "text/html" },
				}),
		);

		const ctx = makeCtx();
		const account = makeAccount();
		const body = makeRequestBody();

		const result = await runProxy(account, ctx, makeRequest(body), body);

		expect(result).not.toBeNull();
		expect(result?.status).toBe(403);
		expect(markCalls(ctx)).toHaveLength(0);
		expect(account.rate_limited_until).toBeNull();
	});
});
