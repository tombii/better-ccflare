/**
 * Tests for isAnthropicPeakHour() and getPeakHoursState(), the server-side
 * source of truth for the `peakHours` field served on /api/accounts.
 *
 * Reference calendar (2026-09, UTC): 23 Wed, 26 Sat
 */
import { beforeEach, describe, expect, it } from "bun:test";
import {
	getPeakHoursState,
	isAnthropicPeakHour,
} from "../auto-refresh-scheduler";
import { resetChineseHolidayCache } from "../chinese-holidays";

describe("isAnthropicPeakHour", () => {
	it("is peak on weekdays 13:00-19:00 UTC, window end exclusive", () => {
		expect(isAnthropicPeakHour(Date.UTC(2026, 8, 23, 13, 0))).toBe(true);
		expect(isAnthropicPeakHour(Date.UTC(2026, 8, 23, 18, 59))).toBe(true);
		expect(isAnthropicPeakHour(Date.UTC(2026, 8, 23, 19, 0))).toBe(false);
		expect(isAnthropicPeakHour(Date.UTC(2026, 8, 23, 12, 59))).toBe(false);
	});

	it("is off-peak on weekends", () => {
		expect(isAnthropicPeakHour(Date.UTC(2026, 8, 26, 15, 0))).toBe(false);
	});
});

describe("getPeakHoursState", () => {
	beforeEach(() => resetChineseHolidayCache());

	it("returns null for providers without a peak concept", () => {
		expect(
			getPeakHoursState("openai-compatible", Date.UTC(2026, 8, 23, 15)),
		).toBeNull();
		expect(getPeakHoursState("codex", Date.UTC(2026, 8, 23, 15))).toBeNull();
	});

	it("reports deepseek, zai and anthropic activity", () => {
		// Wed 02:00 UTC: deepseek peak only
		const t1 = Date.UTC(2026, 8, 23, 2, 0);
		expect(getPeakHoursState("deepseek", t1)).toEqual({ active: true });
		expect(getPeakHoursState("zai", t1)).toEqual({ active: false });
		expect(getPeakHoursState("anthropic", t1)).toEqual({ active: false });
		// Wed 15:00 UTC (23:00 SGT): anthropic peak only
		const t2 = Date.UTC(2026, 8, 23, 15, 0);
		expect(getPeakHoursState("anthropic", t2)).toEqual({ active: true });
		expect(getPeakHoursState("deepseek", t2)).toEqual({ active: false });
		// Wed 07:00 UTC (15:00 SGT): zai peak
		expect(getPeakHoursState("zai", Date.UTC(2026, 8, 23, 7, 0))).toEqual({
			active: true,
		});
	});

	it("honours the Chinese holiday calendar for deepseek", () => {
		// Mon 2026-02-16 (Spring Festival)
		expect(getPeakHoursState("deepseek", Date.UTC(2026, 1, 16, 2, 0))).toEqual({
			active: false,
		});
	});
});
