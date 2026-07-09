import { describe, expect, it } from "bun:test";
import {
	computeRateLimitStatusDisplay,
	extractUsageResetMs,
	getRepresentativeUsageResetMs,
	isUsageExhausted,
} from "../rate-limit-status";

/**
 * Incident 2026-07-09: MAX_200_ALT_2 showed `rateLimitStatus: "OK"` on the
 * dashboard while its weekly usage window sat at 100% (is_active, critical)
 * and every upstream request 429'd. The status string only reflected the last
 * unified-header snapshot (`rate_limit_status`, NULL for ALT_2) and an active
 * cooldown — usage exhaustion was invisible. These tests pin the desired
 * behavior: an exhausted usage window must take precedence over "OK" and over
 * stale "allowed*" header snapshots.
 */

const NOW = Date.UTC(2026, 6, 9, 2, 30, 0);

const base = {
	rate_limit_status: null as string | null,
	rate_limit_reset: null as number | null,
	rate_limited_until: null as number | null,
	usageUtilization: null as number | null,
	usageResetMs: null as number | null,
};

describe("computeRateLimitStatusDisplay — usage exhaustion (incident fix)", () => {
	it("reports usage_exhausted instead of OK when the representative window is at 100%", () => {
		// ALT_2 during the incident: no unified header snapshot, weekly 100%.
		const resetMs = NOW + 60 * 60000;
		const status = computeRateLimitStatusDisplay(
			{ ...base, usageUtilization: 100, usageResetMs: resetMs },
			NOW,
		);
		expect(status).toBe("usage_exhausted (60m)");
	});

	it("reports usage_exhausted without minutes when no reset time is known", () => {
		const status = computeRateLimitStatusDisplay(
			{ ...base, usageUtilization: 100 },
			NOW,
		);
		expect(status).toBe("usage_exhausted");
	});

	it("outranks a stale allowed_warning header snapshot", () => {
		// MAX_200_ALT during the incident: allowed_warning with far-future
		// reset, but the weekly window was already at 100%.
		const status = computeRateLimitStatusDisplay(
			{
				...base,
				rate_limit_status: "allowed_warning",
				rate_limit_reset: NOW + 2907 * 60000,
				usageUtilization: 100,
				usageResetMs: NOW + 2907 * 60000,
			},
			NOW,
		);
		expect(status).toBe("usage_exhausted (2907m)");
	});

	it("does NOT claim exhaustion when the known reset lies in the past (stale usage snapshot)", () => {
		const status = computeRateLimitStatusDisplay(
			{ ...base, usageUtilization: 100, usageResetMs: NOW - 1 },
			NOW,
		);
		expect(status).toBe("OK");
	});

	it("does not fire below 100%", () => {
		const status = computeRateLimitStatusDisplay(
			{ ...base, usageUtilization: 99 },
			NOW,
		);
		expect(status).toBe("OK");
	});

	it("outranks an active cooldown lock (usage exhaustion is the harder fact)", () => {
		const status = computeRateLimitStatusDisplay(
			{
				...base,
				rate_limited_until: NOW + 30_000,
				usageUtilization: 100,
				usageResetMs: NOW + 120 * 60000,
			},
			NOW,
		);
		expect(status).toBe("usage_exhausted (120m)");
	});
});

describe("isUsageExhausted — shared staleness guard", () => {
	it("is exhausted at 100% with unknown reset", () => {
		expect(isUsageExhausted(100, null, NOW)).toBe(true);
	});

	it("is exhausted at 100% with a future reset", () => {
		expect(isUsageExhausted(100, NOW + 60_000, NOW)).toBe(true);
	});

	it("is NOT exhausted when the known reset lies in the past (stale snapshot)", () => {
		expect(isUsageExhausted(100, NOW - 1, NOW)).toBe(false);
	});

	it("is NOT exhausted below 100% or without data", () => {
		expect(isUsageExhausted(99, null, NOW)).toBe(false);
		expect(isUsageExhausted(null, null, NOW)).toBe(false);
	});
});

describe("computeRateLimitStatusDisplay — existing behavior (parity)", () => {
	it("shows the unified header status with minutes until reset", () => {
		const status = computeRateLimitStatusDisplay(
			{
				...base,
				rate_limit_status: "allowed",
				rate_limit_reset: NOW + 67 * 60000,
			},
			NOW,
		);
		expect(status).toBe("allowed (67m)");
	});

	it("shows the unified header status without minutes when reset already passed", () => {
		const status = computeRateLimitStatusDisplay(
			{ ...base, rate_limit_status: "allowed", rate_limit_reset: NOW - 1000 },
			NOW,
		);
		expect(status).toBe("allowed");
	});

	it("falls back to the legacy cooldown display", () => {
		const status = computeRateLimitStatusDisplay(
			{ ...base, rate_limited_until: NOW + 30_000 },
			NOW,
		);
		expect(status).toBe("Rate limited (1m)");
	});

	it("returns OK when nothing is known", () => {
		expect(computeRateLimitStatusDisplay(base, NOW)).toBe("OK");
	});
});

describe("getRepresentativeUsageResetMs — shared provider-aware reset derivation", () => {
	it("zai: reads the reset from the tokens_limit payload key despite the five_hour display label", () => {
		const resetAt = NOW + 3_600_000;
		const data = {
			time_limit: null,
			tokens_limit: {
				used: 100,
				remaining: 0,
				percentage: 100,
				resetAt,
				type: "tokens",
			},
		};
		expect(getRepresentativeUsageResetMs(data, "zai")).toBe(resetAt);
	});

	it("anthropic: uses the representative (max-utilization) window's resets_at", () => {
		const data = {
			five_hour: { utilization: 10, resets_at: null },
			seven_day: { utilization: 100, resets_at: "2026-07-11T08:00:00.000Z" },
		};
		expect(getRepresentativeUsageResetMs(data, "anthropic")).toBe(
			Date.UTC(2026, 6, 11, 8, 0, 0),
		);
	});

	it("nanogpt: uses the busier window's resetAt", () => {
		const resetAt = NOW + 7_200_000;
		const data = {
			active: true,
			limits: { daily: 1, monthly: 1 },
			enforceDailyLimit: true,
			daily: { used: 1, remaining: 0, percentUsed: 1, resetAt },
			monthly: {
				used: 0,
				remaining: 1,
				percentUsed: 0.1,
				resetAt: NOW + 30 * 86_400_000,
			},
			state: "active",
			graceUntil: null,
		};
		expect(getRepresentativeUsageResetMs(data, "nanogpt")).toBe(resetAt);
	});

	it("returns null for unknown providers or missing data", () => {
		expect(getRepresentativeUsageResetMs(null, "zai")).toBeNull();
		expect(getRepresentativeUsageResetMs({}, "openai-compatible")).toBeNull();
	});
});

describe("extractUsageResetMs", () => {
	it("reads ISO resets_at from anthropic-style windows", () => {
		const data = {
			five_hour: { utilization: 10, resets_at: null },
			seven_day: { utilization: 100, resets_at: "2026-07-11T08:00:00.000Z" },
		};
		expect(extractUsageResetMs(data, "seven_day")).toBe(
			Date.UTC(2026, 6, 11, 8, 0, 0),
		);
	});

	it("reads numeric resetAt from zai/nanogpt-style windows", () => {
		const resetAt = NOW + 3_600_000;
		const data = { tokens_limit: { percentage: 100, resetAt } };
		expect(extractUsageResetMs(data, "tokens_limit")).toBe(resetAt);
	});

	it("returns null for unknown windows or missing data", () => {
		expect(extractUsageResetMs(null, "seven_day")).toBeNull();
		expect(extractUsageResetMs({}, "seven_day")).toBeNull();
		expect(extractUsageResetMs({ seven_day: {} }, null)).toBeNull();
	});
});
