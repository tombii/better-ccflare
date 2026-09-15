import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	mock,
	spyOn,
} from "bun:test";
import { logBus } from "@better-ccflare/logger";
import type { Account } from "@better-ccflare/types";
import type { ProxyContext } from "../handlers";
import { INTERNAL_PROBE_SECRET_HEADER } from "../handlers/proxy-types";
import { handleProxy } from "../proxy";
import * as usageCollectorModule from "../usage-collector";

function stubUsageCollector() {
	return spyOn(usageCollectorModule, "getUsageCollector").mockReturnValue({
		handleStart: mock(() => {}),
		handleChunk: mock(() => {}),
		handleEnd: mock(() => Promise.resolve()),
	} as unknown as usageCollectorModule.UsageCollector);
}

function makeAccount(overrides: Partial<Account> = {}): Account {
	return {
		id: "acc-1",
		name: "test-account",
		provider: "codex",
		api_key: null,
		refresh_token: null,
		access_token: null,
		expires_at: null,
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

function makeContext(accounts: Account[]): ProxyContext {
	return {
		strategy: {
			select: (accs: Account[]) => {
				// Mock filtering: only return accounts that are NOT paused and NOT rate-limited
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
			getAgentFrontmatterModelFallback: () => false,
		} as never,
		provider: {
			name: "codex",
			canHandle: () => true,
		} as never,
		refreshInFlight: new Map(),
		asyncWriter: { enqueue: mock(() => {}) } as never,
	};
}

function makeRequest(): Request {
	return new Request("https://proxy.local/v1/messages", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			model: "claude-sonnet-4-5",
			messages: [{ role: "user", content: "hello" }],
			max_tokens: 16,
		}),
	});
}

let savedPassthrough: string | undefined;

beforeEach(() => {
	savedPassthrough = process.env.CCFLARE_PASSTHROUGH_ON_EMPTY_POOL;
	delete process.env.CCFLARE_PASSTHROUGH_ON_EMPTY_POOL;
	stubUsageCollector();
});

afterEach(() => {
	if (savedPassthrough === undefined) {
		delete process.env.CCFLARE_PASSTHROUGH_ON_EMPTY_POOL;
	} else {
		process.env.CCFLARE_PASSTHROUGH_ON_EMPTY_POOL = savedPassthrough;
	}
});

describe("pool exhausted — 503 response", () => {
	it("returns 503 with pool_exhausted body when pool is empty", async () => {
		const ctx = makeContext([]);
		const response = await handleProxy(
			makeRequest(),
			new URL("https://proxy.local/v1/messages"),
			ctx,
		);

		expect(response.status).toBe(503);

		const body = (await response.json()) as Record<string, unknown>;
		expect(body.type).toBe("error");

		const error = body.error as Record<string, unknown>;
		expect(error.type).toBe("pool_exhausted");
		expect(typeof error.message).toBe("string");
		expect((error.message as string).length).toBeGreaterThan(0);
		expect("next_available_at" in error).toBe(true);
		expect(Array.isArray(error.accounts)).toBe(true);
	});

	it("returns Retry-After header when pool is empty", async () => {
		const ctx = makeContext([]);
		const response = await handleProxy(
			makeRequest(),
			new URL("https://proxy.local/v1/messages"),
			ctx,
		);

		expect(response.status).toBe(503);
		const retryAfter = response.headers.get("Retry-After");
		expect(retryAfter).toBeDefined();
		expect(Number(retryAfter)).toBeGreaterThan(0);
	});

	it("returns x-better-ccflare-pool-status: exhausted header", async () => {
		const ctx = makeContext([]);
		const response = await handleProxy(
			makeRequest(),
			new URL("https://proxy.local/v1/messages"),
			ctx,
		);

		expect(response.status).toBe(503);
		expect(response.headers.get("x-better-ccflare-pool-status")).toBe(
			"exhausted",
		);
	});

	it("returns Content-Type: application/json header", async () => {
		const ctx = makeContext([]);
		const response = await handleProxy(
			makeRequest(),
			new URL("https://proxy.local/v1/messages"),
			ctx,
		);

		expect(response.headers.get("Content-Type")).toContain("application/json");
	});

	it("includes account info in response when accounts are paused/rate-limited", async () => {
		const pausedAccount = makeAccount({
			id: "acc-paused",
			name: "paused-account",
			paused: true,
			pause_reason: "manual",
		});
		const rateLimitedAccount = makeAccount({
			id: "acc-rl",
			name: "rate-limited-account",
			rate_limited_until: Date.now() + 60_000,
		});

		const ctx = makeContext([pausedAccount, rateLimitedAccount]);
		const response = await handleProxy(
			makeRequest(),
			new URL("https://proxy.local/v1/messages"),
			ctx,
		);

		expect(response.status).toBe(503);

		const body = (await response.json()) as Record<string, unknown>;
		const error = body.error as Record<string, unknown>;
		const accounts = error.accounts as Array<Record<string, unknown>>;

		expect(accounts.length).toBe(2);
		const names = accounts.map((a) => a.name as string);
		expect(names).toContain("paused-account");
		expect(names).toContain("rate-limited-account");
	});

	it("includes next_available_at ISO timestamp when rate-limited accounts exist", async () => {
		const cooldownUntil = Date.now() + 3_600_000; // 1 hour from now
		const rateLimitedAccount = makeAccount({
			id: "acc-rl",
			name: "rate-limited-account",
			rate_limited_until: cooldownUntil,
		});

		const ctx = makeContext([rateLimitedAccount]);
		const response = await handleProxy(
			makeRequest(),
			new URL("https://proxy.local/v1/messages"),
			ctx,
		);

		expect(response.status).toBe(503);

		const body = (await response.json()) as Record<string, unknown>;
		const error = body.error as Record<string, unknown>;
		expect(error.next_available_at).not.toBeNull();
		// Should be a valid ISO timestamp
		const ts = new Date(error.next_available_at as string);
		expect(ts.getTime()).toBeGreaterThan(Date.now());
	});

	it("sets Retry-After to seconds until next_available_at when rate-limited accounts exist", async () => {
		const now = Date.UTC(2026, 3, 28, 12, 0, 0);
		const cooldownUntil = now + 3_600_000; // 1 hour
		const rateLimitedAccount = makeAccount({
			id: "acc-rl",
			name: "rate-limited-account",
			rate_limited_until: cooldownUntil,
		});

		const realDateNow = Date.now;
		Date.now = () => now;
		try {
			const ctx = makeContext([rateLimitedAccount]);
			const response = await handleProxy(
				makeRequest(),
				new URL("https://proxy.local/v1/messages"),
				ctx,
			);

			expect(response.status).toBe(503);
			const retryAfter = Number(response.headers.get("Retry-After"));
			// Should be close to 3600 seconds (within 5s tolerance)
			expect(retryAfter).toBeGreaterThan(3595);
			expect(retryAfter).toBeLessThanOrEqual(3600);
		} finally {
			Date.now = realDateNow;
		}
	});

	it("clamps Retry-After to the 600s unknown-reset floor when no cooldown info (only paused accounts)", async () => {
		// Pre-fix this asserted Retry-After: 60, which combined with
		// CLAUDE_CODE_MAX_RETRIES=5 to kill clients in 300s during a 116-minute
		// total outage (production trace 2026-07-30). The new contract returns
		// the unknown-reset floor (600s = UsageCache TTL, see
		// POOL_EXHAUSTED_UNKNOWN_RESET_RETRY_AFTER_SECONDS in proxy-operations.ts)
		// so a client retry is guaranteed to see fresh telemetry rather than
		// retrying blindly against a stale snapshot.
		const pausedAccount = makeAccount({
			id: "acc-paused",
			name: "paused-account",
			paused: true,
		});

		const ctx = makeContext([pausedAccount]);
		const response = await handleProxy(
			makeRequest(),
			new URL("https://proxy.local/v1/messages"),
			ctx,
		);

		expect(response.status).toBe(503);
		expect(response.headers.get("Retry-After")).toBe("600");
	});

	it("filters accounts by provider in multi-provider setup", async () => {
		const codexAccount = makeAccount({
			id: "acc-codex",
			name: "codex-account",
			provider: "codex",
			paused: true,
			pause_reason: "manual",
		});
		const anthropicAccount = makeAccount({
			id: "acc-anthropic",
			name: "anthropic-account",
			provider: "anthropic",
			paused: true,
			pause_reason: "manual",
		});

		// Both accounts in DB, but only codex accounts should appear in response
		const ctx = makeContext([codexAccount, anthropicAccount]);
		const response = await handleProxy(
			makeRequest(),
			new URL("https://proxy.local/v1/messages"),
			ctx,
		);

		expect(response.status).toBe(503);

		const body = (await response.json()) as Record<string, unknown>;
		const error = body.error as Record<string, unknown>;
		const accounts = error.accounts as Array<Record<string, unknown>>;

		// Only codex account should appear
		expect(accounts.length).toBe(1);
		expect(accounts[0].name).toBe("codex-account");
	});
});

describe("pool exhausted — CCFLARE_PASSTHROUGH_ON_EMPTY_POOL=1 escape hatch", () => {
	// An internal probe is exempt from the escape hatch. Passing it through
	// unauthenticated earns a 401 from upstream, which the auto-refresh
	// scheduler reads as "this account's tokens are dead" — a verdict about an
	// account the request never carried.
	it("keeps an internal auto-refresh probe on the 503 answer even with the flag set", async () => {
		process.env.CCFLARE_PASSTHROUGH_ON_EMPTY_POOL = "1";

		const ctx = makeContext([]);
		(
			ctx as ProxyContext & { internalProbeSecret?: string }
		).internalProbeSecret = "test-secret";

		const request = makeRequest();
		request.headers.set("x-better-ccflare-auto-refresh", "true");
		request.headers.set("x-better-ccflare-bypass-session", "true");
		request.headers.set(INTERNAL_PROBE_SECRET_HEADER, "test-secret");

		const response = await handleProxy(
			request,
			new URL("https://proxy.local/v1/messages"),
			ctx,
		);

		// proxyUnauthenticated never produces this body, so a pool_exhausted 503
		// is proof the passthrough branch was skipped.
		expect(response.status).toBe(503);
		const body = (await response.json()) as Record<string, unknown>;
		const error = body.error as Record<string, unknown>;
		expect(error.type).toBe("pool_exhausted");
	});

	it("does NOT return 503 when CCFLARE_PASSTHROUGH_ON_EMPTY_POOL=1 and pool is empty", async () => {
		process.env.CCFLARE_PASSTHROUGH_ON_EMPTY_POOL = "1";

		const ctx = makeContext([]);
		// proxyUnauthenticated will try to make a real request and fail —
		// we just check it doesn't return 503 with our pool_exhausted body.
		// It will throw or return a different status.
		try {
			const response = await handleProxy(
				makeRequest(),
				new URL("https://proxy.local/v1/messages"),
				ctx,
			);
			// If it returns, it should NOT be our 503 pool_exhausted
			if (response.status === 503) {
				const body = (await response.json()) as Record<string, unknown>;
				const error = body.error as Record<string, unknown> | undefined;
				expect(error?.type).not.toBe("pool_exhausted");
			}
			// Any other status means passthrough was attempted
		} catch {
			// Expected: proxyUnauthenticated throws when no real provider configured
			// This is fine — it means we went through the passthrough path
		}
	});
});

it("records a joined local refusal without inventing an upstream attempt", async () => {
	const saved = process.env.CCFLARE_CODEX_CACHE_DIAGNOSTICS;
	const events: Record<string, unknown>[] = [];
	const listener = (event: { msg: string; data?: Record<string, unknown> }) => {
		if (event.msg === "Codex cache observation lifecycle" && event.data)
			events.push(event.data);
	};
	logBus.on("log", listener);
	process.env.CCFLARE_CODEX_CACHE_DIAGNOSTICS = "1";
	try {
		const ctx = makeContext([]);
		ctx.provider = { name: "anthropic", canHandle: () => true } as never;
		const request = makeRequest();
		request.headers.set(
			"x-better-ccflare-gateway-request-digest",
			"a".repeat(64),
		);
		request.headers.set(
			"x-better-ccflare-gateway-attempt-digest",
			"b".repeat(64),
		);
		const response = await handleProxy(request, new URL(request.url), ctx);
		expect(response.status).toBe(503);
		expect((await response.json()).error.type).toBe("pool_exhausted");
		expect(events.map((row) => row.event)).toEqual([
			"request_received",
			"request_identified",
			"request_headers",
		]);
		expect(events.at(-1)).toMatchObject({
			status_code: 503,
			refusal_reason: "pool_exhausted",
			gateway_request_digest: "a".repeat(64),
			gateway_attempt_digest: "b".repeat(64),
		});
		expect(events.at(-1)?.request_digest).toMatch(/^[0-9a-f]{64}$/);
		expect(events.at(-1)?.ingress_digest).toBe(events[0].ingress_digest);
		expect(JSON.stringify(events)).not.toContain("hello");
	} finally {
		if (saved === undefined) delete process.env.CCFLARE_CODEX_CACHE_DIAGNOSTICS;
		else process.env.CCFLARE_CODEX_CACHE_DIAGNOSTICS = saved;
		logBus.off("log", listener);
	}
});
