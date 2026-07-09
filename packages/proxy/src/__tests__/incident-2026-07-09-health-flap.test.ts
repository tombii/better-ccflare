import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	mock,
	spyOn,
} from "bun:test";
import {
	computeRateLimitBackoffMs,
	isAccountAvailable,
} from "@better-ccflare/core";
import type { Account } from "@better-ccflare/types";
import type { ProxyContext } from "../handlers";
import { applyRateLimitCooldown } from "../handlers/rate-limit-cooldown";
import { handleProxy } from "../proxy";
import * as usageCollectorModule from "../usage-collector";

/**
 * Characterization tests for the 2026-07-09 incident: upstream 429s on every
 * unpaused account (no model fallbacks configured) benched the whole pool via
 * account-wide cooldowns, so NEW sessions received 503 pool_exhausted while
 * /health flipped back to `routable: N` as soon as each short backoff lapsed —
 * even though nothing upstream had changed.
 *
 * The per-account 429 → model_fallback_429 → cooldown path itself is covered
 * by proxy-operations-failover.test.ts ("429 failover" / "rate limit audit
 * trail"). These tests pin the cross-cutting pool/health behavior on top.
 */

// 2026-07-09T02:27:38Z — first pool_exhausted of the incident window
const T0 = Date.UTC(2026, 6, 9, 2, 27, 38);

function makeAccount(overrides: Partial<Account> = {}): Account {
	return {
		id: "acc-1",
		name: "test-account",
		provider: "anthropic",
		api_key: null,
		refresh_token: null,
		access_token: null,
		expires_at: null,
		request_count: 0,
		total_requests: 0,
		last_used: null,
		created_at: T0,
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
		consecutive_rate_limits: 0,
		...overrides,
	} as Account;
}

function makeContext(accounts: Account[]): ProxyContext {
	return {
		strategy: {
			// Mirrors the real availability predicate (core isAccountAvailable):
			// unpaused and no active cooldown.
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
			markAccountRateLimited: mock(async () => 1),
		} as never,
		runtime: { port: 8080, clientId: "test" } as never,
		config: {
			getUsageThrottlingFiveHourEnabled: () => false,
			getUsageThrottlingWeeklyEnabled: () => false,
			getSystemPromptCacheTtl1h: () => false,
		} as never,
		provider: {
			name: "anthropic",
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
			model: "claude-sonnet-5",
			messages: [{ role: "user", content: "spawn subagent" }],
			max_tokens: 16,
		}),
	});
}

const ENV_KEYS = [
	"CCFLARE_RATE_LIMIT_BACKOFF_BASE_MS",
	"CCFLARE_RATE_LIMIT_BACKOFF_MAX_MS",
	"CCFLARE_PASSTHROUGH_ON_EMPTY_POOL",
] as const;
let savedEnv: Record<string, string | undefined>;
const realDateNow = Date.now;

beforeEach(() => {
	savedEnv = {};
	for (const key of ENV_KEYS) {
		savedEnv[key] = process.env[key];
		delete process.env[key];
	}
});

afterEach(() => {
	Date.now = realDateNow;
	for (const key of ENV_KEYS) {
		if (savedEnv[key] === undefined) delete process.env[key];
		else process.env[key] = savedEnv[key];
	}
});

describe("incident 2026-07-09 — account-wide cooldown from a scoped upstream 429", () => {
	it("model_fallback_429 benches the WHOLE account, even though the upstream 429 may only affect new sessions or one model", () => {
		Date.now = () => T0;
		const account = makeAccount({ id: "alt-3", name: "MAX_200_ALT_3" });
		const ctx = makeContext([account]);

		applyRateLimitCooldown(account, { reason: "model_fallback_429" }, ctx);

		const expectedUntil = T0 + computeRateLimitBackoffMs(1);
		expect(account.rate_limited_until).toBe(expectedUntil);
		// The predicate shared by the router AND /health's `routable` counter
		// (packages/core/src/strategy.ts) now excludes the account for EVERY
		// model and session — the bench is account-wide.
		expect(isAccountAvailable(account, T0)).toBe(false);
	});

	it("with every unpaused account benched, a new-session request gets 503 pool_exhausted", async () => {
		Date.now = () => T0;
		const alt3 = makeAccount({ id: "alt-3", name: "MAX_200_ALT_3" });
		const alt2 = makeAccount({ id: "alt-2", name: "MAX_200_ALT_2" });
		const ctx = makeContext([alt3, alt2]);

		// The pool-exhausted path logs to the usage collector singleton, which
		// is not initialized in unit tests (same pattern as
		// auto-refresh-probe-filter.test.ts, site 3).
		const collectorSpy = spyOn(
			usageCollectorModule,
			"getUsageCollector",
		).mockReturnValue({
			handleStart: mock(() => {}),
			handleEnd: mock(() => Promise.resolve()),
		} as unknown as usageCollectorModule.UsageCollector);

		try {
			// Incident sequence: the spawn request 429'd on ALT_3, failed over to
			// ALT_2, 429'd again — each attempt benched its account.
			applyRateLimitCooldown(alt3, { reason: "model_fallback_429" }, ctx);
			applyRateLimitCooldown(alt2, { reason: "model_fallback_429" }, ctx);

			const response = await handleProxy(
				makeRequest(),
				new URL("https://proxy.local/v1/messages"),
				ctx,
			);

			expect(response.status).toBe(503);
			const body = (await response.json()) as Record<string, unknown>;
			const error = body.error as Record<string, unknown>;
			expect(error.type).toBe("pool_exhausted");

			// Recovery time advertised to the client = end of the 30s backoff …
			const expectedUntil = T0 + computeRateLimitBackoffMs(1);
			expect(error.next_available_at).toBe(
				new Date(expectedUntil).toISOString(),
			);
		} finally {
			collectorSpy.mockRestore();
		}
	});

	it("FLAP: once the backoff lapses, the /health predicate counts the accounts as routable again although upstream never recovered", () => {
		Date.now = () => T0;
		const alt3 = makeAccount({ id: "alt-3", name: "MAX_200_ALT_3" });
		const alt2 = makeAccount({ id: "alt-2", name: "MAX_200_ALT_2" });
		const ctx = makeContext([alt3, alt2]);

		applyRateLimitCooldown(alt3, { reason: "model_fallback_429" }, ctx);
		applyRateLimitCooldown(alt2, { reason: "model_fallback_429" }, ctx);

		const accounts = [alt3, alt2];
		const routableAt = (now: number) =>
			accounts.filter((a) => isAccountAvailable(a, now)).length;

		// During the bench window: pool is empty (health: routable 0 / 503s).
		expect(routableAt(T0)).toBe(0);

		// One millisecond after the backoff lapses, /health's routable counter
		// (computePoolStatus in packages/http-api/src/handlers/health.ts uses
		// exactly this predicate) reports full capacity again — but the local
		// bookkeeping learned NOTHING about the upstream limit having cleared.
		// This is the observed incident state: `/health` said `routable: 2`
		// while the very next new-session request 429'd on both accounts and
		// surfaced as 503 pool_exhausted again.
		const afterBackoff = T0 + computeRateLimitBackoffMs(1) + 1;
		expect(routableAt(afterBackoff)).toBe(2);
	});
});
