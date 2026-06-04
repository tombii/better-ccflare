import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { OpenAICompatibleProvider } from "@better-ccflare/providers";
import type { Account } from "@better-ccflare/types";
import type { ProxyContext } from "../handlers";
import { handleProxy } from "../proxy";
import { NATIVE_PASSTHROUGH_HEADER } from "../routing/native-proxy-dispatch";

function makeOpenAIAccount(): Account {
	return {
		id: "openai-1",
		name: "openai-account",
		provider: "openai-compatible",
		api_key: "sk-test",
		refresh_token: "sk-test",
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
	};
}

function makeContext(accounts: Account[]): ProxyContext {
	return {
		strategy: { select: (accs: Account[]) => accs } as never,
		dbOps: {
			getAllAccounts: mock(async () => accounts),
			getActiveComboForFamily: mock(async () => null),
			markAccountRateLimited: mock(() => Promise.resolve(1)),
			saveRequest: mock(() => Promise.resolve()),
			updateAccountUsage: mock(() => Promise.resolve()),
			getAdapter: mock(() => ({
				run: mock(() => Promise.resolve()),
				get: mock(() => Promise.resolve(null)),
			})),
		} as never,
		runtime: { port: 8080, clientId: "test" } as never,
		config: {
			getUsageThrottlingFiveHourEnabled: () => false,
			getUsageThrottlingWeeklyEnabled: () => false,
			getSystemPromptCacheTtl1h: () => false,
			getStorePayloads: () => false,
		} as never,
		provider: new OpenAICompatibleProvider(),
		refreshInFlight: new Map(),
		asyncWriter: { enqueue: mock(() => {}) } as never,
		usageWorker: { postMessage: mock(() => {}) } as never,
	};
}

describe("handleProxy native openai-compatible passthrough", () => {
	let fetchMock: ReturnType<typeof mock>;

	beforeEach(() => {
		fetchMock = mock(
			async () =>
				new Response(JSON.stringify({ id: "resp_1", object: "response" }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				}),
		);
		globalThis.fetch = fetchMock as unknown as typeof fetch;
	});

	afterEach(() => {
		fetchMock.mockRestore?.();
	});

	it("accepts OpenAI Responses bodies without Anthropic messages validation", async () => {
		const headers = new Headers({
			"Content-Type": "application/json",
			[NATIVE_PASSTHROUGH_HEADER]: "true",
			"x-better-ccflare-include-providers": "openai-compatible",
		});
		const req = new Request("https://proxy.local/v1/openai/responses", {
			method: "POST",
			headers,
			body: JSON.stringify({
				model: "gpt-4o",
				input: [
					{ role: "user", content: [{ type: "input_text", text: "Hi" }] },
				],
				stream: false,
			}),
		});

		const response = await handleProxy(
			req,
			new URL("https://proxy.local/responses"),
			makeContext([makeOpenAIAccount()]),
			undefined,
			undefined,
			{
				clientPath: "/v1/openai/responses",
				upstreamPath: "/responses",
				nativePassthrough: true,
			},
		);

		expect(response.status).toBe(200);
		expect(fetchMock.mock.calls.length).toBeGreaterThan(0);
	});
});
