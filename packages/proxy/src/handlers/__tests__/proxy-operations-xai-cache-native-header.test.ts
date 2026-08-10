import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	mock,
	spyOn,
} from "bun:test";
import { CodexProvider, XaiProvider } from "@better-ccflare/providers";
import type { Account, RequestMeta } from "@better-ccflare/types";
import * as usageCollectorModule from "../../usage-collector";
import { setXaiConvId } from "../account-selector";
import { proxyWithAccount } from "../proxy-operations";
import type { ProxyContext } from "../proxy-types";

// Header-attachment integration test for the xAI cache-native conversation
// identity minimal slice (issue #319). Modeled on
// proxy-operations-count-tokens.test.ts: mock globalThis.fetch to capture
// the outgoing Request and assert on its headers, rather than unit-testing
// applyXaiConvIdHeader in isolation (already covered in
// packages/providers/src/providers/xai/cache-native.test.ts) — this test's
// job is to prove the seam is actually wired up in proxyWithAccount.

const XAI_CONV_ID_HEADER = "x-grok-conv-id";

function makeXaiAccount(overrides: Partial<Account> = {}): Account {
	return {
		id: "xai-1",
		name: "xai-test",
		provider: "xai",
		api_key: null,
		refresh_token: "refresh-token",
		access_token: "access-token",
		expires_at: Date.now() + 60 * 60 * 1000,
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

function makeCodexAccount(overrides: Partial<Account> = {}): Account {
	return {
		id: "codex-1",
		name: "codex-test",
		provider: "codex",
		api_key: "",
		refresh_token: "refresh-token",
		access_token: "access-token",
		expires_at: Date.now() + 60 * 60 * 1000,
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

function makeRequestMeta(path = "/v1/messages"): RequestMeta {
	return {
		id: "req-xai-header",
		method: "POST",
		path,
		timestamp: Date.now(),
		headers: new Headers(),
	};
}

function makeProxyContext(provider: XaiProvider | CodexProvider): ProxyContext {
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
		provider: provider as never,
		refreshInFlight: new Map(),
		asyncWriter: { enqueue: mock(() => {}) } as never,
		config: { getStorePayloads: () => true } as never,
	};
}

function makeMessagesRequest(body: ArrayBuffer) {
	return new Request("https://proxy.local/v1/messages", {
		method: "POST",
		body,
		headers: { "Content-Type": "application/json" },
	});
}

describe("proxyWithAccount — xAI cache-native conv-id header attachment", () => {
	let originalFetch: typeof globalThis.fetch;
	let fetchedRequest: Request | null;
	let fetchMock: ReturnType<typeof mock>;
	let collectorSpy: ReturnType<typeof spyOn>;

	beforeEach(() => {
		originalFetch = globalThis.fetch;
		fetchedRequest = null;
		fetchMock = mock(async (input: RequestInfo | URL) => {
			fetchedRequest = input instanceof Request ? input : new Request(input);
			return new Response(JSON.stringify({ ok: true }), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		});
		globalThis.fetch = fetchMock as unknown as typeof fetch;

		const collector = {
			handleStart: mock(() => {}),
			handleChunk: mock(() => {}),
			handleEnd: mock(() => Promise.resolve()),
		};
		collectorSpy = spyOn(
			usageCollectorModule,
			"getUsageCollector",
		).mockReturnValue(
			collector as unknown as usageCollectorModule.UsageCollector,
		);
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
		collectorSpy.mockRestore();
	});

	async function runXaiRequest(
		accountOverrides: Partial<Account> = {},
		convId: string | null = "ccflare-xai-test-conv",
		requestHeaders?: HeadersInit,
	) {
		const bodyBuffer = new TextEncoder().encode(
			JSON.stringify({
				model: "grok-4",
				messages: [{ role: "user", content: "hello" }],
				max_tokens: 16,
			}),
		).buffer;
		const requestMeta = makeRequestMeta();
		if (convId) {
			setXaiConvId(requestMeta, convId);
		}
		const ctx = makeProxyContext(new XaiProvider());
		const incomingRequest = requestHeaders
			? new Request("https://proxy.local/v1/messages", {
					method: "POST",
					body: bodyBuffer,
					headers: {
						"Content-Type": "application/json",
						...(requestHeaders as Record<string, string>),
					},
				})
			: makeMessagesRequest(bodyBuffer);
		const result = await proxyWithAccount(
			incomingRequest,
			new URL("https://proxy.local/v1/messages"),
			makeXaiAccount(accountOverrides),
			requestMeta,
			bodyBuffer,
			() => undefined,
			0,
			ctx,
		);
		await result?.text();
		return result;
	}

	it("attaches x-grok-conv-id for an official-endpoint xai request with a conv id set", async () => {
		await runXaiRequest();

		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(fetchedRequest?.url).toBe("https://api.x.ai/v1/chat/completions");
		expect(fetchedRequest?.headers.get(XAI_CONV_ID_HEADER)).toBe(
			"ccflare-xai-test-conv",
		);
	});

	it("does not attach the header when no conv id is set on the RequestMeta (feature disabled/undeliverable)", async () => {
		await runXaiRequest({}, null);

		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(fetchedRequest?.headers.get(XAI_CONV_ID_HEADER)).toBeNull();
	});

	it("does not attach the header for a custom/proxy xai endpoint even with a conv id set", async () => {
		await runXaiRequest({
			custom_endpoint: "https://my-xai-proxy.example.com/v1",
		});

		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(fetchedRequest?.headers.get(XAI_CONV_ID_HEADER)).toBeNull();
	});

	it("does not attach the header for a non-xai provider even with a conv id set", async () => {
		const bodyBuffer = new TextEncoder().encode(
			JSON.stringify({
				model: "claude-sonnet-4-5",
				messages: [{ role: "user", content: "hello" }],
				max_tokens: 16,
			}),
		).buffer;
		const requestMeta = makeRequestMeta();
		setXaiConvId(requestMeta, "ccflare-xai-test-conv");
		const ctx = makeProxyContext(new CodexProvider());
		const result = await proxyWithAccount(
			makeMessagesRequest(bodyBuffer),
			new URL("https://proxy.local/v1/messages"),
			makeCodexAccount(),
			requestMeta,
			bodyBuffer,
			() => undefined,
			0,
			ctx,
		);
		await result?.text();

		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(fetchedRequest?.headers.get(XAI_CONV_ID_HEADER)).toBeNull();
	});

	// Regression coverage: applyXaiConvIdHeader strips any pre-existing header
	// value unconditionally, before its own no-op guards — proving that a
	// client-supplied x-grok-conv-id copied in by provider.prepareHeaders()
	// never reaches upstream, even on a request that would otherwise no-op.
	it("strips a client-supplied x-grok-conv-id header instead of forwarding it, even when no conv id is set", async () => {
		await runXaiRequest({}, null, {
			[XAI_CONV_ID_HEADER]: "client-supplied-conv-id",
		});

		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(fetchedRequest?.headers.get(XAI_CONV_ID_HEADER)).toBeNull();
	});

	it("strips a client-supplied x-grok-conv-id header for a custom/proxy xai endpoint", async () => {
		await runXaiRequest(
			{ custom_endpoint: "https://my-xai-proxy.example.com/v1" },
			"ccflare-xai-test-conv",
			{ [XAI_CONV_ID_HEADER]: "client-supplied-conv-id" },
		);

		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(fetchedRequest?.headers.get(XAI_CONV_ID_HEADER)).toBeNull();
	});
});
