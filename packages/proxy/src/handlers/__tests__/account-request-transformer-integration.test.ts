import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import {
	getProvider,
	OpenAICompatibleProvider,
	type ProviderResponseContext,
	registerProvider,
} from "@better-ccflare/providers";
import type { Account, RequestMeta } from "@better-ccflare/types";
import { proxyWithAccount } from "../proxy-operations";
import type { ProxyContext } from "../proxy-types";

function makeAccount(overrides: Partial<Account> = {}): Account {
	return {
		id: "account-request-transformer-integration",
		name: "OpenAI integration",
		provider: "openai-compatible",
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
		requires_reauth: false,
		rate_limit_reset: null,
		rate_limit_status: null,
		rate_limit_remaining: null,
		priority: 0,
		auto_fallback_enabled: false,
		auto_refresh_enabled: false,
		auto_pause_on_overage_enabled: false,
		peak_hours_pause_enabled: false,
		custom_endpoint: "https://openai.example/v1",
		model_mappings: JSON.stringify({ sonnet: "primary-openai-model" }),
		request_transformer: "max-tokens-to-max-completion-tokens",
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
		id: "request-transformer-integration",
		method: "POST",
		path: "/v1/messages",
		timestamp: Date.now(),
		headers: new Headers(),
	};
}

function makeRequestBody(): ArrayBuffer {
	return new TextEncoder().encode(
		JSON.stringify({
			model: "claude-sonnet-4-5",
			messages: [{ role: "user", content: "hello" }],
			max_tokens: 321,
		}),
	).buffer;
}

function makeProxyContext(): ProxyContext {
	return {
		strategy: { getNextAccount: () => null } as never,
		dbOps: {
			markAccountRateLimited: mock(() =>
				Promise.resolve({ consecutiveRateLimits: 1, applied: true }),
			),
			saveRequest: mock(() => Promise.resolve()),
			updateAccountUsage: mock(() => Promise.resolve()),
			getAdapter: mock(() => ({
				run: mock(() => Promise.resolve()),
				get: mock(() => Promise.resolve(null)),
			})),
		} as never,
		runtime: { port: 8080, clientId: "test" } as never,
		provider: {
			name: "unused-context-provider",
			canHandle: () => false,
		} as never,
		refreshInFlight: new Map(),
		asyncWriter: { enqueue: mock(() => {}) } as never,
		config: { getStorePayloads: () => true } as never,
		internalProbeSecret: "test-secret",
	};
}

function makeRequest(body: ArrayBuffer): Request {
	return new Request("https://proxy.local/v1/messages", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body,
	});
}

function jsonResponse(body: object, status: number): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}

function streamResponseWithoutModel(): Response {
	return new Response(
		`data: ${JSON.stringify({
			id: "chatcmpl-stream",
			choices: [{ delta: { content: "done" }, finish_reason: null }],
		})}\n\ndata: [DONE]\n\n`,
		{ headers: { "content-type": "text/event-stream" } },
	);
}

async function runProxy(account: Account, body: ArrayBuffer): Promise<void> {
	try {
		await proxyWithAccount(
			makeRequest(body),
			new URL("https://proxy.local/v1/messages"),
			account,
			makeRequestMeta(),
			body,
			() => undefined,
			0,
			makeProxyContext(),
		);
	} catch (error) {
		if (
			!(error instanceof Error) ||
			!error.message.includes("UsageCollector not initialized")
		) {
			throw error;
		}
	}
}

describe("proxy account request transformer ordering", () => {
	let originalFetch: typeof globalThis.fetch;

	beforeEach(() => {
		originalFetch = globalThis.fetch;
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	it("applies the account transformer after OpenAI provider conversion", async () => {
		const outboundBodies: Record<string, unknown>[] = [];
		globalThis.fetch = mock(async (input: RequestInfo | URL) => {
			const request =
				input instanceof Request ? input : new Request(String(input));
			outboundBodies.push(await request.json());
			return jsonResponse(
				{
					id: "chatcmpl-1",
					object: "chat.completion",
					choices: [
						{
							index: 0,
							message: { role: "assistant", content: "done" },
							finish_reason: "stop",
						},
					],
					usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
				},
				200,
			);
		});

		await runProxy(makeAccount(), makeRequestBody());

		expect(outboundBodies).toHaveLength(1);
		expect(outboundBodies[0]?.max_completion_tokens).toBe(321);
		expect(outboundBodies[0]).not.toHaveProperty("max_tokens");
	});

	it("uses the mapped outbound model when the upstream stream omits model", async () => {
		const originalProvider = getProvider("openai-compatible");
		let convertedModel: string | undefined;

		class InspectingOpenAIProvider extends OpenAICompatibleProvider {
			override async processResponse(
				response: Response,
				account: Account | null,
				requestHeaders?: Headers,
				drainAbort?: AbortController,
				context?: ProviderResponseContext,
			): Promise<Response> {
				const processed = await super.processResponse(
					response,
					account,
					requestHeaders,
					drainAbort,
					context,
				);
				const raw = await processed.text();
				const messageStart = raw
					.split("\n")
					.find((line) => line.startsWith('data: {"type":"message_start"'));
				if (messageStart) {
					convertedModel = JSON.parse(messageStart.slice(6)).message.model;
				}

				// Stop before forwardToClient needs the process-global usage collector.
				return new Response(null, { status: 401 });
			}
		}

		registerProvider(new InspectingOpenAIProvider());
		globalThis.fetch = mock(async () => streamResponseWithoutModel());

		try {
			await runProxy(makeAccount(), makeRequestBody());
			expect(convertedModel).toBe("primary-openai-model");
		} finally {
			if (originalProvider) registerProvider(originalProvider);
		}
	});

	it("uses the final model fallback when its upstream stream omits model", async () => {
		const originalProvider = getProvider("openai-compatible");
		const outboundModels: unknown[] = [];
		let convertedModel: string | undefined;

		class InspectingOpenAIProvider extends OpenAICompatibleProvider {
			override async processResponse(
				response: Response,
				account: Account | null,
				requestHeaders?: Headers,
				drainAbort?: AbortController,
				context?: ProviderResponseContext,
			): Promise<Response> {
				const processed = await super.processResponse(
					response,
					account,
					requestHeaders,
					drainAbort,
					context,
				);
				const raw = await processed.text();
				const messageStart = raw
					.split("\n")
					.find((line) => line.startsWith('data: {"type":"message_start"'));
				if (messageStart) {
					convertedModel = JSON.parse(messageStart.slice(6)).message.model;
				}
				return new Response(null, { status: 401 });
			}
		}

		registerProvider(new InspectingOpenAIProvider());
		globalThis.fetch = mock(async (input: RequestInfo | URL) => {
			const request =
				input instanceof Request ? input : new Request(String(input));
			const body = (await request.json()) as Record<string, unknown>;
			outboundModels.push(body.model);

			return outboundModels.length === 1
				? jsonResponse({ error: { message: "Rate limit exceeded" } }, 429)
				: streamResponseWithoutModel();
		});

		try {
			await runProxy(
				makeAccount({
					model_fallbacks: JSON.stringify({
						sonnet: "fallback-openai-model",
					}),
				}),
				makeRequestBody(),
			);
			expect(outboundModels).toEqual([
				"primary-openai-model",
				"fallback-openai-model",
			]);
			expect(convertedModel).toBe("fallback-openai-model");
		} finally {
			if (originalProvider) registerProvider(originalProvider);
		}
	});

	it("applies the account transformer to the model-fallback attempt", async () => {
		const outboundBodies: Record<string, unknown>[] = [];
		globalThis.fetch = mock(async (input: RequestInfo | URL) => {
			const request =
				input instanceof Request ? input : new Request(String(input));
			const body = (await request.json()) as Record<string, unknown>;
			outboundBodies.push(body);

			if (outboundBodies.length === 1) {
				return jsonResponse(
					{
						error: {
							type: "api_error",
							message: "Rate limit exceeded for primary-openai-model",
						},
					},
					429,
				);
			}

			return jsonResponse(
				{
					id: "chatcmpl-2",
					object: "chat.completion",
					choices: [
						{
							index: 0,
							message: { role: "assistant", content: "done" },
							finish_reason: "stop",
						},
					],
					usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
				},
				200,
			);
		});

		await runProxy(
			makeAccount({
				model_fallbacks: JSON.stringify({
					sonnet: "fallback-openai-model",
				}),
			}),
			makeRequestBody(),
		);

		expect(outboundBodies).toHaveLength(2);
		for (const body of outboundBodies) {
			expect(body.max_completion_tokens).toBe(321);
			expect(body).not.toHaveProperty("max_tokens");
		}
	});
});
