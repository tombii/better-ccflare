import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { CodexProvider } from "@better-ccflare/providers";
import type { Account } from "@better-ccflare/types";
import { NATIVE_PASSTHROUGH_HEADER } from "../../routing/native-proxy-dispatch";
import type { ProxyContext } from "../handlers/proxy-types";
import { proxyWithAccount } from "../proxy-operations";

function makeCodexAccount(overrides: Partial<Account> = {}): Account {
	return {
		id: "codex-1",
		name: "codex-account",
		provider: "codex",
		api_key: null,
		refresh_token: "refresh-token",
		access_token: "access-token",
		expires_at: Date.now() + 2 * 60 * 60 * 1000,
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

function makeProxyContext(): ProxyContext {
	const provider = new CodexProvider();
	return {
		strategy: { select: (accounts: Account[]) => accounts } as never,
		dbOps: {
			markAccountRateLimited: mock(() => Promise.resolve(1)),
			saveRequest: mock(() => Promise.resolve()),
			updateAccountUsage: mock(() => Promise.resolve()),
			getAdapter: mock(() => ({
				run: mock(() => Promise.resolve()),
				get: mock(() => Promise.resolve(null)),
			})),
		} as never,
		runtime: { port: 8080, clientId: "test" } as never,
		config: { getStorePayloads: () => false } as never,
		provider,
		refreshInFlight: new Map(),
		asyncWriter: { enqueue: mock(() => {}) } as never,
		usageWorker: { postMessage: mock(() => {}) } as never,
	};
}

describe("native codex passthrough via proxyWithAccount", () => {
	let fetchMock: ReturnType<typeof mock>;
	let capturedUrl: string | null = null;
	let capturedBody: string | null = null;
	let capturedAuth: string | null = null;

	beforeEach(() => {
		capturedUrl = null;
		capturedBody = null;
		capturedAuth = null;
		fetchMock = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
			const request =
				input instanceof Request ? input : new Request(input, init);
			capturedUrl = request.url;
			capturedBody = await request.text();
			capturedAuth = request.headers.get("authorization");
			return new Response(
				JSON.stringify({
					id: "resp_native",
					object: "response",
					output: [],
				}),
				{
					status: 200,
					headers: { "Content-Type": "application/json" },
				},
			);
		});
		globalThis.fetch = fetchMock as unknown as typeof fetch;
	});

	afterEach(() => {
		fetchMock.mockRestore?.();
	});

	it("forwards /responses upstream with query string and unchanged OpenAI body", async () => {
		const nativeBody = {
			model: "gpt-5.3-codex",
			input: [{ role: "user", content: [{ type: "input_text", text: "Hi" }] }],
			stream: false,
			instructions: "You are helpful",
		};
		const req = new Request(
			"https://proxy.local/v1/codex/responses?stream=false",
			{
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					[NATIVE_PASSTHROUGH_HEADER]: "true",
					Authorization: "Bearer client-should-not-leak",
					"anthropic-version": "2023-06-01",
				},
				body: JSON.stringify(nativeBody),
			},
		);

		const response = await proxyWithAccount(
			req,
			new URL("https://proxy.local/responses?stream=false"),
			makeCodexAccount(),
			{
				id: "req-native",
				method: "POST",
				path: "/v1/codex/responses",
				timestamp: Date.now(),
				headers: req.headers,
			},
			new TextEncoder().encode(JSON.stringify(nativeBody)).buffer,
			() => undefined,
			0,
			makeProxyContext(),
		);

		expect(response).not.toBeNull();
		expect(capturedUrl).toBe(
			"https://chatgpt.com/backend-api/codex/responses?stream=false",
		);
		expect(JSON.parse(capturedBody ?? "{}")).toEqual(nativeBody);
		expect(capturedAuth).toBe("Bearer access-token");
		expect(capturedBody).not.toContain("messages");

		const body = await response?.json();
		expect(body.object).toBe("response");
		expect(body.id).toBe("resp_native");
	});
});
