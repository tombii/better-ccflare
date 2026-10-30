import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { splitModelRouting as parseModelRouting } from "@better-ccflare/core";
import type { Account, RequestMeta } from "@better-ccflare/types";
import { proxyWithAccount } from "../proxy-operations";
import type { ProxyContext } from "../proxy-types";

function makeAccount(overrides: Partial<Account> = {}): Account {
	return {
		id: "acc-1",
		name: "openrouter-routing",
		provider: "openrouter",
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
		custom_endpoint: "https://openrouter.ai/api/v1",
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

function makeBody(model: string) {
	const encoded = new TextEncoder().encode(
		JSON.stringify({
			model,
			messages: [{ role: "user", content: "hello" }],
			max_tokens: 10,
		}),
	);
	return encoded.buffer.slice(
		encoded.byteOffset,
		encoded.byteOffset + encoded.byteLength,
	) as ArrayBuffer;
}

/** Runs proxyWithAccount, recording the model/provider of every fetch. */
async function runFallback(opts: {
	requestModel: string;
	mappings: Record<string, string | string[]>;
	modelOverride?: string;
	firstStatus?: number;
}): Promise<Array<{ model?: string; provider?: unknown }>> {
	const sent: Array<{ model?: string; provider?: unknown }> = [];
	globalThis.fetch = mock(async (input: RequestInfo | URL) => {
		const req = input instanceof Request ? input : new Request(String(input));
		const body = JSON.parse(await req.text().catch(() => "{}"));
		sent.push({ model: body.model, provider: body.provider });
		if (sent.length === 1) {
			return new Response(
				JSON.stringify({
					error: {
						type: "api_error",
						message: "Rate limit exceeded: limit_rpm/model/abc",
					},
				}),
				{ status: 429, headers: { "Content-Type": "application/json" } },
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
	});

	// The fallback list is looked up by the model IN THE BODY, which the slot
	// override has already rewritten: give it the entry the test means.
	const mappings =
		opts.modelOverride !== undefined
			? {
					...opts.mappings,
					[parseModelRouting(opts.modelOverride).model]:
						opts.mappings.sonnet ?? [],
				}
			: opts.mappings;

	const bodyBuffer = makeBody(opts.requestModel);
	const req = new Request("https://proxy.local/v1/messages", {
		method: "POST",
		body: bodyBuffer,
		headers: { "Content-Type": "application/json" },
	});
	try {
		await proxyWithAccount(
			req,
			new URL("https://proxy.local/v1/messages"),
			makeAccount({ model_mappings: JSON.stringify(mappings) }),
			makeRequestMeta(),
			bodyBuffer,
			() => undefined,
			0,
			makeProxyContext(),
			opts.modelOverride,
		);
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		if (!msg.includes("UsageCollector not initialized")) throw e;
	}
	return sent;
}

describe("proxyWithAccount — model fallback follows each entry's routing suffix", () => {
	let originalFetch: typeof globalThis.fetch;

	beforeEach(() => {
		originalFetch = globalThis.fetch;
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	it("swaps the model and its provider routing together on fallback", async () => {
		const sent: Array<{ model?: string; provider?: unknown }> = [];
		globalThis.fetch = mock(async (input: RequestInfo | URL) => {
			const req = input instanceof Request ? input : new Request(String(input));
			const body = JSON.parse(await req.text().catch(() => "{}"));
			sent.push({ model: body.model, provider: body.provider });
			if (sent.length === 1) {
				return new Response(
					JSON.stringify({
						error: {
							type: "api_error",
							message: "Rate limit exceeded: limit_rpm/model/abc",
						},
					}),
					{ status: 429, headers: { "Content-Type": "application/json" } },
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
		});

		const bodyText = JSON.stringify({
			model: "claude-sonnet-4-5",
			messages: [{ role: "user", content: "hello" }],
			max_tokens: 10,
		});
		const encoded = new TextEncoder().encode(bodyText);
		const bodyBuffer = encoded.buffer.slice(
			encoded.byteOffset,
			encoded.byteOffset + encoded.byteLength,
		) as ArrayBuffer;
		const req = new Request("https://proxy.local/v1/messages", {
			method: "POST",
			body: bodyBuffer,
			headers: { "Content-Type": "application/json" },
		});

		const account = makeAccount({
			model_mappings: JSON.stringify({
				sonnet: [
					'a/model-a {"only":["provider-a"]}',
					'b/model-b {"ignore":["provider-b"],"sort":"price"}',
				],
			}),
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

		expect(sent).toHaveLength(2);
		expect(sent[0]).toEqual({
			model: "a/model-a",
			provider: { only: ["provider-a"] },
		});
		// The fallback's routing replaces the primary's — not the old pin.
		expect(sent[1]).toEqual({
			model: "b/model-b",
			provider: { ignore: ["provider-b"], sort: "price" },
		});
	});

	it("removes the previous model's routing when the fallback entry has none", async () => {
		const sent: Array<{ model?: string; provider?: unknown }> = [];
		globalThis.fetch = mock(async (input: RequestInfo | URL) => {
			const req = input instanceof Request ? input : new Request(String(input));
			const body = JSON.parse(await req.text().catch(() => "{}"));
			sent.push({ model: body.model, provider: body.provider });
			if (sent.length === 1) {
				return new Response(
					JSON.stringify({
						error: {
							type: "api_error",
							message: "Rate limit exceeded: limit_rpm/model/abc",
						},
					}),
					{ status: 429, headers: { "Content-Type": "application/json" } },
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
		});

		const bodyText = JSON.stringify({
			model: "claude-sonnet-4-5",
			messages: [{ role: "user", content: "hello" }],
			max_tokens: 10,
		});
		const encoded = new TextEncoder().encode(bodyText);
		const bodyBuffer = encoded.buffer.slice(
			encoded.byteOffset,
			encoded.byteOffset + encoded.byteLength,
		) as ArrayBuffer;
		const req = new Request("https://proxy.local/v1/messages", {
			method: "POST",
			body: bodyBuffer,
			headers: { "Content-Type": "application/json" },
		});

		const account = makeAccount({
			model_mappings: JSON.stringify({
				sonnet: ['a/model-a {"only":["provider-a"]}', "b/model-b"],
			}),
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

		expect(sent).toHaveLength(2);
		expect(sent[1]).toEqual({ model: "b/model-b", provider: undefined });
	});
});

describe("proxyWithAccount — a slot's pin is inherited by unpinned fallback entries", () => {
	let originalFetch: typeof globalThis.fetch;

	beforeEach(() => {
		originalFetch = globalThis.fetch;
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	// The slot (override) pin is a per-model default. A list entry without its
	// own suffix inherits it; otherwise the fallback would silently drop the
	// operator's pin (and could violate an `ignore`).

	it("inherits a slot only: pin for a fallback entry with no suffix", async () => {
		// The client already asks for the slot's bare model, so the override
		// does not change the model name — only the pin must survive.
		const sent = await runFallback({
			requestModel: "moonshot/kimi-k3",
			modelOverride: 'moonshot/kimi-k3 {"only":["moonshot"]}',
			mappings: { sonnet: ["moonshot/kimi-k3", "z-ai/glm-4.5-air:free"] },
		});

		expect(sent).toHaveLength(2);
		expect(sent[0]).toEqual({
			model: "moonshot/kimi-k3",
			provider: { only: ["moonshot"] },
		});
		expect(sent[1]).toEqual({
			model: "z-ai/glm-4.5-air:free",
			provider: { only: ["moonshot"] },
		});
	});

	it("inherits a slot ignore: pin for a fallback entry with no suffix", async () => {
		const sent = await runFallback({
			requestModel: "a/model-a",
			modelOverride: 'a/model-a {"ignore":["deepseek"]}',
			mappings: { sonnet: ["a/model-a", "b/model-b"] },
		});

		expect(sent).toHaveLength(2);
		expect(sent[1]).toEqual({
			model: "b/model-b",
			provider: { ignore: ["deepseek"] },
		});
	});

	it("lets a fallback entry's own suffix override the slot pin", async () => {
		const sent = await runFallback({
			requestModel: "a/model-a",
			modelOverride: 'a/model-a {"only":["slot-pin"]}',
			mappings: {
				sonnet: ["a/model-a", 'b/model-b {"only":["entry-pin"]}'],
			},
		});

		expect(sent).toHaveLength(2);
		expect(sent[1]).toEqual({
			model: "b/model-b",
			provider: { only: ["entry-pin"] },
		});
	});

	it("still removes entry 1's pin for entry 2 when there is no slot pin", async () => {
		const sent = await runFallback({
			requestModel: "claude-sonnet-4-5",
			mappings: {
				sonnet: ['a/model-a {"only":["provider-a"]}', "b/model-b"],
			},
		});

		expect(sent).toHaveLength(2);
		expect(sent[1]).toEqual({ model: "b/model-b", provider: undefined });
	});

	it("applies the slot's routing on the first request when the model differs", async () => {
		const sent = await runFallback({
			requestModel: "claude-sonnet-4-5",
			modelOverride: 'a/model-a {"only":["moonshot"]}',
			mappings: { sonnet: ["a/model-a"] },
		});

		expect(sent[0]).toEqual({
			model: "a/model-a",
			provider: { only: ["moonshot"] },
		});
	});
});
