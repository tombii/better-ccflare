import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { NanoGPTProvider } from "@better-ccflare/providers";
import type { Account, RequestMeta } from "@better-ccflare/types";
import { proxyWithAccount } from "../proxy-operations";
import type { ProxyContext } from "../proxy-types";

// A slot (combo override) model carries a OpenRouter-style routing suffix. The
// suffix must only reach the upstream body on a host that accepts `provider`:
// a NanoGPT account pointed at a third-party custom endpoint is not NanoGPT.

function makeAccount(overrides: Partial<Account> = {}): Account {
	return {
		id: "acc-nano",
		name: "nanogpt",
		provider: "nanogpt",
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

const CUSTOM_HOST = "https://gateway.example.com/v1";

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
		// Registry miss fallback — same NanoGPT adapter, so the account-aware
		// answer is exercised either way the provider is resolved.
		provider: new NanoGPTProvider() as never,
		refreshInFlight: new Map(),
		asyncWriter: { enqueue: mock(() => {}) } as never,
		config: { getStorePayloads: () => false } as never,
		internalProbeSecret: "test-secret",
	};
}

/** Runs one request, recording the body every fetch attempt sends. */
async function run(opts: {
	account: Account;
	requestModel: string;
	modelOverride: string;
	firstStatus?: number;
}): Promise<Array<{ model?: unknown; provider?: unknown }>> {
	const sent: Array<{ model?: unknown; provider?: unknown }> = [];
	globalThis.fetch = mock(async (input: RequestInfo | URL) => {
		const req = input instanceof Request ? input : new Request(String(input));
		const body = JSON.parse(await req.text().catch(() => "{}"));
		sent.push({ model: body.model, provider: body.provider });
		if (sent.length === 1 && opts.firstStatus && opts.firstStatus !== 200) {
			return new Response(
				JSON.stringify({
					error: {
						type: "not_found_error",
						message: "model not found: moonshot/kimi-k3",
					},
				}),
				{
					status: opts.firstStatus,
					headers: { "Content-Type": "application/json" },
				},
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

	const encoded = new TextEncoder().encode(
		JSON.stringify({
			model: opts.requestModel,
			messages: [{ role: "user", content: "hello" }],
			max_tokens: 10,
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
	const meta: RequestMeta = {
		id: "req-1",
		method: "POST",
		path: "/v1/messages",
		timestamp: Date.now(),
		headers: new Headers(),
	};
	try {
		await proxyWithAccount(
			req,
			new URL("https://proxy.local/v1/messages"),
			opts.account,
			meta,
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

describe("proxyWithAccount — NanoGPT slot routing respects the account's host", () => {
	let originalFetch: typeof globalThis.fetch;

	beforeEach(() => {
		originalFetch = globalThis.fetch;
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	it("drops the slot's routing on a custom endpoint and sends the stripped model", async () => {
		const sent = await run({
			account: makeAccount({ custom_endpoint: CUSTOM_HOST }),
			requestModel: "moonshot/kimi-k3",
			modelOverride: 'moonshot/kimi-k3 {"only":["moonshot"]}',
		});

		expect(sent).toHaveLength(1);
		expect(sent[0]).toEqual({
			model: "moonshot/kimi-k3",
			provider: undefined,
		});
	});

	it("sends the slot's routing on the default NanoGPT host", async () => {
		const sent = await run({
			account: makeAccount(),
			requestModel: "moonshot/kimi-k3",
			modelOverride: 'moonshot/kimi-k3 {"only":["moonshot"]}',
		});

		expect(sent).toHaveLength(1);
		expect(sent[0]).toEqual({
			model: "moonshot/kimi-k3",
			provider: { only: ["moonshot"] },
		});
	});

	it("does not re-introduce routing on a fallback entry for a custom endpoint", async () => {
		const sent = await run({
			account: makeAccount({
				custom_endpoint: CUSTOM_HOST,
				model_mappings: JSON.stringify({
					"moonshot/kimi-k3": ["moonshot/kimi-k3", "z-ai/glm-4.5-air:free"],
				}),
			}),
			requestModel: "moonshot/kimi-k3",
			modelOverride: 'moonshot/kimi-k3 {"only":["moonshot"]}',
			firstStatus: 404,
		});

		expect(sent).toHaveLength(2);
		expect(sent[0]).toEqual({
			model: "moonshot/kimi-k3",
			provider: undefined,
		});
		expect(sent[1]).toEqual({
			model: "z-ai/glm-4.5-air:free",
			provider: undefined,
		});
	});
});
