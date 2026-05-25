/**
 * Mid-stream overloaded_error test.
 *
 * Tests that when an SSE stream contains an overloaded_error frame mid-stream,
 * the account gets marked rate-limited with reason "upstream_529_overloaded_with_reset".
 *
 * Note: Mid-stream detection cannot rescue the current response — the stream
 * headers were already sent to the client. It only prevents future requests
 * from being routed to the overloaded account until the cooldown expires.
 */
import { describe, expect, it } from "bun:test";
import type { Account } from "@better-ccflare/types";
import type { ProxyContext } from "../proxy-types";
import { applyRateLimitCooldown } from "../rate-limit-cooldown";
import { createSseRateLimitSniffer } from "../sse-rate-limit-sniffer";

function makeAccount(overrides: Partial<Account> = {}): Account {
	return {
		id: "acct-mid-1",
		name: "mid-stream-test",
		provider: "anthropic",
		api_key: null,
		refresh_token: "rt",
		access_token: "at",
		expires_at: Date.now() + 3_600_000,
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

function makeCtxWithReason() {
	const calls = {
		markRateLimited: [] as Array<{
			accountId: string;
			resetTime: number;
			reason: string;
		}>,
		enqueueCount: 0,
	};

	const ctx = {
		provider: {
			name: "anthropic",
			isStreamingResponse: () => true,
			parseRateLimit: () => ({
				isRateLimited: true,
				resetTime: undefined,
				statusHeader: undefined,
				remaining: undefined,
			}),
			parseUsage: undefined,
			extractUsageInfo: undefined,
		},
		dbOps: {
			markAccountRateLimited: (
				accountId: string,
				resetTime: number,
				reason: string,
			) => {
				calls.markRateLimited.push({ accountId, resetTime, reason });
				return Promise.resolve(1);
			},
			updateAccountUsage: () => {},
			updateAccountRateLimitMeta: () => {},
			getAdapter: () => ({
				get: async () => ({ rate_limited_until: null }),
				run: async () => {},
			}),
			updateRequestUsage: async () => {},
		},
		asyncWriter: {
			enqueue: (job: () => void | Promise<void>) => {
				calls.enqueueCount++;
				void job();
				return Promise.resolve();
			},
		},
	} as unknown as ProxyContext;

	return { ctx, calls };
}

describe("applyRateLimitCooldown — mid-stream 529 overload", () => {
	it("marks account with reason='upstream_529_overloaded_with_reset' when passed reason override and resetTime", async () => {
		// This simulates what response-handler.ts does when rateLimitSniffer fires
		// for an overloaded_error frame mid-stream (firedReason === "overloaded_error").
		// The handler passes reason="upstream_529_overloaded_with_reset" so the audit trail
		// reflects the 529 overload rather than a 429 rate-limit.
		const account = makeAccount();
		const resetTime = Date.now() + 60_000;
		const { ctx, calls } = makeCtxWithReason();

		applyRateLimitCooldown(
			account,
			{ resetTime, reason: "upstream_529_overloaded_with_reset" },
			ctx,
		);

		// Wait for async enqueue to run
		await new Promise((r) => setTimeout(r, 10));

		expect(calls.markRateLimited).toHaveLength(1);
		expect(calls.markRateLimited[0]?.reason).toBe(
			"upstream_529_overloaded_with_reset",
		);
		// rate_limited_until is set to min(resetTime, now+backoff)
		expect(account.rate_limited_until).not.toBeNull();
	});

	it("marks account with reason='upstream_429_with_reset' when called without reason override and resetTime", async () => {
		// rate_limit_error -> auto-derived reason "upstream_429_with_reset"
		const account = makeAccount();
		const resetTime = Date.now() + 60_000;
		const { ctx, calls } = makeCtxWithReason();

		applyRateLimitCooldown(account, { resetTime }, ctx);

		// Wait for async enqueue to run
		await new Promise((r) => setTimeout(r, 10));

		expect(calls.markRateLimited).toHaveLength(1);
		expect(calls.markRateLimited[0]?.reason).toBe("upstream_429_with_reset");
	});

	it("marks account with reason='upstream_529_overloaded_no_reset' when no resetTime and reason override passed", async () => {
		// The no-reset path for 529: applyRateLimitCooldown uses backoff-only
		// cooldown (no upstream resetTime) and records the 529-specific reason.
		const account = makeAccount();
		const { ctx, calls } = makeCtxWithReason();

		applyRateLimitCooldown(
			account,
			{ reason: "upstream_529_overloaded_no_reset" },
			ctx,
		);

		// Wait for async enqueue to run
		await new Promise((r) => setTimeout(r, 10));

		// applyRateLimitCooldown always marks (backoff-only when no resetTime)
		expect(calls.markRateLimited).toHaveLength(1);
		expect(calls.markRateLimited[0]?.reason).toBe(
			"upstream_529_overloaded_no_reset",
		);
		expect(account.rate_limited_until).not.toBeNull();
	});
});

describe("production sniffer integration — overloaded_error mid-stream", () => {
	it("sniffer fires on mid-stream overloaded_error and maps to 529 reason", () => {
		const sniffer = createSseRateLimitSniffer({ provider: "anthropic" });
		const encode = (s: string) => new TextEncoder().encode(s);
		const frame = encode(
			'event: error\ndata: {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}\n\n',
		);
		expect(sniffer.feed(frame)).toBe(true);
		expect(sniffer.firedReason).toBe("overloaded_error");
		// The mapping used by response-handler.ts:
		const reason =
			sniffer.firedReason === "overloaded_error"
				? "upstream_529_overloaded_with_reset"
				: undefined;
		expect(reason).toBe("upstream_529_overloaded_with_reset");
	});

	it("sniffer with non-Anthropic provider does NOT fire on overloaded_error", () => {
		const sniffer = createSseRateLimitSniffer({
			provider: "openai-compatible",
		});
		const encode = (s: string) => new TextEncoder().encode(s);
		const frame = encode(
			'event: error\ndata: {"type":"error","error":{"type":"overloaded_error"}}\n\n',
		);
		expect(sniffer.feed(frame)).toBe(false);
	});
});
