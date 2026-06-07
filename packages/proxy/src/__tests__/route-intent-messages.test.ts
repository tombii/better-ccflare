import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	mock,
	spyOn,
} from "bun:test";
import { AnthropicProvider } from "@better-ccflare/providers";
import type { Account } from "@better-ccflare/types";
import type { ProxyContext } from "../handlers";
import { handleProxy } from "../proxy";
import * as usageCollectorModule from "../usage-collector";

function makeAnthropicAccount(overrides: Partial<Account> = {}): Account {
	return {
		id: "acc-anthropic",
		name: "anthropic-account",
		provider: "anthropic",
		api_key: null,
		refresh_token: "rt",
		access_token: "at",
		expires_at: Date.now() + 60_000,
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
	return makeAnthropicAccount({
		id: "acc-codex",
		name: "codex-account",
		provider: "codex",
		refresh_token: "codex-rt",
		...overrides,
	});
}

function makeContext(accounts: Account[]): ProxyContext {
	return {
		strategy: {
			select: (accs: Account[]) => {
				const now = Date.now();
				return accs.filter(
					(acc) =>
						!acc.paused &&
						(!acc.rate_limited_until || acc.rate_limited_until <= now),
				);
			},
		} as never,
		dbOps: {
			getAllAccounts: mock(async () => accounts),
			getActiveComboForFamily: mock(async () => null),
		} as never,
		runtime: { port: 8080, clientId: "test" } as never,
		config: {
			getUsageThrottlingFiveHourEnabled: () => false,
			getUsageThrottlingWeeklyEnabled: () => false,
			getSystemPromptCacheTtl1h: () => false,
			getStorePayloads: () => false,
		} as never,
		provider: new AnthropicProvider(),
		refreshInFlight: new Map(),
		asyncWriter: { enqueue: mock(() => {}) } as never,
	};
}

function makeMessagesRequest(headers?: Headers): Request {
	return new Request("https://proxy.local/v1/messages", {
		method: "POST",
		headers: headers ?? { "Content-Type": "application/json" },
		body: JSON.stringify({
			model: "claude-sonnet-4-5",
			messages: [{ role: "user", content: "hello" }],
			max_tokens: 16,
		}),
	});
}

let fetchMock: ReturnType<typeof mock>;

beforeEach(() => {
	fetchMock = mock(async () => new Response("unexpected", { status: 500 }));
	globalThis.fetch = fetchMock as unknown as typeof fetch;

	spyOn(usageCollectorModule, "getUsageCollector").mockReturnValue({
		handleStart: mock(() => {}),
		handleEnd: mock(() => Promise.resolve()),
		handleChunk: mock(() => {}),
	} as unknown as usageCollectorModule.UsageCollector);
});

afterEach(() => {
	fetchMock.mockRestore?.();
});

describe("route intent — /v1/messages excludes Codex by default", () => {
	it("returns 503 instead of selecting Codex when Anthropic pool is exhausted", async () => {
		const rateLimitedAnthropic = makeAnthropicAccount({
			rate_limited_until: Date.now() + 3_600_000,
		});
		const codexAccount = makeCodexAccount();

		const response = await handleProxy(
			makeMessagesRequest(),
			new URL("https://proxy.local/v1/messages"),
			makeContext([rateLimitedAnthropic, codexAccount]),
		);

		expect(response.status).toBe(503);
		expect(fetchMock.mock.calls.length).toBe(0);
	});

	it("selects Codex on /v1/messages only when opt-in header is present", async () => {
		const codexAccount = makeCodexAccount();
		fetchMock = mock(
			async () =>
				new Response(JSON.stringify({ id: "msg_1", type: "message" }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				}),
		);
		globalThis.fetch = fetchMock as unknown as typeof fetch;

		const response = await handleProxy(
			makeMessagesRequest(
				new Headers({
					"Content-Type": "application/json",
					"x-better-ccflare-allow-providers": "codex",
				}),
			),
			new URL("https://proxy.local/v1/messages"),
			makeContext([codexAccount]),
		);

		expect(response.status).toBe(200);
		expect(fetchMock.mock.calls.length).toBeGreaterThan(0);
	});
});
