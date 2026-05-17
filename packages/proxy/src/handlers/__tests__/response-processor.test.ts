import { describe, expect, it } from "bun:test";
import type { Account } from "@better-ccflare/types";
import type { ProxyContext } from "../proxy-types";
import { processProxyResponse } from "../response-processor";

// Minimal Account fixture used by every test in this file. Only the fields
// the response-processor actually reads matter — the rest exist to satisfy
// the type checker.
function makeAccount(overrides: Partial<Account> = {}): Account {
	return {
		id: "acct-1",
		name: "test-account",
		provider: "anthropic",
		api_key: null,
		refresh_token: "rt",
		access_token: "at",
		expires_at: Date.now() + 3600_000,
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

// Spy-style ProxyContext. We don't try to construct a full DatabaseOperations
// or Provider — we hand in just enough method surface for processProxyResponse
// to do its work and we record what it calls.
function makeCtx(opts: {
	isStream: boolean;
	rateLimited: boolean;
	resetTime?: number;
}) {
	const calls = {
		markRateLimited: [] as Array<{ accountId: string; resetTime: number }>,
		resetConsecutive: [] as string[],
		enqueueCount: 0,
	};
	let persistedCounter = 0;

	const ctx = {
		provider: {
			name: "anthropic",
			isStreamingResponse: () => opts.isStream,
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
				resetTime: number,
				_reason: string,
			) => {
				calls.markRateLimited.push({ accountId, resetTime });
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
				run: async () => {},
			}),
			updateRequestUsage: async () => {},
		},
		asyncWriter: {
			enqueue: (job: () => void | Promise<void>) => {
				calls.enqueueCount++;
				// Run the job immediately so any DB-side mutations are observable
				// from the test. The real AsyncDbWriter is interval-driven; for
				// the assertions we care about, sync execution is equivalent and
				// avoids needing to flush a queue.
				void job();
			},
		},
	} as unknown as ProxyContext;

	return { ctx, calls };
}

// Extended spy context that captures the reason argument passed to markAccountRateLimited.
function makeCtxWithReason(opts: {
	isStream: boolean;
	rateLimited: boolean;
	resetTime?: number;
}) {
	const calls = {
		markRateLimited: [] as Array<{
			accountId: string;
			resetTime: number;
			reason: string;
		}>,
		resetConsecutive: [] as string[],
		enqueueCount: 0,
	};
	let persistedCounter = 0;

	const ctx = {
		provider: {
			name: "anthropic",
			isStreamingResponse: () => opts.isStream,
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
				resetTime: number,
				reason: string,
			) => {
				calls.markRateLimited.push({ accountId, resetTime, reason });
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
				run: async () => {},
			}),
			updateRequestUsage: async () => {},
		},
		asyncWriter: {
			enqueue: (job: () => void | Promise<void>) => {
				calls.enqueueCount++;
				void job();
			},
		},
	} as unknown as ProxyContext;

	return { ctx, calls };
}

describe("processProxyResponse — rate limit audit trail (issue #178)", () => {
	it("passes reason='upstream_429_with_reset' when resetTime is present", async () => {
		const account = makeAccount();
		const resetTime = Date.now() + 30 * 60_000;
		const before = Date.now();
		const { ctx, calls } = makeCtxWithReason({
			isStream: false,
			rateLimited: true,
			resetTime,
		});
		const response = new Response('{"error":"rate_limit"}', {
			status: 429,
			headers: { "content-type": "application/json" },
		});

		await processProxyResponse(response, account, ctx);

		expect(calls.markRateLimited).toHaveLength(1);
		expect(calls.markRateLimited[0]?.accountId).toBe(account.id);
		// New behavior: applyRateLimitCooldown caps the upstream resetTime via
		// `min(resetTime, now + backoff)`. With a 30-minute upstream reset and
		// a 30-second BASE backoff on the first 429, the backoff wins.
		const reset = calls.markRateLimited[0]?.resetTime ?? 0;
		expect(reset).toBeGreaterThanOrEqual(before + 30 * 1000 - 1000);
		expect(reset).toBeLessThanOrEqual(Date.now() + 30 * 1000 + 1000);
		expect(reset).toBeLessThan(resetTime); // backoff capped the upstream
		expect(calls.markRateLimited[0]?.reason).toBe("upstream_429_with_reset");
	});

	it("passes reason='upstream_429_no_reset_probe_cooldown' when no resetTime", async () => {
		const account = makeAccount();
		const before = Date.now();
		const { ctx, calls } = makeCtxWithReason({
			isStream: false,
			rateLimited: true,
			resetTime: undefined,
		});
		const response = new Response('{"error":"rate_limit"}', {
			status: 429,
			headers: { "content-type": "application/json" },
		});

		await processProxyResponse(response, account, ctx);

		expect(calls.markRateLimited).toHaveLength(1);
		expect(calls.markRateLimited[0]?.accountId).toBe(account.id);
		expect(calls.markRateLimited[0]?.reason).toBe(
			"upstream_429_no_reset_probe_cooldown",
		);
		// New behavior: first 429 in a streak applies BASE (30s) backoff.
		const BASE = 30 * 1000;
		const reset = calls.markRateLimited[0]?.resetTime ?? 0;
		expect(reset).toBeGreaterThanOrEqual(before + BASE - 1000);
		expect(reset).toBeLessThanOrEqual(Date.now() + BASE + 1000);
	});

	it("passes reason='upstream_429_with_reset' on streaming 429 with resetTime", async () => {
		const account = makeAccount();
		const resetTime = Date.now() + 60 * 60_000;
		const { ctx, calls } = makeCtxWithReason({
			isStream: true,
			rateLimited: true,
			resetTime,
		});
		const response = new Response("rate limited", {
			status: 429,
			headers: { "content-type": "text/event-stream" },
		});

		await processProxyResponse(response, account, ctx);

		expect(calls.markRateLimited).toHaveLength(1);
		expect(calls.markRateLimited[0]?.reason).toBe("upstream_429_with_reset");
	});
});

describe("processProxyResponse — streaming rate-limit failover (issue #114)", () => {
	it("returns true and marks the account on a streaming 429", async () => {
		// Pre-stream 429 — this is the case where Anthropic responds with a
		// 429 but the response happens to carry text/event-stream content-type
		// (e.g. an upstream that preserves the requested content-type on
		// errors). The historic `!isStream` guard would silently bypass both
		// marking and failover here.
		const account = makeAccount();
		const { ctx, calls } = makeCtx({
			isStream: true,
			rateLimited: true,
			resetTime: Date.now() + 30 * 60_000,
		});
		const response = new Response("rate limited", {
			status: 429,
			headers: { "content-type": "text/event-stream" },
		});

		const result = await processProxyResponse(response, account, ctx);

		expect(result).toBe(true); // signals failover loop
		expect(calls.markRateLimited).toHaveLength(1);
		expect(calls.markRateLimited[0]?.accountId).toBe(account.id);
	});

	it("returns true and marks the account on a non-streaming 429 (regression)", async () => {
		// Regression guard for the historic happy path: a JSON 429 must still
		// trigger marking + failover.
		const account = makeAccount();
		const { ctx, calls } = makeCtx({
			isStream: false,
			rateLimited: true,
			resetTime: Date.now() + 30 * 60_000,
		});
		const response = new Response('{"error":"rate_limit"}', {
			status: 429,
			headers: { "content-type": "application/json" },
		});

		const result = await processProxyResponse(response, account, ctx);

		expect(result).toBe(true);
		expect(calls.markRateLimited).toHaveLength(1);
	});

	it("returns false on a successful streaming response", async () => {
		// Negative case: a healthy SSE response must NOT be marked as
		// rate-limited and must NOT signal failover. This guards against an
		// over-correction where dropping the !isStream guard accidentally
		// flags every stream.
		const account = makeAccount();
		const { ctx, calls } = makeCtx({ isStream: true, rateLimited: false });
		const response = new Response("event: message_start\n\n", {
			status: 200,
			headers: { "content-type": "text/event-stream" },
		});

		const result = await processProxyResponse(response, account, ctx);

		expect(result).toBe(false);
		expect(calls.markRateLimited).toHaveLength(0);
	});

	it("falls back to a BASE backoff cooldown when a streaming 429 has no resetTime", async () => {
		// Some providers return 429s without rate-limit headers. With the
		// adaptive backoff, the first 429 in a streak uses BASE (30s) so the
		// account is excluded briefly, then re-probed.
		const account = makeAccount();
		const before = Date.now();
		const { ctx, calls } = makeCtx({
			isStream: true,
			rateLimited: true,
			resetTime: undefined,
		});
		const response = new Response("rate limited", {
			status: 429,
			headers: { "content-type": "text/event-stream" },
		});

		const result = await processProxyResponse(response, account, ctx);

		expect(result).toBe(true);
		expect(calls.markRateLimited).toHaveLength(1);
		// First 429 in streak → BASE (30s) backoff. ±1s drift.
		const BASE = 30 * 1000;
		const reset = calls.markRateLimited[0]?.resetTime ?? 0;
		expect(reset).toBeGreaterThanOrEqual(before + BASE - 1000);
		expect(reset).toBeLessThanOrEqual(Date.now() + BASE + 1000);
	});
});

describe("processProxyResponse — in-memory cooldown mutation", () => {
	it("sets account.rate_limited_until on 429 with resetTime", async () => {
		const account = makeAccount();
		const resetTime = Date.now() + 30 * 60_000;
		const before = Date.now();
		const { ctx } = makeCtx({
			isStream: false,
			rateLimited: true,
			resetTime,
		});
		const response = new Response('{"error":"rate_limit"}', {
			status: 429,
			headers: { "content-type": "application/json" },
		});

		await processProxyResponse(response, account, ctx);

		// New behavior: capped at min(upstream, now + backoff). With a 30-minute
		// upstream and a 30-second BASE backoff, the backoff wins.
		expect(account.rate_limited_until).not.toBeNull();
		expect(account.rate_limited_until ?? 0).toBeGreaterThanOrEqual(
			before + 30 * 1000 - 1000,
		);
		expect(account.rate_limited_until ?? 0).toBeLessThanOrEqual(
			Date.now() + 30 * 1000 + 1000,
		);
	});

	it("sets account.rate_limited_until to BASE backoff on 429 without resetTime", async () => {
		const account = makeAccount();
		const before = Date.now();
		const { ctx } = makeCtx({
			isStream: false,
			rateLimited: true,
			resetTime: undefined,
		});
		const response = new Response('{"error":"rate_limit"}', {
			status: 429,
			headers: { "content-type": "application/json" },
		});

		await processProxyResponse(response, account, ctx);

		// New behavior: first 429 in a streak applies BASE (30s) backoff.
		expect(account.rate_limited_until).not.toBeNull();
		const BASE = 30 * 1000;
		expect(account.rate_limited_until ?? 0).toBeGreaterThanOrEqual(
			before + BASE - 1000,
		);
		expect(account.rate_limited_until ?? 0).toBeLessThanOrEqual(
			Date.now() + BASE + 1000,
		);
	});

	it("clears account.rate_limited_until on successful response", async () => {
		const account = makeAccount({
			rate_limited_until: Date.now() + 60_000, // previously rate-limited
		});
		const { ctx } = makeCtx({
			isStream: false,
			rateLimited: false,
		});
		const response = new Response('{"id":"msg_1"}', {
			status: 200,
			headers: { "content-type": "application/json" },
		});

		await processProxyResponse(response, account, ctx);

		// Successful response clears cooldown
		expect(account.rate_limited_until).toBeNull();
	});

	it("does not clear account.rate_limited_until when already null on success", async () => {
		const account = makeAccount(); // rate_limited_until is null by default
		const { ctx } = makeCtx({
			isStream: false,
			rateLimited: false,
		});
		const response = new Response('{"id":"msg_1"}', {
			status: 200,
			headers: { "content-type": "application/json" },
		});

		await processProxyResponse(response, account, ctx);

		// No mutation needed — already null
		expect(account.rate_limited_until).toBeNull();
	});
});
