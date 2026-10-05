import { afterEach, describe, expect, it } from "bun:test";
import { isUseExtraUsageEnabled, setUseExtraUsage } from "./extra-usage";
import { isAccountAvailable, isUsageExhausted } from "./strategy";

const NOW = 1_800_000_000_000;
const FUTURE = NOW + 60 * 60 * 1000;

afterEach(() => {
	setUseExtraUsage(false);
});

describe("use extra usage switch", () => {
	it("is off by default: extra usage is billed, so spending it must be chosen", () => {
		expect(isUseExtraUsageEnabled()).toBe(false);
	});

	it("mirrors whatever the config pushes in", () => {
		setUseExtraUsage(true);
		expect(isUseExtraUsageEnabled()).toBe(true);
		setUseExtraUsage(false);
		expect(isUseExtraUsageEnabled()).toBe(false);
	});
});

describe("isUsageExhausted with extra usage", () => {
	it("still reports a spent window as exhausted when no extra usage is available", () => {
		expect(isUsageExhausted(100, FUTURE, NOW)).toBe(true);
		expect(isUsageExhausted(100, FUTURE, NOW, false)).toBe(true);
	});

	it("does not report a spent window as exhausted while extra usage can serve it", () => {
		expect(isUsageExhausted(100, FUTURE, NOW, true)).toBe(false);
		expect(isUsageExhausted(130, null, NOW, true)).toBe(false);
	});

	it("leaves a window with headroom alone either way", () => {
		expect(isUsageExhausted(42, FUTURE, NOW, false)).toBe(false);
		expect(isUsageExhausted(42, FUTURE, NOW, true)).toBe(false);
	});
});

describe("isAccountAvailable with extra usage", () => {
	const account = {
		requires_reauth: false,
		paused: false,
		rate_limited_until: null,
	} as unknown as Parameters<typeof isAccountAvailable>[0];

	it("keeps an account whose window is spent but whose extra usage can serve it", () => {
		expect(
			isAccountAvailable(account, NOW, {
				utilization: 100,
				resetMs: FUTURE,
				extraUsageAvailable: true,
			}),
		).toBe(true);
	});

	it("still excludes the same account when extra usage is not available", () => {
		expect(
			isAccountAvailable(account, NOW, { utilization: 100, resetMs: FUTURE }),
		).toBe(false);
	});

	it("never lets extra usage override a pause or a cooldown", () => {
		const usage = {
			utilization: 100,
			resetMs: FUTURE,
			extraUsageAvailable: true,
		};
		expect(
			isAccountAvailable(
				{ ...account, paused: true } as typeof account,
				NOW,
				usage,
			),
		).toBe(false);
		expect(
			isAccountAvailable(
				{ ...account, rate_limited_until: FUTURE } as typeof account,
				NOW,
				usage,
			),
		).toBe(false);
	});
});
