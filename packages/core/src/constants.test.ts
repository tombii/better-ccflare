import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
	computeOverloadCooldownMs,
	computeOverloadWithResetCapMs,
	computeRateLimitBackoffMs,
	computeServerErrorCooldownMs,
	getOverloadRetryConfig,
	getRateLimitResetStabilityMs,
	getServerErrorRetryEnabled,
	isOverloadReason,
	isServerErrorReason,
	TIME_CONSTANTS,
} from "@better-ccflare/core";

const ENV_KEYS = [
	"CCFLARE_OVERLOAD_COOLDOWN_MS",
	"CCFLARE_OVERLOAD_RETRY_MAX_ATTEMPTS",
	"CCFLARE_OVERLOAD_WITH_RESET_MAX_MS",
	"CCFLARE_RATE_LIMIT_BACKOFF_BASE_MS",
	"CCFLARE_RATE_LIMIT_BACKOFF_MAX_MS",
	"CCFLARE_RATE_LIMIT_RESET_STABILITY_MS",
	"CCFLARE_SERVER_ERROR_COOLDOWN_MS",
	"CCFLARE_SERVER_ERROR_RETRY_ENABLED",
] as const;

let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
	savedEnv = {};
	for (const key of ENV_KEYS) {
		savedEnv[key] = process.env[key];
		delete process.env[key];
	}
});

afterEach(() => {
	for (const key of ENV_KEYS) {
		if (savedEnv[key] === undefined) delete process.env[key];
		else process.env[key] = savedEnv[key];
	}
});

describe("duration env overrides", () => {
	it("honors a valid positive override", () => {
		process.env.CCFLARE_OVERLOAD_COOLDOWN_MS = "2500";
		process.env.CCFLARE_OVERLOAD_WITH_RESET_MAX_MS = "90000";
		process.env.CCFLARE_RATE_LIMIT_RESET_STABILITY_MS = "1234";
		expect(computeOverloadCooldownMs()).toBe(2500);
		expect(computeOverloadWithResetCapMs()).toBe(90000);
		expect(getRateLimitResetStabilityMs()).toBe(1234);
	});

	it("falls back to the default when the variable is unset or unparseable", () => {
		expect(computeOverloadCooldownMs()).toBe(
			TIME_CONSTANTS.OVERLOAD_COOLDOWN_MS,
		);
		process.env.CCFLARE_OVERLOAD_COOLDOWN_MS = "not-a-number";
		expect(computeOverloadCooldownMs()).toBe(
			TIME_CONSTANTS.OVERLOAD_COOLDOWN_MS,
		);
		process.env.CCFLARE_OVERLOAD_COOLDOWN_MS = "0";
		expect(computeOverloadCooldownMs()).toBe(
			TIME_CONSTANTS.OVERLOAD_COOLDOWN_MS,
		);
	});

	// A negative duration is not a shorter cooldown — it lands in the past, so
	// every cooldown written from it is already expired on arrival, silently
	// disabling the mechanism instead of tuning it.
	it("rejects negative durations", () => {
		for (const key of ENV_KEYS) process.env[key] = "-5000";
		expect(computeOverloadCooldownMs()).toBe(
			TIME_CONSTANTS.OVERLOAD_COOLDOWN_MS,
		);
		expect(computeOverloadWithResetCapMs()).toBe(
			TIME_CONSTANTS.OVERLOAD_WITH_RESET_MAX_MS,
		);
		expect(getRateLimitResetStabilityMs()).toBe(
			TIME_CONSTANTS.RATE_LIMIT_RESET_STABILITY_MS,
		);
		expect(computeRateLimitBackoffMs(1)).toBeGreaterThan(0);
	});

	// Infinity benches the account forever and makes the audit logging throw:
	// applyRateLimitCooldown formats the resulting timestamp with
	// `new Date(cooldownUntil).toISOString()`, which raises RangeError.
	it("rejects non-finite durations", () => {
		for (const key of ENV_KEYS) process.env[key] = "Infinity";
		expect(computeOverloadCooldownMs()).toBe(
			TIME_CONSTANTS.OVERLOAD_COOLDOWN_MS,
		);
		expect(computeOverloadWithResetCapMs()).toBe(
			TIME_CONSTANTS.OVERLOAD_WITH_RESET_MAX_MS,
		);
		expect(getRateLimitResetStabilityMs()).toBe(
			TIME_CONSTANTS.RATE_LIMIT_RESET_STABILITY_MS,
		);
		expect(Number.isFinite(computeRateLimitBackoffMs(1))).toBe(true);
	});

	// The with-reset cap is the only clamp between a 529 carrying an
	// anthropic-ratelimit-unified-reset header (hours away) and an
	// hours-long bench. A non-finite cap disables `min(resetTime, cap)`
	// entirely, so it must never be reachable through configuration.
	it("keeps the with-reset cap finite so min(resetTime, cap) still clamps", () => {
		process.env.CCFLARE_OVERLOAD_WITH_RESET_MAX_MS = "Infinity";
		const now = 1_700_000_000_000;
		const threeHoursOut = now + 3 * 60 * 60 * 1000;
		const capUntil = now + computeOverloadWithResetCapMs();
		expect(Math.min(threeHoursOut, capUntil)).toBe(capUntil);
		expect(capUntil).toBeLessThan(threeHoursOut);
	});
});

describe("transient upstream 5xx knobs", () => {
	it("defaults the server-error cooldown to 60s and honors a positive override", () => {
		expect(computeServerErrorCooldownMs()).toBe(
			TIME_CONSTANTS.SERVER_ERROR_COOLDOWN_MS,
		);
		process.env.CCFLARE_SERVER_ERROR_COOLDOWN_MS = "15000";
		expect(computeServerErrorCooldownMs()).toBe(15000);
	});

	it("falls back to the default for unparseable, zero, negative and non-finite values", () => {
		for (const raw of ["not-a-number", "0", "-5000", "Infinity"]) {
			process.env.CCFLARE_SERVER_ERROR_COOLDOWN_MS = raw;
			expect(computeServerErrorCooldownMs()).toBe(
				TIME_CONSTANTS.SERVER_ERROR_COOLDOWN_MS,
			);
		}
	});

	it("enables the 5xx retry unless the kill switch is set to the literal false", () => {
		expect(getServerErrorRetryEnabled()).toBe(true);
		process.env.CCFLARE_SERVER_ERROR_RETRY_ENABLED = "true";
		expect(getServerErrorRetryEnabled()).toBe(true);
		process.env.CCFLARE_SERVER_ERROR_RETRY_ENABLED = "false";
		expect(getServerErrorRetryEnabled()).toBe(false);
	});

	it("keeps the 5xx reason distinct from the 529 overload reasons", () => {
		expect(isServerErrorReason("upstream_5xx_server_error")).toBe(true);
		expect(isServerErrorReason("upstream_529_overloaded_no_reset")).toBe(false);
		expect(isOverloadReason("upstream_5xx_server_error")).toBe(false);
	});
});

describe("overload retry attempt count", () => {
	it("defaults to 2 and honors a valid integer override", () => {
		expect(getOverloadRetryConfig().maxAttempts).toBe(2);
		process.env.CCFLARE_OVERLOAD_RETRY_MAX_ATTEMPTS = "3";
		expect(getOverloadRetryConfig().maxAttempts).toBe(3);
		process.env.CCFLARE_OVERLOAD_RETRY_MAX_ATTEMPTS = " 4 ";
		expect(getOverloadRetryConfig().maxAttempts).toBe(4);
	});

	it("truncates a fractional attempt count", () => {
		process.env.CCFLARE_OVERLOAD_RETRY_MAX_ATTEMPTS = "2.9";
		expect(getOverloadRetryConfig().maxAttempts).toBe(2);
	});

	// The three retry loops in proxy-operations spin on `attempt < maxAttempts`
	// while the upstream keeps returning 5xx/529, so a non-finite count is an
	// unbounded retry loop against a sick upstream, not a generous one.
	it("falls back to the default for non-finite and unparseable values", () => {
		for (const raw of ["Infinity", "-Infinity", "NaN", "abc"]) {
			process.env.CCFLARE_OVERLOAD_RETRY_MAX_ATTEMPTS = raw;
			expect(getOverloadRetryConfig().maxAttempts).toBe(2);
		}
	});

	// 0 and negatives would silently disable the retry; the documented way to
	// turn it off is CCFLARE_OVERLOAD_RETRY_ENABLED=false.
	it("falls back to the default for zero and negative counts", () => {
		for (const raw of ["0", "-4"]) {
			process.env.CCFLARE_OVERLOAD_RETRY_MAX_ATTEMPTS = raw;
			expect(getOverloadRetryConfig().maxAttempts).toBe(2);
		}
	});

	it("clamps an oversized attempt count to 10", () => {
		process.env.CCFLARE_OVERLOAD_RETRY_MAX_ATTEMPTS = "50";
		expect(getOverloadRetryConfig().maxAttempts).toBe(10);
	});
});
