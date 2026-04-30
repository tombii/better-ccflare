import { afterEach, describe, expect, it, mock } from "bun:test";
import { usageCache } from "@better-ccflare/providers";
import type { Account } from "@better-ccflare/types";
import { handleProxy } from "../proxy";
import type { ProxyContext } from "../handlers";

function makeAccount(overrides: Partial<Account> = {}): Account {
	return {
		id: "acc-1",
		name: "codex-primary",
		provider: "codex",
		api_key: null,
		refresh_token: "refresh-token",
		access_token: "access-token",
		expires_at: Date.now() + 60_000,
		request_count: 0,
		total_requests: 0,
		last_used: null,
		created_at: Date.now(),
		rate_limited_until: null,
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
		custom_endpoint: null,
		model_mappings: null,
		cross_region_mode: null,
		model_fallbacks: null,
		billing_type: null,
		pause_reason: null,
		refresh_token_issued_at: null,
		...overrides,
	};
}

function makeContext(account: Account): ProxyContext {
	return {
		strategy: {
			select: (accounts: Account[]) => accounts,
		} as never,
		dbOps: {
			getAllAccounts: mock(async () => [account]),
		} as never,
		runtime: { port: 8080, clientId: "test" } as never,
		config: {
			getUsageThrottlingEnabled: () => true,
			getUsageThrottlingFiveHourEnabled: () => true,
			getUsageThrottlingWeeklyEnabled: () => true,
			getSystemPromptCacheTtl1h: () => false,
		} as never,
		provider: {
			name: "codex",
			canHandle: () => true,
		} as never,
		refreshInFlight: new Map(),
		asyncWriter: { enqueue: mock(() => {}) } as never,
		usageWorker: { postMessage: mock(() => {}) } as never,
	};
}

afterEach(() => {
	usageCache.delete("acc-1");
});

describe("handleProxy usage throttling", () => {
	it("returns 529 with Retry-After when all selected accounts are throttled", async () => {
		const account = makeAccount();
		const now = Date.UTC(2026, 3, 28, 12, 0, 0);
		const resetAt = new Date(now + 2 * 60 * 60 * 1000).toISOString();
		usageCache.set(account.id, {
			five_hour: { utilization: 80, resets_at: resetAt },
			seven_day: { utilization: 10, resets_at: null },
		});

		const realDateNow = Date.now;
		Date.now = () => now;
		try {
			const request = new Request("https://proxy.local/v1/messages", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					model: "claude-sonnet-4-5",
					messages: [{ role: "user", content: "hello" }],
					max_tokens: 16,
				}),
			});

			const response = await handleProxy(
				request,
				new URL(request.url),
				makeContext(account),
			);

			expect(response.status).toBe(529);
			expect(response.headers.get("Retry-After")).toBe("60");
		} finally {
			Date.now = realDateNow;
		}
	});
});
