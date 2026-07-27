import { describe, expect, it } from "bun:test";
import type { Account } from "@better-ccflare/types";
import { isAccountAvailable } from "./strategy";

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
