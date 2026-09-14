import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import type { Account, RequestMeta } from "@better-ccflare/types";
import * as responseHandlerModule from "../../response-handler";
import { proxyWithAccount } from "../proxy-operations";
import type { ProxyContext } from "../proxy-types";
import { resetRateLimitProbeGatesForTests } from "../rate-limit-cooldown";

/**
 * Transient upstream 5xx (500/502/503/504) handling: one in-place retry on the
 * same account, then a short bench with reason `upstream_5xx_server_error` and
 * failover to the next account. Mirrors the 529 suites in
 * `proxy-operations-failover.test.ts` — same fixtures, same zeroed backoff, and
 * the same "forwardToClient throws UsageCollector not initialized" marker for
 * "the pass-through path was reached".
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
		clientSessionId: "sess-5xx",
		...overrides,
	};
}

function makeRequestBody(stream = false) {
	const body = JSON.stringify({
		model: "claude-sonnet-4-5",
		messages: [{ role: "user", content: "hello" }],
		max_tokens: 10,
		...(stream ? { stream: true } : {}),
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

function makeRequest(body: ArrayBuffer, headers: Record<string, string> = {}) {
	return new Request("https://proxy.local/v1/messages", {
		method: "POST",
		body,
		headers: { "Content-Type": "application/json", ...headers },
	});
}

const serverErrorBody =
	'{"type":"error","error":{"type":"api_error","message":"Internal server error"}}';
const successBody =
	'{"id":"msg_1","type":"message","content":[],"model":"claude-sonnet-4-5","stop_reason":"end_turn","usage":{"input_tokens":1,"output_tokens":1}}';

function serverErrorResponse(
	status: number,
	headers: Record<string, string> = {},
) {
	return new Response(serverErrorBody, {
		status,
		headers: { "content-type": "application/json", ...headers },
	});
}

/**
 * Captures the Response handed to `forwardToClient` instead of letting the
 * real one throw "UsageCollector not initialized".
 *
 * Reaching the pass-through path proves only that we did not fail over; it
 * says nothing about WHICH response was passed through. Every assertion that
 * the *upstream* status and body survived to the client needs the captured
 * argument, so the terminal-account cases install this stub.
 *
 * `mock.module` is process-global in Bun with no per-file isolation, so the
 * stub is installed inside the individual test and torn down in `afterEach` —
 * never at module top level, where it would also rewrite `forwardToClient`
 * for every other proxy test file sharing the process.
 */
let capturedForward: Response | null = null;

// Snapshotted at load time, before any mock.module call: Bun live-updates the
// imported namespace object, so reading it during teardown would hand the stub
// straight back and leak it into every test that follows.
const realResponseHandler = { ...responseHandlerModule };

function captureForwardedResponse(): void {
	capturedForward = null;
	mock.module("../../response-handler", () => ({
		...realResponseHandler,
		forwardToClient: async (options: { response: Response }) => {
			capturedForward = options.response;
			return options.response;
		},
	}));
}

function restoreForwardToClient(): void {
	capturedForward = null;
	mock.module("../../response-handler", () => realResponseHandler);
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
	isLastAccount = false,
	failoverAttempts = 0,
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
			failoverAttempts,
			ctx,
			undefined,
			undefined,
			undefined,
			undefined,
			isLastAccount,
		);
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		if (!msg.includes("UsageCollector not initialized")) throw e;
		forwarded = true;
	}
	return { result, forwarded };
}

/**
 * saveRequest(id, method, path, accountUsed, statusCode, success, errorMessage,
 * responseTime, failoverAttempts, usage, ..., clientSessionId)
 */
const saveCalls = (ctx: ProxyContext) =>
	(ctx.dbOps.saveRequest as ReturnType<typeof mock>).mock
		.calls as unknown as unknown[][];

describe("proxyWithAccount — transient upstream 5xx retry and failover", () => {
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
		resetRateLimitProbeGatesForTests();
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
		restoreForwardToClient();
		delete process.env.CCFLARE_OVERLOAD_RETRY_BASE_MS;
		delete process.env.CCFLARE_OVERLOAD_RETRY_MAX_MS;
		delete process.env.CCFLARE_OVERLOAD_RETRY_ENABLED;
		delete process.env.CCFLARE_OVERLOAD_RETRY_MAX_ATTEMPTS;
		delete process.env.CCFLARE_SERVER_ERROR_RETRY_ENABLED;
		delete process.env.CCFLARE_SERVER_ERROR_COOLDOWN_MS;
		resetRateLimitProbeGatesForTests();
	});

	it("retries a 500 in place and forwards the succeeding response without benching", async () => {
		let callCount = 0;
		globalThis.fetch = mock(async () => {
			callCount++;
			if (callCount === 1) return serverErrorResponse(500);
			return new Response(successBody, {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		});

		const ctx = makeProxyContext();
		const account = makeAccount();
		const bodyBuffer = makeRequestBody();
		const { forwarded } = await runProxy(
			makeRequest(bodyBuffer),
			account,
			bodyBuffer,
			ctx,
		);

		expect(callCount).toBe(2);
		expect(forwarded).toBe(true);
		expect(account.rate_limited_until).toBeNull();
		expect(account.rate_limited_reason).toBeNull();
	});

	it.each([
		500, 502, 503, 504,
	])("benches the account with upstream_5xx_server_error and fails over when the retry budget is exhausted (status %i)", async (status) => {
		let callCount = 0;
		globalThis.fetch = mock(async () => {
			callCount++;
			return serverErrorResponse(status);
		});

		const ctx = makeProxyContext();
		const account = makeAccount();
		const bodyBuffer = makeRequestBody();
		const before = Date.now();
		const { result, forwarded } = await runProxy(
			makeRequest(bodyBuffer),
			account,
			bodyBuffer,
			ctx,
		);

		expect(forwarded).toBe(false);
		expect(result).toBeNull();
		expect(callCount).toBe(2);
		expect(account.rate_limited_reason).toBe("upstream_5xx_server_error");
		expect(account.rate_limited_until).not.toBeNull();
		expect(account.rate_limited_until ?? 0).toBeGreaterThanOrEqual(
			before + 60_000 - 1_000,
		);
		expect(account.rate_limited_until ?? 0).toBeLessThanOrEqual(
			Date.now() + 60_000,
		);
		// The 429 streak is reserved for genuine quota exhaustion.
		expect(account.consecutive_rate_limits).toBe(0);
	});

	it("records an audit row for the failed attempt before failing over", async () => {
		// The production incident was diagnosed from exactly this row. Without
		// it the 36-60s the request spent on the broken account vanishes from
		// history, and the row the *next* account writes shows only
		// failover_attempts=1 with no trace of what it failed over from.
		globalThis.fetch = mock(async () => serverErrorResponse(500));

		const ctx = makeProxyContext();
		const account = makeAccount();
		const bodyBuffer = makeRequestBody();
		const { result } = await runProxy(
			makeRequest(bodyBuffer),
			account,
			bodyBuffer,
			ctx,
			false,
			2,
		);

		expect(result).toBeNull();
		expect(saveCalls(ctx)).toHaveLength(1);
		const args = saveCalls(ctx)[0];
		expect(args[3]).toBe("acc-1");
		expect(args[4]).toBe(500);
		expect(args[5]).toBe(false);
		expect(args[6]).toBe("upstream_5xx_server_error");
		expect(typeof args[7]).toBe("number");
		expect(args[8]).toBe(2);
		expect(args[9]).toEqual({ model: "claude-sonnet-4-5" });
		// The tail arguments are easy to drop when copying a sibling branch.
		expect(args[args.length - 1]).toBe("sess-5xx");
	});

	it("records no audit row for a synthetic probe's 5xx", async () => {
		globalThis.fetch = mock(async () => serverErrorResponse(500));

		const ctx = makeProxyContext();
		const account = makeAccount();
		const bodyBuffer = makeRequestBody();
		const probeReq = makeRequest(bodyBuffer, {
			"x-better-ccflare-keepalive": "true",
			"x-better-ccflare-internal-probe-secret": "test-secret",
		});
		await runProxy(probeReq, account, bodyBuffer, ctx);

		expect(saveCalls(ctx)).toHaveLength(0);
	});

	it("honours a short Retry-After instead of the full cooldown", async () => {
		globalThis.fetch = mock(async () =>
			serverErrorResponse(503, { "retry-after": "5" }),
		);

		const ctx = makeProxyContext();
		const account = makeAccount();
		const bodyBuffer = makeRequestBody();
		const before = Date.now();
		const { result } = await runProxy(
			makeRequest(bodyBuffer),
			account,
			bodyBuffer,
			ctx,
		);

		expect(result).toBeNull();
		expect(account.rate_limited_reason).toBe("upstream_5xx_server_error");
		expect(account.rate_limited_until).not.toBeNull();
		expect(account.rate_limited_until ?? 0).toBeGreaterThanOrEqual(
			before + 4_000,
		);
		expect(account.rate_limited_until ?? 0).toBeLessThan(Date.now() + 10_000);
	});

	it("caps an hour-long Retry-After at the server-error cooldown", async () => {
		globalThis.fetch = mock(async () =>
			serverErrorResponse(503, { "retry-after": "3600" }),
		);

		const ctx = makeProxyContext();
		const account = makeAccount();
		const bodyBuffer = makeRequestBody();
		const before = Date.now();
		const { result } = await runProxy(
			makeRequest(bodyBuffer),
			account,
			bodyBuffer,
			ctx,
		);

		expect(result).toBeNull();
		expect(account.rate_limited_reason).toBe("upstream_5xx_server_error");
		// A bare upper bound is satisfied by "no bench at all" — the lower bound
		// and the non-null check are what make this a cap test rather than a
		// tautology.
		expect(account.rate_limited_until).not.toBeNull();
		expect(account.rate_limited_until ?? 0).toBeGreaterThan(before + 55_000);
		expect(account.rate_limited_until ?? 0).toBeLessThanOrEqual(
			Date.now() + 60_000,
		);
	});

	it("skips the retry when the response says x-should-retry: false", async () => {
		let callCount = 0;
		globalThis.fetch = mock(async () => {
			callCount++;
			return serverErrorResponse(500, { "x-should-retry": "false" });
		});

		const ctx = makeProxyContext();
		const account = makeAccount();
		const bodyBuffer = makeRequestBody();
		const { result } = await runProxy(
			makeRequest(bodyBuffer),
			account,
			bodyBuffer,
			ctx,
		);

		expect(callCount).toBe(1);
		expect(result).toBeNull();
		expect(account.rate_limited_reason).toBe("upstream_5xx_server_error");
	});

	it("stops retrying when a retry response carries x-should-retry: false", async () => {
		// The header is upstream telling us this answer is deterministic. It has
		// to be re-read on every attempt, not only on the first response: with a
		// budget of 3 the second 500 would otherwise buy a third pointless call.
		process.env.CCFLARE_OVERLOAD_RETRY_MAX_ATTEMPTS = "3";
		let callCount = 0;
		globalThis.fetch = mock(async () => {
			callCount++;
			return callCount === 1
				? serverErrorResponse(500)
				: serverErrorResponse(500, { "x-should-retry": "false" });
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

		expect(callCount).toBe(2);
		expect(forwarded).toBe(false);
		expect(result).toBeNull();
		expect(account.rate_limited_reason).toBe("upstream_5xx_server_error");
	});

	it("honours an HTTP-date Retry-After, capped at the server-error cooldown", async () => {
		const until = new Date(Date.now() + 30_000).toUTCString();
		globalThis.fetch = mock(async () =>
			serverErrorResponse(503, { "retry-after": until }),
		);

		const ctx = makeProxyContext();
		const account = makeAccount();
		const bodyBuffer = makeRequestBody();
		const { result } = await runProxy(
			makeRequest(bodyBuffer),
			account,
			bodyBuffer,
			ctx,
		);

		expect(result).toBeNull();
		expect(account.rate_limited_reason).toBe("upstream_5xx_server_error");
		expect(account.rate_limited_until).not.toBeNull();
		// Honoured: the date, not the flat 60s cooldown.
		expect(account.rate_limited_until ?? 0).toBeGreaterThan(
			Date.now() + 20_000,
		);
		expect(account.rate_limited_until ?? 0).toBeLessThan(Date.now() + 45_000);
	});

	it("leaves a 401 on the retry to the credential path, with no 5xx bench", async () => {
		// The upstream did not fail here; the account's credentials did. Benching
		// with a server-error reason would blame the wrong thing and hide the
		// reauth signal.
		let callCount = 0;
		globalThis.fetch = mock(async () => {
			callCount++;
			return callCount === 1
				? serverErrorResponse(500)
				: new Response(
						'{"type":"error","error":{"type":"authentication_error"}}',
						{
							status: 401,
							headers: { "content-type": "application/json" },
						},
					);
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

		expect(callCount).toBe(2);
		expect(forwarded).toBe(false);
		expect(result).toBeNull();
		expect(account.rate_limited_until).toBeNull();
		expect(account.rate_limited_reason).toBeNull();
	});

	it("still benches and fails over when CCFLARE_OVERLOAD_RETRY_ENABLED=false", async () => {
		// The shared retry kill-switch only removes the in-place re-issue. The
		// failover half of the feature is governed by
		// CCFLARE_SERVER_ERROR_RETRY_ENABLED and must survive it.
		process.env.CCFLARE_OVERLOAD_RETRY_ENABLED = "false";
		let callCount = 0;
		globalThis.fetch = mock(async () => {
			callCount++;
			return serverErrorResponse(502);
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

		expect(callCount).toBe(1);
		expect(forwarded).toBe(false);
		expect(result).toBeNull();
		expect(account.rate_limited_reason).toBe("upstream_5xx_server_error");
		expect(account.rate_limited_until).not.toBeNull();
	});

	it("forwards the 5xx untouched when CCFLARE_SERVER_ERROR_RETRY_ENABLED=false", async () => {
		let callCount = 0;
		globalThis.fetch = mock(async () => {
			callCount++;
			return serverErrorResponse(500);
		});

		process.env.CCFLARE_SERVER_ERROR_RETRY_ENABLED = "false";
		const ctx = makeProxyContext();
		const account = makeAccount();
		const bodyBuffer = makeRequestBody();
		const { forwarded } = await runProxy(
			makeRequest(bodyBuffer),
			account,
			bodyBuffer,
			ctx,
		);

		expect(callCount).toBe(1);
		expect(forwarded).toBe(true);
		expect(account.rate_limited_until).toBeNull();
		expect(account.rate_limited_reason).toBeNull();
	});

	it("forwards the upstream 5xx to the client on the last candidate account", async () => {
		let callCount = 0;
		globalThis.fetch = mock(async () => {
			callCount++;
			return serverErrorResponse(500);
		});
		captureForwardedResponse();

		const ctx = makeProxyContext();
		const account = makeAccount();
		const bodyBuffer = makeRequestBody();
		const { result } = await runProxy(
			makeRequest(bodyBuffer),
			account,
			bodyBuffer,
			ctx,
			true,
		);

		// The retry budget is spent on the terminal account too: one original
		// call plus CCFLARE_OVERLOAD_RETRY_MAX_ATTEMPTS - 1 re-issues.
		expect(callCount).toBe(2);
		// What reaches the client is the upstream response itself — same status,
		// same body — not a synthetic pool_exhausted and not an empty shell.
		expect(capturedForward).not.toBeNull();
		expect(capturedForward?.status).toBe(500);
		expect(await (capturedForward as Response).text()).toBe(serverErrorBody);
		expect(result?.status).toBe(500);
		// The account is still benched, exactly as the terminal 529 path does.
		// `rate_limited_reason` alone does not pin this: processProxyResponse
		// runs on the fall-through and only ever clears `rate_limited_until`,
		// never the reason, so a regression of the `status < 500` guard in
		// response-processor.ts would leave the reason set and the bench gone.
		expect(account.rate_limited_reason).toBe("upstream_5xx_server_error");
		expect(account.rate_limited_until).not.toBeNull();
		expect(account.rate_limited_until ?? 0).toBeGreaterThan(Date.now());
		// The fall-through path writes its own row downstream; the 5xx block
		// must not add a second one for the same request.
		expect(saveCalls(ctx)).toHaveLength(0);
	});

	it("keeps a terminal 5xx classified as a server error when hard-limit rate-limit headers ride along", async () => {
		// `AnthropicProvider.parseRateLimit` treats
		// `anthropic-ratelimit-unified-status: rate_limited` as rate-limited
		// whatever the HTTP status is (HARD_LIMIT_STATUSES in
		// packages/providers/src/providers/anthropic/provider.ts), and
		// proxyWithAccount resolves the real provider from `account.provider`.
		// So on the terminal account a 500 carrying that header used to be
		// re-classified downstream in processProxyResponse: the 60s
		// `upstream_5xx_server_error` bench was overwritten by a quota
		// cooldown, the 429 streak advanced, and proxyWithAccount returned null
		// (pool_exhausted) instead of forwarding the real 500.
		// Hoisted so both upstream calls carry the same reset value (an inline
		// Date.now() can straddle a second boundary between them) and so the
		// bookkeeping assertion below can name the exact millisecond the
		// provider is expected to derive from it.
		const resetSeconds = Math.floor((Date.now() + 3_600_000) / 1000);
		let callCount = 0;
		globalThis.fetch = mock(async () => {
			callCount++;
			return serverErrorResponse(500, {
				"anthropic-ratelimit-unified-status": "rate_limited",
				"anthropic-ratelimit-unified-reset": String(resetSeconds),
			});
		});
		captureForwardedResponse();

		const ctx = makeProxyContext();
		const account = makeAccount();
		const bodyBuffer = makeRequestBody();
		const before = Date.now();
		const { result } = await runProxy(
			makeRequest(bodyBuffer),
			account,
			bodyBuffer,
			ctx,
			true,
		);

		expect(callCount).toBe(2);
		// The server-error classification survives end to end.
		expect(account.rate_limited_reason).toBe("upstream_5xx_server_error");
		expect(account.rate_limited_until).not.toBeNull();
		expect(account.rate_limited_until ?? 0).toBeGreaterThan(before + 55_000);
		expect(account.rate_limited_until ?? 0).toBeLessThanOrEqual(
			Date.now() + 60_000,
		);
		// Not the account's own quota: the streak stays frozen.
		expect(account.consecutive_rate_limits).toBe(0);
		// And the client gets the real upstream error, not pool_exhausted.
		expect(capturedForward).not.toBeNull();
		expect(capturedForward?.status).toBe(500);
		expect(await (capturedForward as Response).text()).toBe(serverErrorBody);
		expect(result?.status).toBe(500);

		// The `serverErrorBenchApplied` branch in processProxyResponse skips the
		// cooldown and the streak — and nothing else. It still has to run
		// `updateAccountMetadata` before returning false, exactly as the
		// cooldown path below it does. Those are the only two writes that
		// function performs which are observable through this context's fakes:
		// `updateAccountUsage` (bypassSession is false — no bypass header on the
		// request) and `updateAccountRateLimitMeta` (the provider found a status
		// header). The Codex usage block is keyed off `account.provider ===
		// "codex"` and the usage-extraction block only reaches `updateRequestUsage`
		// when the body carries a `usage` object, so neither fires on an
		// anthropic error body.
		//
		// Negative control: if that branch returned before
		// `updateAccountMetadata`, both call counts below would be 0 — every
		// other assertion in this test (bench, streak, forwarded status and
		// body) would still pass, which is exactly why they are here.
		const usageCalls = (ctx.dbOps.updateAccountUsage as ReturnType<typeof mock>)
			.mock.calls as unknown as unknown[][];
		expect(usageCalls).toHaveLength(1);
		expect(usageCalls[0]).toEqual([account.id]);

		// The parsed metadata, not just "something was written": the real
		// AnthropicProvider turns the two headers above into
		// statusHeader="rate_limited" and resetTime = reset seconds * 1000,
		// with `remaining` undefined because no unified-remaining header rode
		// along. Persisting the hard-limit status is what keeps the dashboard
		// and the usage poller honest about an account the upstream is
		// simultaneously failing to serve.
		const metaCalls = (
			ctx.dbOps.updateAccountRateLimitMeta as ReturnType<typeof mock>
		).mock.calls as unknown as unknown[][];
		expect(metaCalls).toHaveLength(1);
		expect(metaCalls[0]).toEqual([
			account.id,
			"rate_limited",
			resetSeconds * 1000,
			undefined,
		]);
	});

	it("retries a streaming request's 500 the same way as a non-streaming one", async () => {
		let callCount = 0;
		globalThis.fetch = mock(async () => {
			callCount++;
			if (callCount === 1) return serverErrorResponse(500);
			return new Response("event: message_start\ndata: {}\n\n", {
				status: 200,
				headers: { "content-type": "text/event-stream" },
			});
		});

		const ctx = makeProxyContext();
		const account = makeAccount();
		const bodyBuffer = makeRequestBody(true);
		const { forwarded } = await runProxy(
			makeRequest(bodyBuffer, { Accept: "text/event-stream" }),
			account,
			bodyBuffer,
			ctx,
		);

		expect(callCount).toBe(2);
		expect(forwarded).toBe(true);
		expect(account.rate_limited_reason).toBeNull();
	});

	it("leaves synthetic internal probes on the pre-existing pass-through path", async () => {
		let callCount = 0;
		globalThis.fetch = mock(async () => {
			callCount++;
			return serverErrorResponse(500);
		});

		const ctx = makeProxyContext();
		const account = makeAccount();
		const bodyBuffer = makeRequestBody();
		const probeReq = makeRequest(bodyBuffer, {
			"x-better-ccflare-keepalive": "true",
			"x-better-ccflare-internal-probe-secret": "test-secret",
		});
		await runProxy(probeReq, account, bodyBuffer, ctx);

		expect(callCount).toBe(1);
		expect(account.rate_limited_reason).toBeNull();
	});
});
