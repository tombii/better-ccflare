import { describe, expect, it } from "bun:test";
import {
	type AccountLike,
	pickDefaultAccount,
	rangeToMs,
	sortAccountsActiveFirst,
	usageEmptyStateMessage,
} from "../tab-helpers";

const H = 60 * 60 * 1000;

const acc = (
	id: string,
	name: string,
	paused?: boolean | number | null,
): AccountLike => ({ id, name, paused });

describe("pickDefaultAccount", () => {
	it("returns the first non-paused account's id", () => {
		const accounts = [
			acc("a", "A", true),
			acc("b", "B", true),
			acc("c", "C", false),
		];
		expect(pickDefaultAccount(accounts)).toBe("c");
	});

	it("falls back to the first account's id when all are paused", () => {
		const accounts = [acc("a", "A", true), acc("b", "B", true)];
		expect(pickDefaultAccount(accounts)).toBe("a");
	});

	it("returns undefined for an empty array", () => {
		expect(pickDefaultAccount([])).toBeUndefined();
	});

	it("returns undefined when accounts is undefined", () => {
		expect(pickDefaultAccount(undefined)).toBeUndefined();
	});

	it("treats numeric paused (1/0) truthiness correctly", () => {
		const accounts = [acc("a", "A", 1), acc("b", "B", 0)];
		expect(pickDefaultAccount(accounts)).toBe("b");
	});
});

describe("sortAccountsActiveFirst", () => {
	it("puts active accounts before paused ones", () => {
		const accounts = [
			acc("a", "A", true),
			acc("b", "B", false),
			acc("c", "C", true),
			acc("d", "D", false),
		];
		expect(sortAccountsActiveFirst(accounts).map((a) => a.id)).toEqual([
			"b",
			"d",
			"a",
			"c",
		]);
	});

	it("does not mutate the input array", () => {
		const accounts = [acc("a", "A", true), acc("b", "B", false)];
		const snapshot = accounts.map((a) => a.id);
		const sorted = sortAccountsActiveFirst(accounts);
		expect(accounts.map((a) => a.id)).toEqual(snapshot);
		expect(sorted).not.toBe(accounts);
	});

	it("is stable within groups (paused keep relative order)", () => {
		const accounts = [
			acc("p1", "P1", true),
			acc("p2", "P2", true),
			acc("a1", "A1", false),
		];
		expect(sortAccountsActiveFirst(accounts).map((a) => a.id)).toEqual([
			"a1",
			"p1",
			"p2",
		]);
	});
});

describe("rangeToMs", () => {
	it("maps each known range to its millisecond span", () => {
		expect(rangeToMs("1h")).toBe(H);
		expect(rangeToMs("6h")).toBe(6 * H);
		expect(rangeToMs("24h")).toBe(24 * H);
		expect(rangeToMs("7d")).toBe(7 * 24 * H);
		expect(rangeToMs("30d")).toBe(30 * 24 * H);
	});

	it("falls back to 24h for an unknown range (mirrors the endpoint)", () => {
		expect(rangeToMs("")).toBe(24 * H);
		expect(rangeToMs("bogus")).toBe(24 * H);
		expect(rangeToMs("12h")).toBe(24 * H);
	});
});

describe("usageEmptyStateMessage", () => {
	it("prompts to select an account when none is given", () => {
		expect(usageEmptyStateMessage(undefined)).toContain("Select an account");
	});

	it("explains paused accounts are not polled", () => {
		expect(usageEmptyStateMessage(acc("a", "A", true))).toContain("paused");
	});

	it("shows the collecting message for an active account", () => {
		expect(usageEmptyStateMessage(acc("a", "A", false))).toContain(
			"Collecting usage data",
		);
	});
});
