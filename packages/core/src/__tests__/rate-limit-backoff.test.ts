import { describe, expect, it } from "bun:test";
import {
	computeRateLimitBackoffMs,
	TIME_CONSTANTS,
} from "@better-ccflare/core";

const BASE = TIME_CONSTANTS.RATE_LIMIT_BACKOFF_BASE_MS; // 30_000
const MAX = TIME_CONSTANTS.RATE_LIMIT_BACKOFF_MAX_MS; // 300_000

/**
 * Helper to set an env var, run a body, then restore the original value.
 * Restores to undefined (deletes the key) if it wasn't set originally.
 */
function withEnv(
	key: string,
	value: string | undefined,
	body: () => void,
): void {
	const original = process.env[key];
	if (value === undefined) {
		delete process.env[key];
	} else {
		process.env[key] = value;
	}
	try {
		body();
	} finally {
		if (original === undefined) {
			delete process.env[key];
		} else {
			process.env[key] = original;
		}
	}
}

describe("computeRateLimitBackoffMs", () => {
	it("returns BASE for n=1 (first 429 in the streak)", () => {
		expect(computeRateLimitBackoffMs(1)).toBe(BASE);
	});

	it("returns 2*BASE for n=2", () => {
		expect(computeRateLimitBackoffMs(2)).toBe(2 * BASE);
	});

	it("returns 4*BASE for n=3", () => {
		expect(computeRateLimitBackoffMs(3)).toBe(4 * BASE);
	});

	it("caps at MAX once the exponential ramp would exceed it (n=5)", () => {
		// 16 * 30_000 = 480_000 > MAX (300_000), so it must be clamped to MAX
		expect(computeRateLimitBackoffMs(5)).toBe(MAX);
	});

	it("returns MAX for very large n (n=100) without overflowing", () => {
		const result = computeRateLimitBackoffMs(100);
		expect(result).toBe(MAX);
		expect(Number.isFinite(result)).toBe(true);
	});

	it("clamps n=0 to n=1 (returns BASE)", () => {
		expect(computeRateLimitBackoffMs(0)).toBe(BASE);
	});

	it("clamps negative n to n=1 (returns BASE)", () => {
		expect(computeRateLimitBackoffMs(-5)).toBe(BASE);
	});

	it("defends against env BASE=0 (returns 1000 floor)", () => {
		withEnv("CCFLARE_RATE_LIMIT_BACKOFF_BASE_MS", "0", () => {
			expect(computeRateLimitBackoffMs(1)).toBe(1000);
		});
	});

	it("defends against env BASE=negative (returns 1000 floor)", () => {
		withEnv("CCFLARE_RATE_LIMIT_BACKOFF_BASE_MS", "-9999", () => {
			expect(computeRateLimitBackoffMs(1)).toBe(1000);
		});
	});
});
