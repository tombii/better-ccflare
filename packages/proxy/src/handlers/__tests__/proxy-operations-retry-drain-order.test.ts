import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import type { Account, RequestMeta } from "@better-ccflare/types";
import { proxyWithAccount } from "../proxy-operations";
import type { ProxyContext } from "../proxy-types";
import { resetRateLimitProbeGatesForTests } from "../rate-limit-cooldown";

/**
 * Issue #273 (Bun off-heap fetch leak) — drain ordering in the two in-place
 * retry loops of `proxyWithAccount`.
 *
 * Both loops used to re-issue the request first and drain the superseded
 * response only after the re-issue resolved:
 *
 *     const retryResponse = await reissueRequestInPlace();
 *     cancelDiscardedResponseBody(response);   // never reached on a throw
 *
 * When the re-issue rejects — a connection reset is the common one, and it is
 * exactly what an upstream in trouble does on the second call — the throw
 * escapes to proxyWithAccount's outer catch, which fails over to the next
 * account. The 5xx/529 body we had already decided to discard is then never
 * drained and holds its off-heap backing store until GC.
 *
 * These tests hand the first attempt a body whose reads are observable and
 * make the second fetch reject, then assert the first body was disposed of
 * anyway.
 */

function makeAccount(overrides: Partial<Account> = {}): Account {
	return {
		id: "acc-drain-1",
		name: "anthropic-drain",
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

function makeRequestMeta(): RequestMeta {
	return {
		id: "req-drain-1",
		method: "POST",
		path: "/v1/messages",
		timestamp: Date.now(),
		headers: new Headers(),
		clientSessionId: "sess-drain",
	};
}

function makeRequestBody(): ArrayBuffer {
	return new TextEncoder().encode(
		JSON.stringify({
			model: "claude-sonnet-4-5",
			messages: [{ role: "user", content: "hello" }],
			max_tokens: 10,
		}),
	).buffer as ArrayBuffer;
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

/**
 * A body whose consumption is observable: `closed` flips when the producer has
 * handed over every chunk (a full drain), `cancelled` when the consumer tore
 * the stream down instead. Either one means the backing store was released;
 * neither means the response was abandoned intact.
 */
function observableBody(chunkCount: number) {
	const state = { pulls: 0, closed: false, cancelled: false };
	const stream = new ReadableStream<Uint8Array>({
		pull(controller) {
			state.pulls++;
			if (state.pulls > chunkCount) {
				state.closed = true;
				controller.close();
				return;
			}
			controller.enqueue(new TextEncoder().encode(`chunk-${state.pulls}--`));
		},
		cancel() {
			state.cancelled = true;
		},
	});
	return { stream, state };
}

/**
 * Gives the queued `void drainBody(...)` microtasks a turn: the production
 * helper is deliberately fire-and-forget.
 */
async function settleDrain(): Promise<void> {
	for (let i = 0; i < 20; i++) await Promise.resolve();
	await new Promise((resolve) => setTimeout(resolve, 5));
}

async function runProxy(
	account: Account,
	ctx: ProxyContext,
): Promise<Response | null> {
	const bodyBuffer = makeRequestBody();
	const req = new Request("https://proxy.local/v1/messages", {
		method: "POST",
		body: bodyBuffer,
		headers: { "Content-Type": "application/json" },
	});
	return proxyWithAccount(
		req,
		new URL("https://proxy.local/v1/messages"),
		account,
		makeRequestMeta(),
		bodyBuffer,
		() => undefined,
		0,
		ctx,
	);
}

describe("in-place retry loops drain the superseded response before re-issuing", () => {
	let originalFetch: typeof globalThis.fetch;

	beforeEach(() => {
		originalFetch = globalThis.fetch;
		process.env.CCFLARE_OVERLOAD_RETRY_BASE_MS = "0";
		process.env.CCFLARE_OVERLOAD_RETRY_MAX_MS = "0";
		resetRateLimitProbeGatesForTests();
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
		delete process.env.CCFLARE_OVERLOAD_RETRY_BASE_MS;
		delete process.env.CCFLARE_OVERLOAD_RETRY_MAX_MS;
		resetRateLimitProbeGatesForTests();
	});

	it("drains a 500 body even when the re-issue rejects with a connection reset", async () => {
		const { stream, state } = observableBody(4);
		let callCount = 0;
		globalThis.fetch = mock(async () => {
			callCount++;
			if (callCount === 1) {
				return new Response(stream, {
					status: 500,
					headers: { "content-type": "application/json" },
				});
			}
			throw new TypeError("connection reset");
		});

		const ctx = makeProxyContext();
		const account = makeAccount();
		const result = await runProxy(account, ctx);
		await settleDrain();

		// The re-issue failure is a failover, not a client-visible throw.
		expect(callCount).toBe(2);
		expect(result).toBeNull();
		// And the response we had already decided to discard was disposed of.
		expect(state.closed || state.cancelled).toBe(true);
	});

	it("drains a 529 body even when the re-issue rejects with a connection reset", async () => {
		const { stream, state } = observableBody(4);
		let callCount = 0;
		globalThis.fetch = mock(async () => {
			callCount++;
			if (callCount === 1) {
				return new Response(stream, {
					status: 529,
					headers: { "content-type": "application/json" },
				});
			}
			throw new TypeError("connection reset");
		});

		const ctx = makeProxyContext();
		const account = makeAccount();
		const result = await runProxy(account, ctx);
		await settleDrain();

		expect(callCount).toBe(2);
		expect(result).toBeNull();
		expect(state.closed || state.cancelled).toBe(true);
	});
});
