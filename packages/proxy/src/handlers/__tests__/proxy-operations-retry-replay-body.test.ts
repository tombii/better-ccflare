import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import type { Account, RequestMeta } from "@better-ccflare/types";
import { proxyWithAccount } from "../proxy-operations";
import type { ProxyContext } from "../proxy-types";
import { resetRateLimitProbeGatesForTests } from "../rate-limit-cooldown";

/**
 * The in-place 529/5xx retry rebuilds the request from a buffered Request plus
 * a buffered body text. Three recovery paths change what is actually in flight,
 * and each used to update a different subset of that pair:
 *
 *   - the model-fallback loop re-issued against the next model in the list and
 *     recorded it only in `responseModelFallback`;
 *   - the cache-control recovery re-issued with `cache_control` stripped and
 *     updated the Request but not the buffered body text;
 *   - the thinking-signature recovery re-issued with thinking blocks filtered
 *     and updated neither.
 *
 * A retry after any of them therefore replayed a request the upstream had
 * already rejected — the model it had just called unavailable, the field it had
 * just refused, the signature it had just failed to verify. These cases pin
 * every outbound body to the request that was actually in flight when the
 * 5xx/529 arrived.
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
		clientSessionId: "sess-replay",
		...overrides,
	};
}

function encode(body: unknown) {
	return new TextEncoder().encode(JSON.stringify(body)).buffer;
}

function plainBody() {
	return encode({
		model: "claude-sonnet-4-5",
		messages: [{ role: "user", content: "hello" }],
		max_tokens: 10,
	});
}

/** A body whose message parts carry `cache_control`, so stripping changes it. */
function cacheControlBody() {
	return encode({
		model: "claude-sonnet-4-5",
		messages: [
			{
				role: "user",
				content: [
					{
						type: "text",
						text: "hello",
						cache_control: { type: "ephemeral" },
					},
				],
			},
		],
		max_tokens: 10,
	});
}

/** A body with a thinking block, so `filterThinkingBlocks` changes it. */
function thinkingBody() {
	return encode({
		model: "claude-sonnet-4-5",
		thinking: { type: "enabled", budget_tokens: 1024 },
		messages: [
			{ role: "user", content: "hello" },
			{
				role: "assistant",
				content: [
					{ type: "thinking", thinking: "hmm", signature: "bogus-signature" },
					{ type: "text", text: "hi" },
				],
			},
			{ role: "user", content: "again" },
		],
		max_tokens: 10,
	});
}

/**
 * Both recoveries in one body: a bogus thinking signature AND `cache_control`
 * on a content part, so the thinking recovery runs first and the cache-control
 * recovery then has to build on ITS body rather than on the original.
 */
function thinkingAndCacheControlBody() {
	return encode({
		model: "claude-sonnet-4-5",
		thinking: { type: "enabled", budget_tokens: 1024 },
		messages: [
			{
				role: "user",
				content: [
					{
						type: "text",
						text: "hello",
						cache_control: { type: "ephemeral" },
					},
				],
			},
			{
				role: "assistant",
				content: [
					{ type: "thinking", thinking: "hmm", signature: "bogus-signature" },
					{ type: "text", text: "hi" },
				],
			},
			{ role: "user", content: "again" },
		],
		max_tokens: 10,
	});
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

function jsonResponse(body: unknown, status: number) {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}

const modelNotFound404 = () =>
	jsonResponse(
		{
			type: "error",
			error: { type: "not_found_error", message: "model not found" },
		},
		404,
	);

const serverError500 = () =>
	jsonResponse(
		{
			type: "error",
			error: { type: "api_error", message: "Internal server error" },
		},
		500,
	);

const overloaded529 = () =>
	jsonResponse(
		{
			type: "error",
			error: { type: "overloaded_error", message: "Overloaded" },
		},
		529,
	);

const cacheControlRejection400 = () =>
	jsonResponse(
		{
			error: {
				type: "invalid_request_error",
				message:
					"messages.0.content.0.cache_control: Extra inputs are not permitted",
			},
		},
		400,
	);

const invalidThinkingSignature400 = () =>
	jsonResponse(
		{
			type: "error",
			error: {
				type: "invalid_request_error",
				message:
					"messages.1.content.0: Invalid `signature` in `thinking` block",
			},
		},
		400,
	);

/**
 * Records every outbound request body and answers from a scripted list.
 * Returns the captured bodies (raw text and parsed, when parseable).
 */
function scriptUpstream(responses: Array<() => Response>) {
	const bodies: string[] = [];
	globalThis.fetch = mock(async (input: RequestInfo | URL) => {
		const req = input instanceof Request ? input : new Request(String(input));
		bodies.push(await req.text().catch(() => ""));
		const factory =
			responses[Math.min(bodies.length - 1, responses.length - 1)];
		return factory();
	});
	return bodies;
}

async function runProxy(account: Account, bodyBuffer: ArrayBuffer) {
	const ctx = makeProxyContext();
	let result: Response | null = null;
	let forwarded = false;
	try {
		result = await proxyWithAccount(
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
		forwarded = true;
	}
	return { ctx, result, forwarded };
}

const modelOf = (bodyText: string): string => {
	try {
		return (JSON.parse(bodyText) as { model?: string }).model ?? "unknown";
	} catch {
		return "unparseable";
	}
};

describe("proxyWithAccount — an in-place retry replays the request actually in flight", () => {
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
		delete process.env.CCFLARE_OVERLOAD_RETRY_BASE_MS;
		delete process.env.CCFLARE_OVERLOAD_RETRY_MAX_MS;
		delete process.env.CCFLARE_OVERLOAD_RETRY_ENABLED;
		delete process.env.CCFLARE_OVERLOAD_RETRY_MAX_ATTEMPTS;
		delete process.env.CCFLARE_SERVER_ERROR_RETRY_ENABLED;
		delete process.env.CCFLARE_SERVER_ERROR_COOLDOWN_MS;
		resetRateLimitProbeGatesForTests();
	});

	it("replays the fallback model, not the one the upstream just rejected (5xx)", async () => {
		const bodies = scriptUpstream([
			modelNotFound404,
			serverError500,
			serverError500,
		]);

		await runProxy(
			makeAccount({
				id: "acc-fallback-5xx",
				model_mappings: JSON.stringify({ sonnet: ["model-a", "model-b"] }),
			}),
			plainBody(),
		);

		expect(bodies).toHaveLength(3);
		expect(bodies.map(modelOf)).toEqual(["model-a", "model-b", "model-b"]);
	});

	it("replays the fallback model, not the one the upstream just rejected (529)", async () => {
		const bodies = scriptUpstream([
			modelNotFound404,
			overloaded529,
			overloaded529,
		]);

		await runProxy(
			makeAccount({
				id: "acc-fallback-529",
				model_mappings: JSON.stringify({ sonnet: ["model-a", "model-b"] }),
			}),
			plainBody(),
		);

		expect(bodies).toHaveLength(3);
		expect(bodies.map(modelOf)).toEqual(["model-a", "model-b", "model-b"]);
	});

	it("replays the cache_control-stripped body after a cache-control recovery", async () => {
		const bodies = scriptUpstream([
			cacheControlRejection400,
			serverError500,
			serverError500,
		]);

		await runProxy(
			// A fresh account id: the (account, model) rejector set is module-level
			// and survives between tests, and a pre-stripped first attempt would
			// make the recovery unreachable.
			makeAccount({ id: "acc-cache-control" }),
			cacheControlBody(),
		);

		expect(bodies).toHaveLength(3);
		// The recovery really did change the body.
		expect(bodies[0]).toContain("cache_control");
		expect(bodies[1]).not.toContain("cache_control");
		// …and the retry replays the recovered body, not the rejected one.
		expect(bodies[2]).toBe(bodies[1]);
	});

	it("builds the cache-control recovery on the thinking-filtered body, not on the original", async () => {
		const bodies = scriptUpstream([
			invalidThinkingSignature400,
			cacheControlRejection400,
			serverError500,
			serverError500,
		]);

		await runProxy(
			// Fresh id: the (account, model) rejector set is module-level, and a
			// pre-stripped first attempt would make the recovery unreachable.
			makeAccount({ id: "acc-thinking-then-cache-control" }),
			thinkingAndCacheControlBody(),
		);

		expect(bodies).toHaveLength(4);
		expect(bodies[0]).toContain('"type":"thinking"');
		expect(bodies[0]).toContain("cache_control");
		// The thinking recovery ran and left cache_control alone.
		expect(bodies[1]).not.toContain('"type":"thinking"');
		expect(bodies[1]).toContain("cache_control");
		// The cache-control recovery strips its field from the body currently in
		// flight. Rebuilding from the original request body instead would hand
		// the upstream back the thinking signature it rejected two responses ago.
		expect(bodies[2]).not.toContain("cache_control");
		expect(bodies[2]).not.toContain('"type":"thinking"');
		// …and the 5xx retry replays that same recovered body.
		expect(bodies[3]).toBe(bodies[2]);
	});

	it("replays the thinking-filtered body after a thinking-signature recovery", async () => {
		const bodies = scriptUpstream([
			invalidThinkingSignature400,
			serverError500,
			serverError500,
		]);

		await runProxy(makeAccount({ id: "acc-thinking" }), thinkingBody());

		expect(bodies).toHaveLength(3);
		// The recovery really did change the body.
		expect(bodies[0]).toContain('"type":"thinking"');
		expect(bodies[1]).not.toContain('"type":"thinking"');
		// …and the retry replays the recovered body, not the rejected one.
		expect(bodies[2]).toBe(bodies[1]);
	});
});
