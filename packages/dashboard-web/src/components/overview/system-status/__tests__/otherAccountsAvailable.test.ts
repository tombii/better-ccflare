import { describe, expect, test } from "bun:test";
import { otherAccountsAvailable } from "../otherAccountsAvailable";

type Account = Parameters<typeof otherAccountsAvailable>[0][number];

const baseAccount: Account = {
	id: "acc-1",
	paused: false,
	rateLimitedUntil: null,
};

describe("otherAccountsAvailable", () => {
	test("returns true when a healthy other account exists", () => {
		const accounts: Account[] = [
			{ ...baseAccount, id: "acc-self" },
			{ ...baseAccount, id: "acc-other" },
		];
		expect(otherAccountsAvailable(accounts, "acc-self")).toBe(true);
	});

	test("excludes the error's own account", () => {
		const accounts: Account[] = [{ ...baseAccount, id: "acc-self" }];
		expect(otherAccountsAvailable(accounts, "acc-self")).toBe(false);
	});

	test("excludes paused accounts", () => {
		const accounts: Account[] = [
			{ ...baseAccount, id: "acc-self" },
			{ ...baseAccount, id: "acc-paused", paused: true },
		];
		expect(otherAccountsAvailable(accounts, "acc-self")).toBe(false);
	});

	test("excludes accounts whose rateLimitedUntil is in the future", () => {
		const future = Date.now() + 60_000;
		const accounts: Account[] = [
			{ ...baseAccount, id: "acc-self" },
			{ ...baseAccount, id: "acc-rl", rateLimitedUntil: future },
		];
		expect(otherAccountsAvailable(accounts, "acc-self")).toBe(false);
	});

	test("counts accounts whose rateLimitedUntil has already elapsed", () => {
		const past = Date.now() - 60_000;
		const accounts: Account[] = [
			{ ...baseAccount, id: "acc-self" },
			{ ...baseAccount, id: "acc-recovered", rateLimitedUntil: past },
		];
		expect(otherAccountsAvailable(accounts, "acc-self")).toBe(true);
	});

	test("treats null rateLimitedUntil as available", () => {
		const accounts: Account[] = [
			{ ...baseAccount, id: "acc-self" },
			{ ...baseAccount, id: "acc-other", rateLimitedUntil: null },
		];
		expect(otherAccountsAvailable(accounts, "acc-self")).toBe(true);
	});

	test("handles undefined accounts list as no available", () => {
		expect(otherAccountsAvailable(undefined, "acc-self")).toBe(false);
	});

	test("returns false when only paused and rate-limited accounts exist", () => {
		const future = Date.now() + 60_000;
		const accounts: Account[] = [
			{ ...baseAccount, id: "acc-self" },
			{ ...baseAccount, id: "acc-paused", paused: true },
			{ ...baseAccount, id: "acc-rl", rateLimitedUntil: future },
		];
		expect(otherAccountsAvailable(accounts, "acc-self")).toBe(false);
	});
});
