import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import type { Account, RequestMeta } from "@better-ccflare/types";
import { proxyWithAccount } from "../proxy-operations";
import type { ProxyContext } from "../proxy-types";
import { resetRateLimitProbeGatesForTests } from "../rate-limit-cooldown";

/**
 * Some upstreams refuse a byte-identical resend: Qoder answers code 103,
 * "Duplicate request", for a replay of a request it has already seen. The
 * proxy's in-place 5xx/529 retries replay the request verbatim, so such a
 * provider needs a way to give the resend a fresh identity.
 *
 * The `Provider.refreshRequestIdentity` hook is that way, and it is OPT-IN:
 * a provider that does not implement it keeps today's behaviour byte for byte.
 */

function makeAccount(overrides: Partial<Account> = {}): Account {
	return {
		id: "acc-identity",
		name: "identity-test",
		// A provider name the registry does not know, so the context's provider
		// (the mock below) is the one that handles the request.
		provider: "identity-test",
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
		id: "req-identity",
		method: "POST",
		path: "/v1/messages",
		timestamp: Date.now(),
		headers: new Headers(),
		clientSessionId: "sess-identity",
		...overrides,
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

interface RefreshCall {
	accountId: string;
	body: string;
}

/**
 * @param withHook - install the `refreshRequestIdentity` hook on the mock
 *   provider. When it is absent the retry must replay the request verbatim.
 */
function makeProxyContext(
	withHook: boolean,
	refreshCalls: RefreshCall[],
): ProxyContext {
	const provider = {
		name: "identity-test",
		canHandle: () => true,
		buildUrl: () => "https://identity.test/v1/messages",
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
		...(withHook
			? {
					refreshRequestIdentity: async (
						request: Request,
						account: Account | null,
					) => {
						const body = await request.clone().text();
						refreshCalls.push({
							accountId: account?.id ?? "",
							body,
						});
						return new Request(request.url, {
							method: request.method,
							headers: request.headers,
							body: `${body}#refreshed`,
							signal: request.signal,
						});
					},
				}
			: {}),
	};
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
		provider: provider as never,
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

const serverErrorResponse = () =>
	new Response(
		'{"type":"error","error":{"type":"api_error","message":"Internal server error"}}',
		{ status: 500, headers: { "content-type": "application/json" } },
	);

const successBody =
	'{"id":"msg_1","type":"message","content":[],"model":"claude-sonnet-4-5","stop_reason":"end_turn","usage":{"input_tokens":1,"output_tokens":1}}';

/** Records every outbound request body and answers 500, then 200. */
function scriptUpstream() {
	const bodies: string[] = [];
	globalThis.fetch = mock(async (input: RequestInfo | URL) => {
		const req = input instanceof Request ? input : new Request(String(input));
		bodies.push(await req.text().catch(() => ""));
		if (bodies.length === 1) return serverErrorResponse();
		return new Response(successBody, {
			status: 200,
			headers: { "content-type": "application/json" },
		});
	});
	return bodies;
}

async function runProxy(
	account: Account,
	bodyBuffer: ArrayBuffer,
	ctx: ProxyContext,
) {
	try {
		await proxyWithAccount(
			makeRequest(bodyBuffer),
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
	}
}

describe("proxyWithAccount — an in-place retry gives the resend a fresh identity", () => {
	let originalFetch: typeof globalThis.fetch;

	beforeEach(() => {
		originalFetch = globalThis.fetch;
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
		delete process.env.CCFLARE_OVERLOAD_RETRY_BASE_MS;
		delete process.env.CCFLARE_OVERLOAD_RETRY_MAX_MS;
		delete process.env.CCFLARE_OVERLOAD_RETRY_ENABLED;
		delete process.env.CCFLARE_OVERLOAD_RETRY_MAX_ATTEMPTS;
		delete process.env.CCFLARE_SERVER_ERROR_RETRY_ENABLED;
		delete process.env.CCFLARE_SERVER_ERROR_COOLDOWN_MS;
		resetRateLimitProbeGatesForTests();
	});

	it("asks the provider to refresh the identity and forwards the refreshed request", async () => {
		const bodies = scriptUpstream();
		const refreshCalls: RefreshCall[] = [];
		const ctx = makeProxyContext(true, refreshCalls);
		const account = makeAccount();

		await runProxy(account, makeRequestBody(), ctx);

		expect(bodies).toHaveLength(2);
		// The hook was asked exactly once, for the retry.
		expect(refreshCalls).toHaveLength(1);
		expect(refreshCalls[0].accountId).toBe(account.id);
		expect(refreshCalls[0].body).toBe(bodies[0]);
		// The retry that went out is the refreshed one, not a verbatim replay.
		expect(bodies[1]).not.toBe(bodies[0]);
		expect(bodies[1]).toBe(`${bodies[0]}#refreshed`);
	});

	it("leaves a provider without the hook byte for byte as it was", async () => {
		const bodies = scriptUpstream();
		const refreshCalls: RefreshCall[] = [];
		const ctx = makeProxyContext(false, refreshCalls);
		const account = makeAccount();

		await runProxy(account, makeRequestBody(), ctx);

		expect(bodies).toHaveLength(2);
		expect(refreshCalls).toHaveLength(0);
		expect(bodies[1]).toBe(bodies[0]);
	});
});
