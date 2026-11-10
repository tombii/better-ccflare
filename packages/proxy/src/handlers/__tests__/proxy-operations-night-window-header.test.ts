import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	mock,
	spyOn,
} from "bun:test";
import * as coreModule from "@better-ccflare/core";
import {
	CodexProvider,
	getTierAdapter,
	SailresearchProvider,
} from "@better-ccflare/providers";
import type { Account, RequestMeta } from "@better-ccflare/types";
import * as usageCollectorModule from "../../usage-collector";
import { proxyWithAccount } from "../proxy-operations";
import type { ProxyContext } from "../proxy-types";

// Header-attachment integration test for the night-window completion tier.
// Modeled on proxy-operations-xai-cache-native-header.test.ts: mock
// globalThis.fetch to capture the outgoing Request and assert on its headers,
// proving the seam is wired up in proxyWithAccount (the pure time logic and
// applyNightWindowHeader itself are covered in core/providers tests).

const SAIL_TIER_HEADER = "x-sail-completion-window";

// 2026-11-09T23:30:00Z — inside "22:00-08:00" UTC.
const INSIDE_WINDOW_MS = Date.UTC(2026, 10, 9, 23, 30);
// 2026-11-09T12:00:00Z — outside "22:00-08:00" UTC.
const OUTSIDE_WINDOW_MS = Date.UTC(2026, 10, 9, 12, 0);

function makeAccount(provider: string, overrides: Partial<Account> = {}) {
	return {
		id: `${provider}-1`,
		name: `${provider}-test`,
		provider,
		api_key: "test-key",
		refresh_token: null,
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
		night_window_enabled: false,
		...overrides,
	} as Account;
}

function makeRequestMeta(): RequestMeta {
	return {
		id: "req-night-window-header",
		method: "POST",
		path: "/v1/messages",
		timestamp: Date.now(),
		headers: new Headers(),
	};
}

function makeProxyContext(
	provider: SailresearchProvider | CodexProvider,
	nightWindow: string,
	nightTz = "UTC",
): ProxyContext {
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
		config: {
			getStorePayloads: () => true,
			getNightWindow: () => nightWindow,
			getNightTz: () => nightTz,
		} as never,
	};
}

describe("proxyWithAccount — night-window tier header attachment", () => {
	let originalFetch: typeof globalThis.fetch;
	let fetchedRequest: Request | null;
	let fetchMock: ReturnType<typeof mock>;
	let collectorSpy: ReturnType<typeof spyOn>;
	let nowSpy: ReturnType<typeof spyOn>;
	let logErrorSpy: ReturnType<typeof spyOn> | undefined;

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
		logErrorSpy?.mockRestore();
		nowSpy?.mockRestore();
	});

	async function runRequest(opts: {
		provider: "sailresearch" | "codex";
		accountOverrides?: Partial<Account>;
		nightWindow: string;
		nowMs: number;
		clientHeaders?: Record<string, string>;
	}) {
		nowSpy = spyOn(Date, "now").mockReturnValue(opts.nowMs);
		logErrorSpy?.mockRestore();
		logErrorSpy = spyOn(coreModule, "logError").mockImplementation(() => {});
		const bodyBuffer = new TextEncoder().encode(
			JSON.stringify({
				model: "deepseek-ai/DeepSeek-V4.1-Flash-1017",
				messages: [{ role: "user", content: "hello" }],
				max_tokens: 16,
			}),
		).buffer;
		const provider =
			opts.provider === "sailresearch"
				? new SailresearchProvider()
				: new CodexProvider();
		const ctx = makeProxyContext(provider, opts.nightWindow);
		const request = new Request("https://proxy.local/v1/messages", {
			method: "POST",
			body: bodyBuffer,
			headers: {
				"Content-Type": "application/json",
				...opts.clientHeaders,
			},
		});
		const result = await proxyWithAccount(
			request,
			new URL("https://proxy.local/v1/messages"),
			makeAccount(opts.provider, opts.accountOverrides),
			makeRequestMeta(),
			bodyBuffer,
			() => undefined,
			0,
			ctx,
		);
		await result?.text();
	}

	it("sets x-sail-completion-window: balanced inside the window for an enabled sailresearch account", async () => {
		await runRequest({
			provider: "sailresearch",
			accountOverrides: { night_window_enabled: true },
			nightWindow: "22:00-08:00",
			nowMs: INSIDE_WINDOW_MS,
		});

		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(fetchedRequest?.headers.get(SAIL_TIER_HEADER)).toBe("balanced");
	});

	it("does not set the header outside the window", async () => {
		await runRequest({
			provider: "sailresearch",
			accountOverrides: { night_window_enabled: true },
			nightWindow: "22:00-08:00",
			nowMs: OUTSIDE_WINDOW_MS,
		});

		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(fetchedRequest?.headers.get(SAIL_TIER_HEADER)).toBeNull();
	});

	it("does not set the header when the account has the flag off, even inside the window", async () => {
		await runRequest({
			provider: "sailresearch",
			accountOverrides: { night_window_enabled: false },
			nightWindow: "22:00-08:00",
			nowMs: INSIDE_WINDOW_MS,
		});

		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(fetchedRequest?.headers.get(SAIL_TIER_HEADER)).toBeNull();
	});

	it("does not set the header when no window is configured", async () => {
		await runRequest({
			provider: "sailresearch",
			accountOverrides: { night_window_enabled: true },
			nightWindow: "",
			nowMs: INSIDE_WINDOW_MS,
		});

		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(fetchedRequest?.headers.get(SAIL_TIER_HEADER)).toBeNull();
	});

	it("never sets the header for a provider without a tier adapter, even with the flag on inside the window", async () => {
		await runRequest({
			provider: "codex",
			accountOverrides: { night_window_enabled: true },
			nightWindow: "22:00-08:00",
			nowMs: INSIDE_WINDOW_MS,
		});

		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(fetchedRequest?.headers.get(SAIL_TIER_HEADER)).toBeNull();
	});

	it("strips a client-supplied x-sail-completion-window header instead of forwarding it", async () => {
		await runRequest({
			provider: "sailresearch",
			accountOverrides: { night_window_enabled: true },
			nightWindow: "22:00-08:00",
			nowMs: OUTSIDE_WINDOW_MS,
			clientHeaders: { [SAIL_TIER_HEADER]: "asap" },
		});

		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(fetchedRequest?.headers.get(SAIL_TIER_HEADER)).toBeNull();
	});

	it("overrides a client-supplied tier with the in-window tier inside the window", async () => {
		await runRequest({
			provider: "sailresearch",
			accountOverrides: { night_window_enabled: true },
			nightWindow: "22:00-08:00",
			nowMs: INSIDE_WINDOW_MS,
			clientHeaders: { [SAIL_TIER_HEADER]: "asap" },
		});

		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(fetchedRequest?.headers.get(SAIL_TIER_HEADER)).toBe("balanced");
	});

	// Sanity check on the test setup: the adapter must be registered by the
	// providers package's side-effect import; otherwise every positive case
	// above would trivially pass.
	it("has the sailresearch tier adapter registered", () => {
		expect(getTierAdapter("sailresearch")?.header).toBe(SAIL_TIER_HEADER);
	});
});
