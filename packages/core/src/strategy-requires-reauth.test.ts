import { describe, expect, it } from "bun:test";
import type { Account } from "@better-ccflare/types";
import { isAccountAvailable, isUsageExhausted } from "./strategy";

function account(requiresReauth: boolean): Account {
	return {
		paused: false,
		requires_reauth: requiresReauth,
		rate_limited_until: null,
	} as Account;
}

describe("isAccountAvailable requires_reauth", () => {
	it("excludes an account that requires manual authentication", () => {
		expect(isAccountAvailable(account(true))).toBe(false);
	});

	it("keeps an otherwise healthy account available", () => {
		expect(isAccountAvailable(account(false))).toBe(true);
	});
});

describe("isAccountAvailable usage exhaustion", () => {
	const now = Date.UTC(2026, 6, 27, 12);

	it("excludes an account capped until a future reset", () => {
		expect(
			isAccountAvailable(account(false), now, {
				utilization: 100,
				resetMs: now + 60_000,
			}),
		).toBe(false);
	});

	it("makes a capped account eligible again after its reset", () => {
		expect(
			isAccountAvailable(account(false), now, {
				utilization: 100,
				resetMs: now - 1,
			}),
		).toBe(true);
	});

	it("does not claim exhaustion from a stale snapshot with a past reset", () => {
		expect(isUsageExhausted(100, now - 1, now)).toBe(false);
	});
});
