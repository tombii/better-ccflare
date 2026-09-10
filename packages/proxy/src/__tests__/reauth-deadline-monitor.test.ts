import { describe, expect, it } from "bun:test";
import type { Account } from "@better-ccflare/types";
import { isEligibleForReauthDeadline } from "@better-ccflare/types";
import {
	checkReauthDeadline,
	computeReauthDeadline,
} from "../handlers/token-health-monitor";

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const REAUTH_MANUAL_DEADLINE_MS = 28 * DAY_MS;
const CRITICAL_THRESHOLD_MS = 12 * HOUR_MS;
const WARNING_THRESHOLD_MS = 3 * DAY_MS;

// Fixed reference instant so boundary tests don't depend on real wall-clock
// time; combined with computeReauthDeadline's injectable `now` param this
// lets us land exactly on tier boundaries.
const NOW = Date.UTC(2026, 0, 15, 12, 0, 0);

function makeAccount(overrides: Partial<Account> = {}): Account {
	return {
		id: "acc-1",
		name: "test-account",
		provider: "anthropic",
		api_key: null,
		refresh_token: "refresh-token-value",
		access_token: "access-token-value",
		expires_at: null,
		request_count: 0,
		total_requests: 0,
		last_used: null,
		created_at: NOW - 100 * DAY_MS,
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
		last_manual_reauth_at: null,
		consecutive_rate_limits: 0,
		...overrides,
	} as Account;
}

describe("computeReauthDeadline", () => {
	it("returns null when eligible is false (API-key account)", () => {
		const result = computeReauthDeadline({
			eligible: false,
			lastManualReauthAt: Date.now() - DAY_MS,
		});

		expect(result).toBeNull();
	});

	it("returns null when lastManualReauthAt is null, regardless of account age (bug fix — no createdAt fallback)", () => {
		// This is the critical regression test: a prior version of this feature
		// fell back to account creation date when lastManualReauthAt was null,
		// which caused every pre-existing account (created long before this
		// feature shipped, and never manually reauthenticated since) to
		// permanently report "expired" and spam hourly alerts. createdAt isn't
		// even a parameter anymore — eligible accounts with no recorded manual
		// reauth must resolve to an unknown (null) deadline, never "expired".
		const result = computeReauthDeadline({
			eligible: true,
			lastManualReauthAt: null,
		});

		expect(result).toBeNull();
	});

	it("returns status 'ok' when lastManualReauthAt is recent", () => {
		const lastManualReauthAt = Date.now() - DAY_MS; // 1 day ago -> 27 days left
		const result = computeReauthDeadline({
			eligible: true,
			lastManualReauthAt,
		});

		expect(result).not.toBeNull();
		expect(result?.status).toBe("ok");
		expect(result?.deadlineAt).toBe(
			lastManualReauthAt + REAUTH_MANUAL_DEADLINE_MS,
		);
	});

	it("returns status 'warning' when the deadline is between 12h and 3 days away", () => {
		// Anchor so the 28-day deadline lands 2 days from now.
		const lastManualReauthAt =
			Date.now() - (REAUTH_MANUAL_DEADLINE_MS - 2 * DAY_MS);
		const result = computeReauthDeadline({
			eligible: true,
			lastManualReauthAt,
		});

		expect(result?.status).toBe("warning");
	});

	it("returns status 'critical' when the deadline is within 12 hours (but still future)", () => {
		// Anchor so the 28-day deadline lands 6 hours from now.
		const lastManualReauthAt =
			Date.now() - (REAUTH_MANUAL_DEADLINE_MS - 6 * HOUR_MS);
		const result = computeReauthDeadline({
			eligible: true,
			lastManualReauthAt,
		});

		expect(result?.status).toBe("critical");
		expect(result?.deadlineAt).toBeGreaterThan(Date.now());
	});

	it("returns status 'expired' when the deadline has already passed", () => {
		// Anchor so the 28-day deadline was 2 days ago.
		const lastManualReauthAt =
			Date.now() - (REAUTH_MANUAL_DEADLINE_MS + 2 * DAY_MS);
		const result = computeReauthDeadline({
			eligible: true,
			lastManualReauthAt,
		});

		expect(result?.status).toBe("expired");
		expect(result?.deadlineAt).toBeLessThan(Date.now());
	});

	it("populates daysUntilDeadline/hoursUntilDeadline with sane values in the 'ok' tier", () => {
		const lastManualReauthAt = Date.now() - DAY_MS; // 27 days left
		const result = computeReauthDeadline({
			eligible: true,
			lastManualReauthAt,
		});

		expect(result?.daysUntilDeadline).toBeGreaterThanOrEqual(26);
		expect(result?.daysUntilDeadline).toBeLessThanOrEqual(27);
		expect(result?.hoursUntilDeadline).toBeGreaterThan(24 * 26);
	});

	it("populates daysUntilDeadline/hoursUntilDeadline with sane values in the 'warning' tier", () => {
		const lastManualReauthAt =
			Date.now() - (REAUTH_MANUAL_DEADLINE_MS - 2 * DAY_MS);
		const result = computeReauthDeadline({
			eligible: true,
			lastManualReauthAt,
		});

		expect(result?.daysUntilDeadline).toBeGreaterThanOrEqual(1);
		expect(result?.daysUntilDeadline).toBeLessThanOrEqual(2);
		expect(result?.hoursUntilDeadline).toBeGreaterThan(12);
		expect(result?.hoursUntilDeadline).toBeLessThanOrEqual(48);
	});

	it("populates daysUntilDeadline/hoursUntilDeadline with sane values in the 'critical' tier", () => {
		const lastManualReauthAt =
			Date.now() - (REAUTH_MANUAL_DEADLINE_MS - 6 * HOUR_MS);
		const result = computeReauthDeadline({
			eligible: true,
			lastManualReauthAt,
		});

		expect(result?.hoursUntilDeadline).toBeGreaterThanOrEqual(5);
		expect(result?.hoursUntilDeadline).toBeLessThanOrEqual(6);
		expect(result?.daysUntilDeadline).toBe(1);
	});

	it("populates daysUntilDeadline/hoursUntilDeadline with sane (negative) values in the 'expired' tier", () => {
		const lastManualReauthAt =
			Date.now() - (REAUTH_MANUAL_DEADLINE_MS + 2 * DAY_MS);
		const result = computeReauthDeadline({
			eligible: true,
			lastManualReauthAt,
		});

		expect(result?.daysUntilDeadline).toBeLessThanOrEqual(-1);
		expect(result?.hoursUntilDeadline).toBeLessThan(0);
	});
});

describe("computeReauthDeadline — tier boundaries (injectable now)", () => {
	function withMsLeft(msLeft: number) {
		const lastManualReauthAt = NOW - (REAUTH_MANUAL_DEADLINE_MS - msLeft);
		return computeReauthDeadline({
			eligible: true,
			lastManualReauthAt,
			now: NOW,
		});
	}

	it("exactly 12h remaining -> 'critical'", () => {
		const result = withMsLeft(CRITICAL_THRESHOLD_MS);
		expect(result?.status).toBe("critical");
	});

	it("exactly 12h + 1ms remaining -> 'warning'", () => {
		const result = withMsLeft(CRITICAL_THRESHOLD_MS + 1);
		expect(result?.status).toBe("warning");
	});

	it("exactly 3 days remaining -> 'warning'", () => {
		const result = withMsLeft(WARNING_THRESHOLD_MS);
		expect(result?.status).toBe("warning");
	});

	it("exactly 3 days + 1ms remaining -> 'ok'", () => {
		const result = withMsLeft(WARNING_THRESHOLD_MS + 1);
		expect(result?.status).toBe("ok");
	});

	it("exactly 0ms remaining (deadline === now) -> 'expired'", () => {
		const result = withMsLeft(0);
		expect(result?.status).toBe("expired");
		expect(result?.deadlineAt).toBe(NOW);
	});
});

describe("computeReauthDeadline — expired message rounding (bug L3)", () => {
	function overdueBy(daysOverdue: number) {
		const msLeft = -daysOverdue * DAY_MS;
		const lastManualReauthAt = NOW - (REAUTH_MANUAL_DEADLINE_MS - msLeft);
		return computeReauthDeadline({
			eligible: true,
			lastManualReauthAt,
			now: NOW,
		});
	}

	it("1.5 days overdue reports '~1 day(s) ago' (floors the magnitude, doesn't over-report)", () => {
		const result = overdueBy(1.5);
		expect(result?.status).toBe("expired");
		expect(result?.message).toContain("~1 day(s) ago");
	});

	it("2.5 days overdue reports '~2 day(s) ago' (not '~3')", () => {
		const result = overdueBy(2.5);
		expect(result?.status).toBe("expired");
		expect(result?.message).toContain("~2 day(s) ago");
	});
});

describe("checkReauthDeadline — Account eligibility predicate (bugs H3+M1)", () => {
	it("returns non-null for a genuine Claude OAuth account (anthropic, distinct refresh/access tokens) that has a recorded manual reauth", () => {
		const account = makeAccount({
			provider: "anthropic",
			refresh_token: "refresh-value",
			access_token: "access-value",
			last_manual_reauth_at: Date.now() - DAY_MS,
		});
		expect(checkReauthDeadline(account)).not.toBeNull();
	});

	it("returns null for a non-anthropic provider even with refresh_token and access_token set", () => {
		// last_manual_reauth_at is deliberately non-null (unlike the account
		// default): computeReauthDeadline already returns null whenever the
		// timestamp is null, regardless of eligibility, so a null timestamp
		// here would let this test pass even if isEligibleForReauthDeadline
		// were broken. A real timestamp forces this to exercise the provider
		// check specifically.
		const account = makeAccount({
			provider: "qwen",
			refresh_token: "refresh-value",
			access_token: "access-value",
			last_manual_reauth_at: Date.now() - 5 * DAY_MS,
		});
		expect(checkReauthDeadline(account)).toBeNull();
	});

	it("returns null when refresh_token === access_token (API-key-in-both-fields pattern)", () => {
		// See note above: a non-null last_manual_reauth_at ensures this
		// exercises the refresh/access-token-equality check, not the separate
		// null-timestamp short-circuit in computeReauthDeadline.
		const account = makeAccount({
			provider: "anthropic",
			refresh_token: "same-value",
			access_token: "same-value",
			last_manual_reauth_at: Date.now() - 5 * DAY_MS,
		});
		expect(checkReauthDeadline(account)).toBeNull();
	});

	it("returns null for an anthropic account with refresh_token but null access_token (console-mode-after-downgrade pattern)", () => {
		// See note above: a non-null last_manual_reauth_at ensures this
		// exercises the null-access_token check, not the separate
		// null-timestamp short-circuit in computeReauthDeadline.
		const account = makeAccount({
			provider: "anthropic",
			refresh_token: "refresh-value",
			access_token: null,
			last_manual_reauth_at: Date.now() - 5 * DAY_MS,
		});
		expect(checkReauthDeadline(account)).toBeNull();
	});

	it("returns null (not 'expired') for an eligible, very old pre-existing account that has never been manually reauthenticated (critical bug fix)", () => {
		// This is the single most important test in this file: a prior version
		// of computeReauthDeadline fell back to created_at when
		// lastManualReauthAt was null, which meant every pre-existing account
		// (created well before this feature shipped) permanently reported
		// "expired" and spammed hourly alerts. An eligible account with no
		// recorded manual reauth has an UNKNOWN deadline, not an assumed-expired
		// one — regardless of how old the account is.
		const account = makeAccount({
			provider: "anthropic",
			refresh_token: "refresh-value",
			access_token: "access-value",
			created_at: Date.now() - 200 * DAY_MS,
			last_manual_reauth_at: null,
		});
		expect(checkReauthDeadline(account)).toBeNull();
	});
});

describe("isEligibleForReauthDeadline", () => {
	it("returns true for a genuine Claude OAuth account (anthropic, distinct refresh/access tokens)", () => {
		expect(
			isEligibleForReauthDeadline({
				provider: "anthropic",
				refreshToken: "refresh-value",
				accessToken: "access-value",
			}),
		).toBe(true);
	});

	it("returns false for a non-anthropic provider", () => {
		expect(
			isEligibleForReauthDeadline({
				provider: "qwen",
				refreshToken: "refresh-value",
				accessToken: "access-value",
			}),
		).toBe(false);
	});

	it("returns false when refreshToken === accessToken", () => {
		expect(
			isEligibleForReauthDeadline({
				provider: "anthropic",
				refreshToken: "same-value",
				accessToken: "same-value",
			}),
		).toBe(false);
	});

	it("returns false when accessToken is null", () => {
		expect(
			isEligibleForReauthDeadline({
				provider: "anthropic",
				refreshToken: "refresh-value",
				accessToken: null,
			}),
		).toBe(false);
	});

	it("returns false when refreshToken is null", () => {
		expect(
			isEligibleForReauthDeadline({
				provider: "anthropic",
				refreshToken: null,
				accessToken: "access-value",
			}),
		).toBe(false);
	});
});
