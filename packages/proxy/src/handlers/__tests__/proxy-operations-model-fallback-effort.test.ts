import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { setReasoningEffortOverrides } from "@better-ccflare/openai-formats";
import type { Account, RequestMeta } from "@better-ccflare/types";
import { proxyWithAccount } from "../proxy-operations";
import type { ProxyContext } from "../proxy-types";

function makeAccount(overrides: Partial<Account> = {}): Account {
	return {
		id: "acc-1",
		name: "effort-fallback",
		provider: "anthropic-compatible",
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
		custom_endpoint: "https://upstream.example.test",
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

function makeProxyContext(): ProxyContext {
	return {
		strategy: { getNextAccount: () => null } as never,
		dbOps: {
			markAccountRateLimited: mock(() => Promise.resolve({})),
			saveRequest: mock(() => Promise.resolve()),
			updateAccountUsage: mock(() => Promise.resolve()),
			getAdapter: mock(() => ({
				run: mock(() => Promise.resolve()),
				get: mock(() => Promise.resolve(null)),
			})),
		} as never,
		runtime: { port: 8080, clientId: "test" } as never,
		provider: {
			name: "openrouter",
			canHandle: () => true,
			buildUrl: () => "https://openrouter.ai/api/v1/messages",
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
		asyncWriter: { enqueue: mock(() => {}) } as never,
		config: { getStorePayloads: () => false } as never,
		internalProbeSecret: "test-secret",
	};
}

/** Runs proxyWithAccount; the primary model is unavailable (404). */
async function runEffortFallback(
	account: Account,
	clientBody: Record<string, unknown>,
): Promise<Array<Record<string, unknown>>> {
	const sent: Array<Record<string, unknown>> = [];
	globalThis.fetch = mock(async (input: RequestInfo | URL) => {
		const req = input instanceof Request ? input : new Request(String(input));
		const body = JSON.parse(await req.text().catch(() => "{}"));
		sent.push(body);
		if (sent.length === 1) {
			return new Response(
				JSON.stringify({
					type: "error",
					error: { type: "not_found_error", message: "model: not found" },
				}),
				{ status: 404, headers: { "Content-Type": "application/json" } },
			);
		}
		return new Response(
			JSON.stringify({
				id: "msg_1",
				type: "message",
				role: "assistant",
				content: [{ type: "text", text: "hi" }],
				model: body.model,
				stop_reason: "end_turn",
				usage: { input_tokens: 1, output_tokens: 1 },
			}),
			{ status: 200, headers: { "Content-Type": "application/json" } },
		);
	}) as unknown as typeof fetch;

	const encoded = new TextEncoder().encode(
		JSON.stringify({
			messages: [{ role: "user", content: "hello" }],
			max_tokens: 10,
			...clientBody,
		}),
	);
	const bodyBuffer = encoded.buffer.slice(
		encoded.byteOffset,
		encoded.byteOffset + encoded.byteLength,
	) as ArrayBuffer;
	const req = new Request("https://proxy.local/v1/messages", {
		method: "POST",
		body: bodyBuffer,
		headers: { "Content-Type": "application/json" },
	});
	try {
		await proxyWithAccount(
			req,
			new URL("https://proxy.local/v1/messages"),
			account,
			makeRequestMeta(),
			bodyBuffer,
			() => undefined,
			0,
			makeProxyContext(),
		);
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		if (!msg.includes("UsageCollector not initialized")) throw e;
	}
	return sent;
}

// sonnet falls back to claude-haiku-4-5, but the haiku FAMILY is mapped to an
// Opus model. The provider transform therefore clamps the fallback as Opus,
// while claude-haiku-4-5 is what is actually sent: the effort has to be
// re-clamped against the model on the wire.
const MAPPINGS = JSON.stringify({
	sonnet: ["claude-sonnet-4-6", "claude-haiku-4-5"],
	haiku: "claude-opus-4-7",
});

describe("proxyWithAccount — model fallback re-clamps reasoning effort", () => {
	let originalFetch: typeof globalThis.fetch;

	beforeEach(() => {
		originalFetch = globalThis.fetch;
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
		setReasoningEffortOverrides(null);
	});

	it("anthropic-compatible: output_config.effort is resolved against the sent fallback model", async () => {
		const sent = await runEffortFallback(
			makeAccount({ model_mappings: MAPPINGS }),
			{ model: "claude-sonnet-4-5", reasoning: { effort: "high" } },
		);

		expect(sent).toHaveLength(2);
		expect(sent[0].model).toBe("claude-sonnet-4-6");
		expect(sent[0].output_config).toEqual({ effort: "high" });
		expect(sent[1].model).toBe("claude-haiku-4-5");
		expect(sent[1].output_config).toEqual({ effort: "medium" });
		expect(sent[1].reasoning).toBeUndefined();
	});

	it("anthropic-compatible: starts from the client's original effort, not the previous clamp", async () => {
		// The Opus model the transform clamps against only allows "low", so the
		// transformed body carries "low". Re-clamping that value for haiku would
		// keep "low"; starting from the client's "high" gives haiku's "medium".
		setReasoningEffortOverrides({ "claude-opus-4-7": ["low"] });
		const sent = await runEffortFallback(
			makeAccount({ model_mappings: MAPPINGS }),
			{ model: "claude-sonnet-4-5", reasoning: { effort: "high" } },
		);

		expect(sent).toHaveLength(2);
		expect(sent[1].model).toBe("claude-haiku-4-5");
		expect(sent[1].output_config).toEqual({ effort: "medium" });
	});

	it("anthropic-compatible: a client-native output_config.effort is never touched", async () => {
		const sent = await runEffortFallback(
			makeAccount({ model_mappings: MAPPINGS }),
			{
				model: "claude-sonnet-4-5",
				reasoning: { effort: "low" },
				output_config: { effort: "max" },
			},
		);

		expect(sent).toHaveLength(2);
		expect(sent[1].model).toBe("claude-haiku-4-5");
		expect(sent[1].output_config).toEqual({ effort: "max" });
	});

	it("openai-compatible: reasoning_effort is resolved against the sent fallback model", async () => {
		setReasoningEffortOverrides({ "claude-opus-4-7": ["low"] });
		const sent = await runEffortFallback(
			makeAccount({
				provider: "openai-compatible",
				custom_endpoint: "https://cliproxy.example.test/v1",
				model_mappings: MAPPINGS,
			}),
			{ model: "claude-sonnet-4-5", reasoning: { effort: "high" } },
		);

		expect(sent).toHaveLength(2);
		expect(sent[0].model).toBe("claude-sonnet-4-6");
		expect(sent[0].reasoning_effort).toBe("high");
		expect(sent[1].model).toBe("claude-haiku-4-5");
		expect(sent[1].reasoning_effort).toBe("medium");
		expect(sent[1].reasoning).toBeUndefined();
	});

	it("does not add an effort the client never sent", async () => {
		const sent = await runEffortFallback(
			makeAccount({ model_mappings: MAPPINGS }),
			{ model: "claude-sonnet-4-5" },
		);

		expect(sent).toHaveLength(2);
		expect(sent[1].model).toBe("claude-haiku-4-5");
		expect(sent[1].output_config).toBeUndefined();
		expect(sent[1].reasoning_effort).toBeUndefined();
	});
});
