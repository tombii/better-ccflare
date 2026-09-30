/**
 * Tests for isDeepseekPeakHour() in auto-refresh-scheduler.ts.
 *
 * DeepSeek peak hours are 01:00-04:00 and 06:00-10:00 UTC, Monday-Friday,
 * excluding Chinese public holidays. All other hours are off-peak, including
 * weekends and Chinese public holidays in full.
 *
 * Reference calendar (2026-09, UTC): 21 Mon, 22 Tue, 23 Wed, 26 Sat, 27 Sun
 */
import { describe, expect, it } from "bun:test";
import { isDeepseekPeakHour } from "../auto-refresh-scheduler";
import {
	refreshChineseHolidays,
	resetChineseHolidayCache,
} from "../chinese-holidays";

describe("isDeepseekPeakHour", () => {
	it("is peak inside the first window (Wed 02:00 UTC)", () => {
		expect(isDeepseekPeakHour(Date.UTC(2026, 8, 23, 2, 0))).toBe(true);
	});

	it("is peak inside the second window (Wed 08:30 UTC)", () => {
		expect(isDeepseekPeakHour(Date.UTC(2026, 8, 23, 8, 30))).toBe(true);
	});

	it("includes window starts and excludes window ends", () => {
		expect(isDeepseekPeakHour(Date.UTC(2026, 8, 23, 1, 0))).toBe(true);
		expect(isDeepseekPeakHour(Date.UTC(2026, 8, 23, 4, 0))).toBe(false);
		expect(isDeepseekPeakHour(Date.UTC(2026, 8, 23, 6, 0))).toBe(true);
		expect(isDeepseekPeakHour(Date.UTC(2026, 8, 23, 10, 0))).toBe(false);
	});

	it("is off-peak between and outside the windows", () => {
		expect(isDeepseekPeakHour(Date.UTC(2026, 8, 23, 0, 59))).toBe(false);
		expect(isDeepseekPeakHour(Date.UTC(2026, 8, 23, 5, 0))).toBe(false);
		expect(isDeepseekPeakHour(Date.UTC(2026, 8, 23, 15, 0))).toBe(false);
	});

	it("is off-peak on weekends", () => {
		expect(isDeepseekPeakHour(Date.UTC(2026, 8, 26, 2, 0))).toBe(false);
		expect(isDeepseekPeakHour(Date.UTC(2026, 8, 27, 8, 0))).toBe(false);
	});

	it("is off-peak on a Chinese public holiday falling on a weekday", () => {
		// Wed 2026-09-... no; use Mon 2026-02-16 (Spring Festival) and Wed 2026-10-07
		expect(isDeepseekPeakHour(Date.UTC(2026, 1, 16, 2, 0))).toBe(false);
		expect(isDeepseekPeakHour(Date.UTC(2026, 9, 7, 8, 0))).toBe(false);
	});

	it("is peak on the first working day after a holiday", () => {
		// Fri 2026-10-09 is a normal workday after National Day
		expect(isDeepseekPeakHour(Date.UTC(2026, 9, 8, 8, 0))).toBe(true);
	});
});

describe("holiday feed", () => {
	const feedResponse = (days: unknown) =>
		(async () => Response.json({ days })) as unknown as typeof fetch;

	it("uses feed data for a fetched year and ignores make-up workdays", async () => {
		resetChineseHolidayCache();
		await refreshChineseHolidays(
			[2027],
			feedResponse([
				{ name: "x", date: "2027-03-10", isOffDay: true },
				{ name: "x", date: "2027-03-13", isOffDay: false },
			]),
		);
		// Wed 2027-03-10 is a feed holiday -> off-peak
		expect(isDeepseekPeakHour(Date.UTC(2027, 2, 10, 2, 0))).toBe(false);
		// Thu 2027-03-11 not in feed -> peak
		expect(isDeepseekPeakHour(Date.UTC(2027, 2, 11, 2, 0))).toBe(true);
		resetChineseHolidayCache();
	});

	it("keeps embedded data when the fetch fails", async () => {
		resetChineseHolidayCache();
		await refreshChineseHolidays([2026], (async () => {
			throw new Error("offline");
		}) as unknown as typeof fetch);
		expect(isDeepseekPeakHour(Date.UTC(2026, 1, 16, 2, 0))).toBe(false);
	});

	it("keeps embedded data on a non-OK response", async () => {
		resetChineseHolidayCache();
		await refreshChineseHolidays(
			[2026],
			(async () =>
				new Response("nf", { status: 404 })) as unknown as typeof fetch,
		);
		expect(isDeepseekPeakHour(Date.UTC(2026, 1, 16, 2, 0))).toBe(false);
	});
});
