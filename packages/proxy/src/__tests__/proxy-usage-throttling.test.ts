import { afterEach, describe, expect, it, mock } from "bun:test";
import { TIME_CONSTANTS } from "@better-ccflare/core";
import { usageCache } from "@better-ccflare/providers";
import type { Account } from "@better-ccflare/types";
import type { ProxyContext } from "../handlers";
import { processProxyResponse } from "../handlers/response-processor";
import { handleProxy } from "../proxy";

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
		rate_limited_reason: null,
		rate_limited_at: null,
		consecutive_rate_limits: 0,
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
			getActiveComboForFamily: mock(async () => null),
		} as never,
		runtime: { port: 8080, clientId: "test" } as never,
		config: {
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

// Spy context builder for processProxyResponse-level tests. Runs async-writer
// jobs synchronously so DB-driven mutations are observable from assertions.
function makeProcessCtx(opts: { rateLimited: boolean; resetTime?: number }) {
	const calls = {
		markRateLimited: [] as Array<{
			accountId: string;
			until: number;
			reason: string;
		}>,
		resetConsecutive: [] as string[],
		// Captures every SQL statement passed to the adapter so tests can assert
		// that the rate_limited_until=NULL UPDATE was (or was not) issued.
		adapterRun: [] as Array<{
			sql: string;
			params?: ReadonlyArray<unknown>;
		}>,
	};
	let persistedCounter = 0;

	const ctx = {
		provider: {
			name: "codex",
			isStreamingResponse: () => false,
			parseRateLimit: () => ({
				isRateLimited: opts.rateLimited,
				resetTime: opts.resetTime,
				statusHeader: opts.rateLimited ? "rate_limited" : undefined,
				remaining: undefined,
			}),
			parseUsage: undefined,
			extractUsageInfo: undefined,
		},
		dbOps: {
			markAccountRateLimited: async (
				accountId: string,
				until: number,
				reason: string,
			) => {
				calls.markRateLimited.push({ accountId, until, reason });
				persistedCounter += 1;
				return persistedCounter;
			},
			resetConsecutiveRateLimits: async (accountId: string) => {
				calls.resetConsecutive.push(accountId);
				persistedCounter = 0;
			},
			updateAccountUsage: () => {},
			updateAccountRateLimitMeta: () => {},
			getAdapter: () => ({
				get: async () => ({ rate_limited_until: null }),
				run: async (sql: string, params?: ReadonlyArray<unknown>) => {
					calls.adapterRun.push({ sql, params });
				},
			}),
			updateRequestUsage: async () => {},
		},
		asyncWriter: {
			// Execute synchronously and await so post-job assertions can see the
			// reconciled in-memory state.
			enqueue: async (job: () => void | Promise<void>) => {
				await job();
			},
		},
	} as unknown as ProxyContext;

	return { ctx, calls };
}

describe("processProxyResponse — adaptive cooldown backoff", () => {
	it("ramps the cooldown on two consecutive 429s in a streak", async () => {
		const account = makeAccount();
		const { ctx } = makeProcessCtx({ rateLimited: true });

		// First 429 — BASE backoff (~30s), counter goes to 1.
		const before1 = Date.now();
		await processProxyResponse(
			new Response('{"error":"rate_limit"}', {
				status: 429,
				headers: { "content-type": "application/json" },
			}),
			account,
			ctx,
		);
		const cooldown1 = (account.rate_limited_until ?? 0) - before1;
		expect(account.consecutive_rate_limits).toBe(1);
		// First-tier cooldown ≈ BASE (30s). Tolerate ±1s drift.
		const BASE = TIME_CONSTANTS.RATE_LIMIT_BACKOFF_BASE_MS;
		expect(cooldown1).toBeGreaterThanOrEqual(BASE - 1000);
		expect(cooldown1).toBeLessThanOrEqual(BASE + 1000);

		// Second 429 — backoff doubles to ~2×BASE (60s), counter goes to 2.
		const before2 = Date.now();
		await processProxyResponse(
			new Response('{"error":"rate_limit"}', {
				status: 429,
				headers: { "content-type": "application/json" },
			}),
			account,
			ctx,
		);
		const cooldown2 = (account.rate_limited_until ?? 0) - before2;
		expect(account.consecutive_rate_limits).toBe(2);
		// Second-tier cooldown ≈ 2 × BASE.
		expect(cooldown2).toBeGreaterThanOrEqual(2 * BASE - 1000);
		expect(cooldown2).toBeLessThanOrEqual(2 * BASE + 1000);
	});

	it("caps the cooldown at the upstream reset when upstream is sooner", async () => {
		const account = makeAccount();
		const now = Date.now();
		// Upstream says reset is 10s from now; backoff would be 30s. Upstream wins.
		const upstreamReset = now + 10_000;
		const { ctx } = makeProcessCtx({
			rateLimited: true,
			resetTime: upstreamReset,
		});

		await processProxyResponse(
			new Response('{"error":"rate_limit"}', {
				status: 429,
				headers: { "content-type": "application/json" },
			}),
			account,
			ctx,
		);

		// min(upstream_reset, now + backoff) — upstream is sooner so it wins.
		expect(account.rate_limited_until).not.toBeNull();
		expect(account.rate_limited_until ?? 0).toBeLessThanOrEqual(upstreamReset);
		// And greater than now (sanity).
		expect(account.rate_limited_until ?? 0).toBeGreaterThan(now);
	});
});

describe("processProxyResponse — stability reset on 2xx", () => {
	it("resets the counter when rate_limited_at is older than the stability window", async () => {
		const stale =
			Date.now() - TIME_CONSTANTS.RATE_LIMIT_RESET_STABILITY_MS - 1_000;
		const account = makeAccount({
			rate_limited_until: Date.now() + 60_000, // still has a stale cooldown
			rate_limited_at: stale,
			consecutive_rate_limits: 5,
		});
		const { ctx, calls } = makeProcessCtx({ rateLimited: false });

		await processProxyResponse(
			new Response('{"id":"msg_ok"}', {
				status: 200,
				headers: { "content-type": "application/json" },
			}),
			account,
			ctx,
		);

		// In-memory state reset.
		expect(account.consecutive_rate_limits).toBe(0);
		expect(account.rate_limited_at).toBeNull();
		expect(account.rate_limited_until).toBeNull();
		// DB reset was enqueued exactly once.
		expect(calls.resetConsecutive).toEqual([account.id]);
	});

	it("preserves the counter when rate_limited_at is within the stability window", async () => {
		// 30 seconds ago — well within the 5-min stability window.
		const recent = Date.now() - 30_000;
		const account = makeAccount({
			rate_limited_until: Date.now() + 60_000,
			rate_limited_at: recent,
			consecutive_rate_limits: 5,
		});
		const { ctx, calls } = makeProcessCtx({ rateLimited: false });

		await processProxyResponse(
			new Response('{"id":"msg_ok"}', {
				status: 200,
				headers: { "content-type": "application/json" },
			}),
			account,
			ctx,
		);

		// Counter and rate_limited_at unchanged.
		expect(account.consecutive_rate_limits).toBe(5);
		expect(account.rate_limited_at).toBe(recent);
		// rate_limited_until still cleared (existing behavior).
		expect(account.rate_limited_until).toBeNull();
		// DB reset NOT enqueued.
		expect(calls.resetConsecutive).toEqual([]);
	});

	// Issue #2 regression: stability reset must fire even when rate_limited_until
	// has already been cleared by the periodic clearExpiredRateLimits job. That
	// job nulls rate_limited_until without touching rate_limited_at; if the
	// stability reset were gated on rate_limited_until being non-null (the old
	// behavior), the counter would stay elevated forever for API-key accounts
	// that have no token-refresh codepath to reset it, and the next 429 would
	// land at an inflated backoff tier instead of restarting at BASE.
	it("resets the counter when rate_limited_until is already null but rate_limited_at is stale", async () => {
		const stale = Date.now() - 6 * 60 * 1000; // 6 min ago (> 5 min stability window)
		const account = makeAccount({
			rate_limited_until: null, // already cleared by clearExpiredRateLimits
			rate_limited_at: stale,
			consecutive_rate_limits: 3,
		});
		const { ctx, calls } = makeProcessCtx({ rateLimited: false });

		await processProxyResponse(
			new Response('{"id":"msg_ok"}', {
				status: 200,
				headers: { "content-type": "application/json" },
			}),
			account,
			ctx,
		);

		// In-memory counter reset.
		expect(account.consecutive_rate_limits).toBe(0);
		expect(account.rate_limited_at).toBeNull();
		// resetConsecutiveRateLimits enqueued exactly once.
		expect(calls.resetConsecutive).toEqual([account.id]);
		// The rate_limited_until=NULL UPDATE was NOT issued — there's nothing to
		// clear because the periodic job already nulled it. This locks in that
		// the two side-effects are now independent: the stability reset no
		// longer requires rate_limited_until to still be set.
		const updates = calls.adapterRun.filter((c) =>
			c.sql.includes("rate_limited_until = NULL"),
		);
		expect(updates).toEqual([]);
	});
});
