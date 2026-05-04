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
		session_start: null,
		session_request_count: 0,
		paused: false,
		rate_limit_reset: null,
		rate_limit_status: null,
		rate_limit_remaining: null,
		priority: 0,
		auto_fallback_enabled: false,
		auto_refresh_enabled: false,
		custom_endpoint: null,
		model_mappings: null,
		cross_region_mode: null,
		model_fallbacks: null,
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
		enqueueCount: 0,
	};

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
			markAccountRateLimited: (
				accountId: string,
				resetTime: number,
				_reason: string,
			) => {
				calls.markRateLimited.push({ accountId, resetTime });
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
		enqueueCount: 0,
	};

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
			markAccountRateLimited: (
				accountId: string,
				resetTime: number,
				reason: string,
			) => {
				calls.markRateLimited.push({ accountId, resetTime, reason });
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
		expect(calls.markRateLimited[0]?.resetTime).toBe(resetTime);
		expect(calls.markRateLimited[0]?.reason).toBe("upstream_429_with_reset");
	});

	it("passes reason='upstream_429_no_reset_default_5h' when no resetTime", async () => {
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
			"upstream_429_no_reset_default_5h",
		);
		// resetTime should be approximately now + 5h
		const FIVE_HOURS = 5 * 60 * 60 * 1000;
		const reset = calls.markRateLimited[0]?.resetTime ?? 0;
		expect(reset).toBeGreaterThanOrEqual(before + FIVE_HOURS - 1000);
		expect(reset).toBeLessThanOrEqual(Date.now() + FIVE_HOURS + 1000);
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

	it("falls back to a default 5h window when a streaming 429 has no resetTime", async () => {
		// Some providers return 429s without rate-limit headers. The current
		// code path defaults to a 5h cooldown — make sure that still fires
		// for the streaming case after the !isStream guard removal.
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
		// Default cooldown is Date.now() + 5h. Allow ±1s for test runtime drift.
		const FIVE_HOURS = 5 * 60 * 60 * 1000;
		const reset = calls.markRateLimited[0]?.resetTime ?? 0;
		expect(reset).toBeGreaterThanOrEqual(before + FIVE_HOURS - 1000);
		expect(reset).toBeLessThanOrEqual(Date.now() + FIVE_HOURS + 1000);
	});
});
