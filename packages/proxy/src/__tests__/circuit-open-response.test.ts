import { describe, expect, it } from "bun:test";
import type { Account } from "@better-ccflare/types";
// Import directly from the source file to avoid pulling in the handlers
// barrel (which transitively imports heavy provider modules just to type
// resolve).
import {
	createPoolExhaustedResponse,
	type PoolExhaustionKind,
} from "../handlers/proxy-operations";

function makeAccount(overrides: Partial<Account> = {}): Account {
	return {
		id: "acc-1",
		name: "test-account",
		provider: "codex",
		api_key: null,
		refresh_token: "test-refresh-token",
		access_token: null,
		expires_at: null,
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

describe("createPoolExhaustedResponse — circuit_open", () => {
	// Spec test (1): "The circuit_open response carries status 503 and the
	// documented body shape."
	it("returns 503 and the documented body shape for circuit_open", async () => {
		const accounts = [
			makeAccount({ id: "acc-A", name: "account-A", paused: false }),
		];
		const response = createPoolExhaustedResponse(
			accounts,
			undefined,
			"circuit_open",
		);

		expect(response.status).toBe(503);

		const body = (await response.json()) as Record<string, unknown>;
		expect(body.type).toBe("error");

		const error = body.error as Record<string, unknown>;
		expect(error.type).toBe("circuit_open");
		expect(typeof error.message).toBe("string");
		expect((error.message as string).length).toBeGreaterThan(0);
		// `accounts` is documented as present in the body — the breaker refused
		// one account, so the array has one entry.
		expect(Array.isArray(error.accounts)).toBe(true);
		const errorAccounts = error.accounts as Array<Record<string, unknown>>;
		expect(errorAccounts).toHaveLength(1);
		expect(errorAccounts[0]?.name).toBe("account-A");
		expect(errorAccounts[0]?.reason).toBe("circuit_open");
	});

	// Spec test (2): "Retry-After and the pool-status header are present and
	// correct."
	it("sets Retry-After and x-better-ccflare-pool-status for circuit_open", () => {
		const accounts = [makeAccount({ name: "account-A" })];
		const response = createPoolExhaustedResponse(
			accounts,
			undefined,
			"circuit_open",
		);

		const retryAfter = response.headers.get("Retry-After");
		expect(retryAfter).not.toBeNull();
		const retryAfterSeconds = Number(retryAfter);
		// Must be a positive integer number of seconds.
		expect(Number.isFinite(retryAfterSeconds)).toBe(true);
		expect(retryAfterSeconds).toBeGreaterThan(0);
		// Circuit-open responses have no rate_limited_until window, so the
		// Retry-After comes from the breaker's open-cooldown duration. We
		// document it as a small positive integer; pin a lower bound so a
		// regression that returned 0 or a negative number is caught.
		expect(retryAfterSeconds).toBeGreaterThanOrEqual(30);
		expect(retryAfterSeconds).toBeLessThanOrEqual(60);

		// Wire shape is intentionally unchanged — the pool-status header keeps
		// its `exhausted` value so existing consumers (dashboard, fleet reaper)
		// keep treating the response as a transient 503. The cause lives in
		// `error.type`.
		expect(response.headers.get("x-better-ccflare-pool-status")).toBe(
			"exhausted",
		);

		// Content-Type is the same as pool_exhausted — JSON, no surprises for
		// downstream parsers.
		expect(response.headers.get("Content-Type")).toContain("application/json");
	});

	// Spec test (2 cont.): when the account is ALSO rate-limited well past the
	// breaker's own cooldown, Retry-After must reflect the LONGER, more honest
	// wait — a 30s breaker hint must never undercut a real multi-minute
	// cooldown the client would otherwise be misled into ignoring.
	it("uses the longer of breaker-cooldown and rate_limited_until for circuit_open", () => {
		const accounts = [
			makeAccount({
				name: "account-A",
				// 5 minutes in the future — longer than the breaker's 30s cooldown,
				// so this must win.
				rate_limited_until: Date.now() + 5 * 60_000,
			}),
		];
		const response = createPoolExhaustedResponse(
			accounts,
			undefined,
			"circuit_open",
		);
		const retryAfterSeconds = Number(response.headers.get("Retry-After"));

		// The longer, more honest wait wins — not the breaker's bare 30s floor.
		expect(retryAfterSeconds).toBeGreaterThanOrEqual(290);
		expect(retryAfterSeconds).toBeLessThanOrEqual(300);
	});

	// When no other recovery signal is known, circuit_open falls back to the
	// breaker's own 30s cooldown floor.
	it("falls back to the breaker-cooldown floor when no other recovery time is known", () => {
		const accounts = [makeAccount({ name: "account-A" })];
		const response = createPoolExhaustedResponse(
			accounts,
			undefined,
			"circuit_open",
		);
		const retryAfterSeconds = Number(response.headers.get("Retry-After"));

		expect(retryAfterSeconds).toBe(30);
	});

	// Spec test (3): "A genuine pool-exhaustion still reports pool_exhausted,
	// NOT circuit_open (the two do not collapse into one another)."
	it("preserves the pool_exhausted kind when no kind argument is supplied", async () => {
		const accounts = [makeAccount({ paused: true, pause_reason: "manual" })];
		const response = createPoolExhaustedResponse(accounts);

		expect(response.status).toBe(503);

		const body = (await response.json()) as Record<string, unknown>;
		const error = body.error as Record<string, unknown>;
		expect(error.type).toBe("pool_exhausted");
		const errorAccounts = error.accounts as Array<Record<string, unknown>>;
		expect(errorAccounts[0]?.reason).toBe("paused");
	});

	// Spec test (3 cont.): explicit "pool_exhausted" produces a non-circuit_open
	// response, even when the accounts have the fields that look "circuit-like".
	it("does not collapse to circuit_open when an explicit pool_exhausted kind is passed", async () => {
		const accounts = [
			makeAccount({
				name: "account-A",
				paused: true,
				pause_reason: "manual",
				rate_limited_until: Date.now() + 30_000,
			}),
		];
		const response = createPoolExhaustedResponse(
			accounts,
			undefined,
			"pool_exhausted" satisfies PoolExhaustionKind,
		);

		const body = (await response.json()) as Record<string, unknown>;
		const error = body.error as Record<string, unknown>;
		expect(error.type).toBe("pool_exhausted");
		const errorAccounts = error.accounts as Array<Record<string, unknown>>;
		// Even though the account is rate-limited AND paused, the per-account
		// reason under the pool_exhausted kind must NOT become circuit_open.
		expect(errorAccounts[0]?.reason).not.toBe("circuit_open");
	});

	// Spec test (3 cont. cont.): circuit_open propagates to every account in
	// the list. Each account listed has the breaker as its gate, so the
	// per-account reason is circuit_open uniformly.
	it("emits circuit_open for every account in the list", async () => {
		const accounts = [
			makeAccount({ id: "acc-A", name: "account-A", paused: false }),
			makeAccount({ id: "acc-B", name: "account-B", paused: true }),
		];
		const response = createPoolExhaustedResponse(
			accounts,
			undefined,
			"circuit_open",
		);

		const body = (await response.json()) as Record<string, unknown>;
		const error = body.error as Record<string, unknown>;
		const errorAccounts = error.accounts as Array<Record<string, unknown>>;

		// Even though account-B is paused, the breaker is the gate — its
		// per-account reason is circuit_open, NOT "paused".
		expect(errorAccounts).toHaveLength(2);
		for (const a of errorAccounts) {
			expect(a.reason).toBe("circuit_open");
		}
	});

	// circuit_open clears next_available_at — the breaker decides when to
	// re-admit, not the account's rate-limit window. Available-at is null
	// for circuit_open accounts even if they happen to also have a
	// rate_limited_until timestamp.
	it("sets next_available_at to null for circuit_open responses", async () => {
		const accounts = [
			makeAccount({
				name: "account-A",
				rate_limited_until: Date.now() + 60_000,
			}),
		];
		const response = createPoolExhaustedResponse(
			accounts,
			undefined,
			"circuit_open",
		);
		const body = (await response.json()) as Record<string, unknown>;
		const error = body.error as Record<string, unknown>;
		expect(error.next_available_at).toBeNull();
	});

	// circuit_open and pool_exhausted responses share the same wire status
	// (503) and same Content-Type. The fleet reaper branches on
	// `error.type`, not on status — this is the whole point of NOT inventing
	// a new error type.
	it("preserves 503 status for both kinds (no new error type)", async () => {
		const accounts = [makeAccount({ paused: true, pause_reason: "manual" })];

		const poolExhausted = createPoolExhaustedResponse(
			accounts,
			undefined,
			"pool_exhausted",
		);
		const circuitOpen = createPoolExhaustedResponse(
			accounts,
			undefined,
			"circuit_open",
		);

		expect(poolExhausted.status).toBe(503);
		expect(circuitOpen.status).toBe(503);
	});
});
