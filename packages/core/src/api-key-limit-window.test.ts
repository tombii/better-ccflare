import { describe, expect, it } from "bun:test";
import {
	API_KEY_ROLLING_DURATION_MS,
	apiKeyLimitWindowBounds,
} from "./api-key-limit-window";

const iso = (ms: number) => new Date(ms).toISOString();
describe("Dublin calendar budget windows", () => {
	it("uses Dublin summer midnight instead of UTC midnight", () => {
		const bounds = apiKeyLimitWindowBounds(
			"day",
			"calendar",
			Date.parse("2026-07-10T12:00:00Z"),
		);
		expect(iso(bounds.startMs)).toBe("2026-07-09T23:00:00.000Z");
		expect(iso(bounds.endMs)).toBe("2026-07-10T23:00:00.000Z");
	});
	it("starts weeks Monday and observes the short DST-change week", () => {
		const bounds = apiKeyLimitWindowBounds(
			"week",
			"calendar",
			Date.parse("2026-03-29T12:00:00Z"),
		);
		expect(iso(bounds.startMs)).toBe("2026-03-23T00:00:00.000Z");
		expect(iso(bounds.endMs)).toBe("2026-03-29T23:00:00.000Z");
		expect(bounds.endMs - bounds.startMs).toBe(167 * 3_600_000);
	});
	it("observes the long autumn DST-change week", () => {
		const bounds = apiKeyLimitWindowBounds(
			"week",
			"calendar",
			Date.parse("2026-10-25T12:00:00Z"),
		);
		expect(iso(bounds.startMs)).toBe("2026-10-18T23:00:00.000Z");
		expect(iso(bounds.endMs)).toBe("2026-10-26T00:00:00.000Z");
		expect(bounds.endMs - bounds.startMs).toBe(169 * 3_600_000);
	});
	it("distinguishes both autumn clock hours", () => {
		const first = apiKeyLimitWindowBounds(
			"hour",
			"calendar",
			Date.parse("2026-10-25T00:30:00Z"),
		);
		const second = apiKeyLimitWindowBounds(
			"hour",
			"calendar",
			Date.parse("2026-10-25T01:30:00Z"),
		);
		expect(iso(first.startMs)).toBe("2026-10-25T00:00:00.000Z");
		expect(first.endMs).toBe(second.startMs);
		expect(iso(second.endMs)).toBe("2026-10-25T02:00:00.000Z");
	});
	it("uses calendar-month length across DST and year boundaries", () => {
		const march = apiKeyLimitWindowBounds(
			"month",
			"calendar",
			Date.parse("2026-03-15T12:00:00Z"),
		);
		expect(iso(march.endMs)).toBe("2026-03-31T23:00:00.000Z");
		const december = apiKeyLimitWindowBounds(
			"month",
			"calendar",
			Date.parse("2026-12-15T12:00:00Z"),
		);
		expect(iso(december.endMs)).toBe("2027-01-01T00:00:00.000Z");
	});
	it("counts exactly 60min/24h/7d/30d for rolling mode across DST", () => {
		const now = Date.parse("2026-03-29T12:00:00Z");
		for (const window of ["hour", "day", "week", "month"] as const) {
			const bounds = apiKeyLimitWindowBounds(window, "rolling", now);
			expect(now - bounds.startMs).toBe(API_KEY_ROLLING_DURATION_MS[window]);
		}
	});
});
