import { afterEach, describe, expect, it, mock } from "bun:test";
import { usageCache } from "@better-ccflare/providers";
import type { Account } from "@better-ccflare/types";
import type { ProxyContext } from "../handlers";
import { handleProxy } from "../proxy";

function makeAccount(overrides: Partial<Account> = {}): Account {
	return {
		id: "acc-1",
		name: "claude-primary",
		provider: "anthropic",
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
		...overrides,
	};
}

function makeContext(
	account: Account,
	opts: { capacityRoutingMode?: "off" | "exhausted" } = {},
): ProxyContext {
	return {
		strategy: {
			select: (accounts: Account[]) => accounts,
		} as never,
		dbOps: {
			getAllAccounts: mock(async () => [account]),
			getActiveComboForFamily: mock(async () => null),
		} as never,
		runtime: { port: 8080, clientId: "test" } as never,
		config: {
			getUsageThrottlingFiveHourEnabled: () => false,
			getUsageThrottlingWeeklyEnabled: () => false,
			getSystemPromptCacheTtl1h: () => false,
			getAgentFrontmatterModelFallback: () => false,
			getModelScopedCapacityRouting: () =>
				opts.capacityRoutingMode ?? "exhausted",
		} as never,
		provider: {
			name: "anthropic",
			canHandle: () => true,
		} as never,
		refreshInFlight: new Map(),
		asyncWriter: { enqueue: mock(() => {}) } as never,
	};
}

afterEach(() => {
	usageCache.delete("acc-1");
});

describe("handleProxy model-scoped capacity routing", () => {
	it("returns a structured 529 model_family_exhausted response when every account is capacity-exhausted for the request's family", async () => {
		const account = makeAccount();
		const now = Date.UTC(2026, 3, 28, 12, 0, 0);
		const resetAt = new Date(now + 3 * 24 * 60 * 60 * 1000).toISOString();
		usageCache.set(account.id, {
			limits: [
				{
					kind: "weekly_scoped",
					percent: 100,
					resets_at: resetAt,
					scope: { model: { id: null, display_name: "Sonnet" }, surface: null },
				},
			],
		} as never);

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
			const body = (await response.json()) as {
				type: string;
				error: { type: string; family: string; resetAt: number | null };
			};
			expect(body.type).toBe("error");
			expect(body.error.type).toBe("model_family_exhausted");
			expect(body.error.family).toBe("sonnet");
			expect(body.error.resetAt).toBe(new Date(resetAt).getTime());
		} finally {
			Date.now = realDateNow;
		}
	});

	// The "capacity routing off" / "account not excluded" behavior is covered
	// at the account-selector unit level (account-selector-model-capacity.test.ts
	// — "switch off" describe block), which doesn't require driving a request
	// all the way through proxyWithAccount/forwardToClient (and its
	// UsageCollector dependency, uninitialized in this narrower test file).
});
