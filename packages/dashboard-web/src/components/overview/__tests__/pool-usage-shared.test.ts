import { describe, expect, it } from "bun:test";
import { formatShortDuration, shouldShowNextBadge } from "../pool-usage-shared";

describe("formatShortDuration", () => {
	it("formats sub-minute durations as seconds", () => {
		expect(formatShortDuration(12_000)).toBe("12s");
	});

	it("formats 0ms as 0s", () => {
		expect(formatShortDuration(0)).toBe("0s");
	});

	it("rounds sub-minute durations to the nearest second", () => {
		expect(formatShortDuration(12_400)).toBe("12s");
		expect(formatShortDuration(12_600)).toBe("13s");
	});

	it("stays in the minutes-only branch once rounded to >= 1 minute", () => {
		// 3 minutes exactly.
		expect(formatShortDuration(180_000)).toBe("3m");
	});

	it("formats hours + minutes for durations >= 1 hour", () => {
		// 2h 5m.
		expect(formatShortDuration(2 * 60 * 60 * 1000 + 5 * 60 * 1000)).toBe(
			"2h 5m",
		);
	});

	it("preserves pre-existing minute-rounding behavior at the 30s boundary", () => {
		// 30000ms rounds to 1 minute under Math.round(ms / 60000) -- must stay
		// "1m", not fall into the new seconds branch.
		expect(formatShortDuration(30_000)).toBe("1m");
	});

	it("takes the seconds branch just below the 30s boundary", () => {
		expect(formatShortDuration(29_999)).toBe("30s");
	});
});

describe("shouldShowNextBadge", () => {
	it("never shows when the segment is not primary", () => {
		expect(shouldShowNextBadge("five_hour", "active", false)).toBe(false);
		expect(shouldShowNextBadge("weekly_scoped", "active", false)).toBe(false);
	});

	it("suppresses the badge on weekly_scoped rows even for the primary account (observed line replaces it)", () => {
		expect(shouldShowNextBadge("weekly_scoped", "active", true)).toBe(false);
	});

	it("suppresses the badge when the primary segment is exhausted, in any window", () => {
		expect(shouldShowNextBadge("five_hour", "exhausted", true)).toBe(false);
		expect(shouldShowNextBadge("seven_day", "exhausted", true)).toBe(false);
		expect(shouldShowNextBadge("weekly_scoped", "exhausted", true)).toBe(false);
	});

	it("shows for a primary, non-exhausted segment in five_hour/seven_day windows", () => {
		expect(shouldShowNextBadge("five_hour", "active", true)).toBe(true);
		expect(shouldShowNextBadge("seven_day", "active", true)).toBe(true);
		expect(shouldShowNextBadge("five_hour", "unknown", true)).toBe(true);
	});
});
