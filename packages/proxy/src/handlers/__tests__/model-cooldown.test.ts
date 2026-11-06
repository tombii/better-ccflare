import { beforeEach, describe, expect, it } from "bun:test";
import {
	clearModelCooldownsForAccount,
	DEFAULT_MODEL_COOLDOWN_TTL_MS,
	getModelCooldownUntil,
	isModelCooling,
	MAX_MODEL_COOLDOWN_MS,
	markModelCooling,
	resetModelCooldownsForTests,
} from "../model-cooldown";

const NOW = Date.UTC(2026, 10, 3, 12, 0, 0);
const MINUTE = 60 * 1000;

beforeEach(() => {
	resetModelCooldownsForTests();
});

describe("markModelCooling / isModelCooling", () => {
	it("marks a model cooling until the given time and expires at the boundary", () => {
		markModelCooling("accountA", "deepseek-v4.1-flash", NOW + 10 * MINUTE, NOW);

		expect(isModelCooling("accountA", "deepseek-v4.1-flash", NOW)).toBe(true);
		expect(
			isModelCooling("accountA", "deepseek-v4.1-flash", NOW + 10 * MINUTE - 1),
		).toBe(true);
		// `until <= now` is expired.
		expect(
			isModelCooling("accountA", "deepseek-v4.1-flash", NOW + 10 * MINUTE),
		).toBe(false);
	});

	it("stays expired (and deleted) on repeated reads", () => {
		markModelCooling("accountA", "m", NOW + MINUTE, NOW);

		expect(isModelCooling("accountA", "m", NOW + MINUTE)).toBe(false);
		expect(isModelCooling("accountA", "m", NOW + MINUTE)).toBe(false);
	});

	it("returns false for a model that was never marked", () => {
		expect(isModelCooling("accountA", "never-seen", NOW)).toBe(false);
	});

	it("falls back to the default TTL when untilMs is undefined", () => {
		markModelCooling("accountA", "m", undefined, NOW);

		expect(
			isModelCooling("accountA", "m", NOW + DEFAULT_MODEL_COOLDOWN_TTL_MS - 1),
		).toBe(true);
		expect(
			isModelCooling("accountA", "m", NOW + DEFAULT_MODEL_COOLDOWN_TTL_MS),
		).toBe(false);
	});

	it("falls back to the default TTL when untilMs is null", () => {
		markModelCooling("accountA", "m", null, NOW);

		expect(
			isModelCooling("accountA", "m", NOW + DEFAULT_MODEL_COOLDOWN_TTL_MS - 1),
		).toBe(true);
		expect(
			isModelCooling("accountA", "m", NOW + DEFAULT_MODEL_COOLDOWN_TTL_MS),
		).toBe(false);
	});

	it("falls back to the default TTL when untilMs is already in the past", () => {
		markModelCooling("accountA", "m", NOW - MINUTE, NOW);

		expect(isModelCooling("accountA", "m", NOW)).toBe(true);
		expect(
			isModelCooling("accountA", "m", NOW + DEFAULT_MODEL_COOLDOWN_TTL_MS),
		).toBe(false);
	});

	it("honours a future untilMs", () => {
		const until = NOW + 3 * 24 * 60 * MINUTE;
		markModelCooling("accountA", "m", until, NOW);

		expect(isModelCooling("accountA", "m", until - 1)).toBe(true);
		expect(isModelCooling("accountA", "m", until)).toBe(false);
	});

	it("caps a far-future untilMs at MAX_MODEL_COOLDOWN_MS", () => {
		markModelCooling("accountA", "m", NOW + MAX_MODEL_COOLDOWN_MS * 2, NOW);

		expect(
			isModelCooling("accountA", "m", NOW + MAX_MODEL_COOLDOWN_MS - 1),
		).toBe(true);
		expect(isModelCooling("accountA", "m", NOW + MAX_MODEL_COOLDOWN_MS)).toBe(
			false,
		);
	});

	it("keys cooldowns per account", () => {
		markModelCooling("accountA", "deepseek-v4.1-flash", NOW + MINUTE, NOW);

		expect(isModelCooling("accountA", "deepseek-v4.1-flash", NOW)).toBe(true);
		expect(isModelCooling("accountB", "deepseek-v4.1-flash", NOW)).toBe(false);
	});

	it("strips the routing suffix so a suffixed mark and a bare query share a key", () => {
		markModelCooling(
			"accountA",
			'deepseek-v4.1-flash {"only":["deepseek"]}',
			NOW + MINUTE,
			NOW,
		);

		expect(isModelCooling("accountA", "deepseek-v4.1-flash", NOW)).toBe(true);
	});

	it("normalizes the queried model too", () => {
		markModelCooling("accountA", "deepseek-v4.1-flash", NOW + MINUTE, NOW);

		expect(
			isModelCooling(
				"accountA",
				' deepseek-v4.1-flash {"only":["deepseek"]} ',
				NOW,
			),
		).toBe(true);
	});
});

describe("getModelCooldownUntil", () => {
	it("returns the exact deadline for a marked future cooldown", () => {
		const until = NOW + 10 * MINUTE;
		markModelCooling("accountA", "m", until, NOW);

		expect(getModelCooldownUntil("accountA", "m", NOW)).toBe(until);
		expect(getModelCooldownUntil("accountA", "m", until - 1)).toBe(until);
	});

	it("returns null and removes the entry once expired", () => {
		const until = NOW + MINUTE;
		markModelCooling("accountA", "m", until, NOW);

		expect(getModelCooldownUntil("accountA", "m", until)).toBeNull();
		// The expired entry was deleted, not merely hidden: re-reading after a
		// clock rollback must not resurrect the old deadline.
		expect(getModelCooldownUntil("accountA", "m", NOW)).toBeNull();
	});

	it("respects the default 5-min TTL when marked with no until", () => {
		markModelCooling("accountA", "m", undefined, NOW);

		expect(getModelCooldownUntil("accountA", "m", NOW)).toBe(
			NOW + DEFAULT_MODEL_COOLDOWN_TTL_MS,
		);
		expect(
			getModelCooldownUntil(
				"accountA",
				"m",
				NOW + DEFAULT_MODEL_COOLDOWN_TTL_MS,
			),
		).toBeNull();
	});

	it("returns null for a model that was never marked", () => {
		expect(getModelCooldownUntil("accountA", "never-seen", NOW)).toBeNull();
	});
});

describe("clearModelCooldownsForAccount", () => {
	it("removes only the named account's entries", () => {
		markModelCooling("accountA", "m1", NOW + MINUTE, NOW);
		markModelCooling("accountA", "m2", NOW + MINUTE, NOW);
		markModelCooling("accountB", "m1", NOW + MINUTE, NOW);

		clearModelCooldownsForAccount("accountA");

		expect(isModelCooling("accountA", "m1", NOW)).toBe(false);
		expect(isModelCooling("accountA", "m2", NOW)).toBe(false);
		expect(isModelCooling("accountB", "m1", NOW)).toBe(true);
	});
});

describe("resetModelCooldownsForTests", () => {
	it("clears every account's entries", () => {
		markModelCooling("accountA", "m", NOW + MINUTE, NOW);
		markModelCooling("accountB", "m", NOW + MINUTE, NOW);

		resetModelCooldownsForTests();

		expect(isModelCooling("accountA", "m", NOW)).toBe(false);
		expect(isModelCooling("accountB", "m", NOW)).toBe(false);
	});
});
