import { describe, expect, it } from "bun:test";
import type { AccountUsageSnapshot } from "@better-ccflare/core";
import {
	getRepresentativeUsageSnapshotForProvider,
	type ZaiUsageData,
} from "@better-ccflare/providers";
import type { Account } from "@better-ccflare/types";
import {
	createPoolExhaustedResponse,
	POOL_EXHAUSTED_MAX_RETRY_AFTER_SECONDS,
	POOL_EXHAUSTED_UNKNOWN_RESET_RETRY_AFTER_SECONDS,
} from "../proxy-operations";

/**
 * Pools exhausted by usage caps (not by `rate_limited_until` cooldowns) must
 * surface a `usage_exhausted` reason and a Retry-After that matches the
 * upstream reset window. The 2026-07-30T20:24-22:20Z production trace
 * exposed this gap: every 503 carried Retry-After: 60 against
 * CLAUDE_CODE_MAX_RETRIES=5, killing clients in ~300s of a 116-minute outage.
 *
 * `now` is sourced from `Date.now()` rather than a hardcoded timestamp so the
 * tests remain stable as wall-clock time advances during a long-lived CI run
 * — the function under test calls `Date.now()` internally too.
 */

const FUTURE_OFFSET_MS = 3_600_000; // +1 hour from "now"

function makeAccount(overrides: Partial<Account> = {}): Account {
	return {
		id: "acc-1",
		name: "acc-1",
		provider: "anthropic",
		api_key: null,
		refresh_token: "refresh-token",
		access_token: null,
		expires_at: null,
		request_count: 0,
		total_requests: 0,
		last_used: null,
		created_at: 1,
		rate_limited_until: null,
		rate_limited_reason: null,
		rate_limited_at: null,
		session_start: null,
		session_request_count: 0,
		paused: false,
		requires_reauth: false,
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

describe("createPoolExhaustedResponse — usage-aware", () => {
	it("reports usage_exhausted for a 100%-utilization account with rate_limited_until=null", async () => {
		const usageCapped = makeAccount({
			id: "usage-only",
			name: "usage-only",
			// rate_limited_until intentionally null — this is the production
			// case the pre-fix code misclassified as "unavailable".
		});
		const resetMs = Date.now() + FUTURE_OFFSET_MS;
		const snapshot: AccountUsageSnapshot = {
			utilization: 100,
			resetMs,
		};
		const snapshots = new Map<string, AccountUsageSnapshot>([
			[usageCapped.id, snapshot],
		]);

		const response = createPoolExhaustedResponse([usageCapped], snapshots);
		expect(response.status).toBe(503);

		const body = (await response.json()) as {
			error: {
				type: string;
				next_available_at: string | null;
				accounts: Array<{
					name: string;
					reason: string;
					available_at: string | null;
				}>;
			};
		};

		expect(body.error.type).toBe("pool_exhausted");
		expect(body.error.accounts[0]?.reason).toBe("usage_exhausted");
		expect(body.error.accounts[0]?.available_at).toBe(
			new Date(resetMs).toISOString(),
		);
		expect(body.error.next_available_at).toBe(new Date(resetMs).toISOString());

		const retryAfter = Number(response.headers.get("Retry-After"));
		expect(retryAfter).toBeGreaterThan(3500);
		expect(retryAfter).toBeLessThanOrEqual(FUTURE_OFFSET_MS / 1000);
		expect(response.headers.get("Retry-After")).not.toBe("60");
	});

	it("falls back to the 600s unknown-reset floor when usage is exhausted but resetMs is null (matches UsageCache TTL)", async () => {
		const usageCapped = makeAccount({
			id: "usage-no-reset",
			name: "usage-no-reset",
		});
		const snapshots = new Map<string, AccountUsageSnapshot>([
			[usageCapped.id, { utilization: 100, resetMs: null }],
		]);

		const response = createPoolExhaustedResponse([usageCapped], snapshots);
		expect(response.headers.get("Retry-After")).toBe(
			String(POOL_EXHAUSTED_UNKNOWN_RESET_RETRY_AFTER_SECONDS),
		);
		expect(Number(response.headers.get("Retry-After"))).not.toBe(60);

		const body = (await response.json()) as {
			error: {
				accounts: Array<{ reason: string; available_at: string | null }>;
				next_available_at: string | null;
			};
		};
		expect(body.error.accounts[0]?.reason).toBe("usage_exhausted");
		expect(body.error.accounts[0]?.available_at).toBeNull();
		expect(body.error.next_available_at).toBeNull();
	});

	it("takes the EARLIEST known recovery across usage reset and rate_limited_until", async () => {
		const usageCapped = makeAccount({ id: "early-usage", name: "early-usage" });
		const cooldownOnly = makeAccount({
			id: "later-cooldown",
			name: "later-cooldown",
			rate_limited_until: Date.now() + 3_600_000, // 1h
		});
		const snapshots = new Map<string, AccountUsageSnapshot>([
			[
				usageCapped.id,
				{ utilization: 100, resetMs: Date.now() + 90_000 }, // 90s
			],
		]);

		const response = createPoolExhaustedResponse(
			[usageCapped, cooldownOnly],
			snapshots,
		);
		// tolerance: a few hundred ms of slack for Date.now() advancing
		// between when we set the snapshot and when the function reads it.
		const retryAfter = Number(response.headers.get("Retry-After"));
		expect(retryAfter).toBeGreaterThan(80);
		expect(retryAfter).toBeLessThan(91);
	});

	it("clamps Retry-After to POOL_EXHAUSTED_MAX_RETRY_AFTER_SECONDS for outages longer than the cap", async () => {
		// Mirrors the incident: 116-minute outage, every account usage-capped.
		// Pre-fix Retry-After: 60 → 5x60=300s and clients die. With the fix
		// the Retry-After honors the actual reset horizon but is clamped to
		// the 1h cap so clients cannot sleep through an unannounced recovery.
		const allCapped = [
			makeAccount({ id: "a", name: "a" }),
			makeAccount({ id: "b", name: "b" }),
			makeAccount({ id: "c", name: "c" }),
		];
		const snapshots = new Map<string, AccountUsageSnapshot>();
		const resetMs = Date.now() + 6_960_000; // 116 minutes
		for (const acc of allCapped) {
			snapshots.set(acc.id, { utilization: 100, resetMs });
		}

		const response = createPoolExhaustedResponse(allCapped, snapshots);
		const retryAfter = Number(response.headers.get("Retry-After"));
		// Clamped to MAX (3600s) — i.e. NOT 6960s, NOT 60s.
		expect(retryAfter).toBe(POOL_EXHAUSTED_MAX_RETRY_AFTER_SECONDS);
		expect(retryAfter).not.toBe(60);
	});

	it("falls back to the unknown-reset floor when no usage info AND no cooldown (only paused accounts)", async () => {
		// Pre-fix returned Retry-After: 60 here. The new contract applies the
		// 600s floor so client retries cannot outpace the cache refresh.
		const onlyPaused = makeAccount({ id: "p", name: "p", paused: true });
		const response = createPoolExhaustedResponse([onlyPaused]);
		expect(response.headers.get("Retry-After")).toBe(
			String(POOL_EXHAUSTED_UNKNOWN_RESET_RETRY_AFTER_SECONDS),
		);
	});

	it("ignores stale usage resets (resetMs in the past) when computing next_available_at", async () => {
		// Same staleness guard isUsageExhausted uses everywhere else — a
		// snapshot predating the window reset MUST NOT claim recovery.
		const usageCapped = makeAccount({ id: "stale", name: "stale" });
		const snapshots = new Map<string, AccountUsageSnapshot>([
			[usageCapped.id, { utilization: 100, resetMs: Date.now() - 1_000 }],
		]);

		const response = createPoolExhaustedResponse([usageCapped], snapshots);
		const body = (await response.json()) as {
			error: { accounts: Array<{ reason: string }> };
		};
		expect(body.error.accounts[0]?.reason).toBe("unavailable");
		expect(response.headers.get("Retry-After")).toBe(
			String(POOL_EXHAUSTED_UNKNOWN_RESET_RETRY_AFTER_SECONDS),
		);
	});

	it("keeps requires_reauth / paused reasons ahead of usage_exhausted", async () => {
		// Precedence is unchanged for reasons that aren't reset-driven.
		const stuck = makeAccount({
			id: "stuck",
			name: "stuck",
			requires_reauth: true,
		});
		const snapshots = new Map<string, AccountUsageSnapshot>([
			[stuck.id, { utilization: 100, resetMs: Date.now() + FUTURE_OFFSET_MS }],
		]);

		const response = createPoolExhaustedResponse([stuck], snapshots);
		const body = (await response.json()) as {
			error: { accounts: Array<{ reason: string }> };
		};
		expect(body.error.accounts[0]?.reason).toBe("requires_reauth");
	});
});

describe("Zai pool-exhausted snapshot pairing", () => {
	it("uses the reset from the window with the winning utilization", async () => {
		const timeLimitResetMs = Date.now() + 120_000;
		const tokensLimitResetMs = Date.now() + 3_600_000;
		const zaiUsage: ZaiUsageData = {
			time_limit: {
				used: 100,
				remaining: 0,
				percentage: 100,
				resetAt: timeLimitResetMs,
				type: "time_limit",
			},
			tokens_limit: {
				used: 50,
				remaining: 50,
				percentage: 50,
				resetAt: tokensLimitResetMs,
				type: "tokens_limit",
			},
		};
		const account = makeAccount({ provider: "zai" });
		const snapshot = getRepresentativeUsageSnapshotForProvider(zaiUsage, "zai");
		expect(snapshot).not.toBeNull();
		if (!snapshot) return;

		const response = createPoolExhaustedResponse(
			[account],
			new Map([[account.id, snapshot]]),
		);
		const body = (await response.json()) as {
			error: {
				next_available_at: string | null;
				accounts: Array<{
					reason: string;
					available_at: string | null;
				}>;
			};
		};
		const winningReset = new Date(timeLimitResetMs).toISOString();

		expect(snapshot.utilization).toBe(100);
		expect(snapshot.resetMs).toBe(timeLimitResetMs);
		expect(body.error.accounts[0]?.reason).toBe("usage_exhausted");
		expect(body.error.accounts[0]?.available_at).toBe(winningReset);
		expect(body.error.next_available_at).toBe(winningReset);
		expect(body.error.next_available_at).not.toBe(
			new Date(tokensLimitResetMs).toISOString(),
		);
		const retryAfter = Number(response.headers.get("Retry-After"));
		expect(retryAfter).toBeGreaterThan(110);
		expect(retryAfter).toBeLessThanOrEqual(120);
	});

	it("keeps the reset unknown when the winning window has no reset", () => {
		const zaiUsage: ZaiUsageData = {
			time_limit: {
				used: 100,
				remaining: 0,
				percentage: 100,
				resetAt: null,
				type: "time_limit",
			},
			tokens_limit: {
				used: 10,
				remaining: 90,
				percentage: 10,
				resetAt: Date.now() + 3_600_000,
				type: "tokens_limit",
			},
		};
		const snapshot = getRepresentativeUsageSnapshotForProvider(zaiUsage, "zai");

		expect(snapshot).not.toBeNull();
		if (snapshot) expect(snapshot.resetMs).toBeNull();
	});
});
