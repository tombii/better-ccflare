/**
 * Window boundary maths for per-API-key spend limits.
 *
 * Every bound is computed in JavaScript and compared against an epoch-ms
 * `timestamp` column, so these are the only place the semantics of
 * "rolling_7d", "rolling_30d" and "calendar_month" are actually decided.
 */
import { describe, expect, it } from "bun:test";
import {
	calendarMonthEndMs,
	calendarMonthStartMs,
	computeSpendWindowResetMs,
	computeSpendWindowStartMs,
	ROLLING_SPEND_WINDOW_DURATION_MS,
	spendWindowInstanceKey,
} from "./spend-window";

const DAY = 24 * 60 * 60 * 1000;

describe("computeSpendWindowStartMs — rolling windows", () => {
	const NOW = Date.UTC(2026, 5, 15, 12, 34, 56, 789);

	it("rolling_7d starts exactly 7 days back", () => {
		expect(computeSpendWindowStartMs("rolling_7d", NOW)).toBe(NOW - 7 * DAY);
	});

	it("rolling_30d starts exactly 30 days back", () => {
		expect(computeSpendWindowStartMs("rolling_30d", NOW)).toBe(NOW - 30 * DAY);
	});

	it("slides with now rather than snapping to a boundary", () => {
		const later = NOW + 5 * 60 * 1000;
		expect(computeSpendWindowStartMs("rolling_7d", later)).toBe(
			computeSpendWindowStartMs("rolling_7d", NOW) + 5 * 60 * 1000,
		);
	});

	it("never falls back to all-time for an unknown window", () => {
		// parseSpendWindow normalises unknown values long before this, but a
		// window that resolved to "everything ever" would refuse a key forever.
		const start = computeSpendWindowStartMs("not_a_window" as never, NOW);
		expect(start).toBe(NOW - ROLLING_SPEND_WINDOW_DURATION_MS.rolling_30d);
	});
});

describe("computeSpendWindowStartMs — calendar_month", () => {
	it("starts at midnight UTC on the 1st of the current month", () => {
		const now = Date.UTC(2026, 5, 15, 12, 0, 0, 0); // 15 June 2026
		expect(computeSpendWindowStartMs("calendar_month", now)).toBe(
			Date.UTC(2026, 5, 1, 0, 0, 0, 0),
		);
	});

	it("handles a 28-day February", () => {
		const now = Date.UTC(2026, 1, 20, 8, 0, 0, 0); // 20 Feb 2026 (not a leap year)
		const start = computeSpendWindowStartMs("calendar_month", now);
		expect(start).toBe(Date.UTC(2026, 1, 1));
		expect(calendarMonthEndMs(now) - start).toBe(28 * DAY);
	});

	it("handles a 29-day February in a leap year", () => {
		const now = Date.UTC(2028, 1, 20, 8, 0, 0, 0); // 2028 is a leap year
		const start = computeSpendWindowStartMs("calendar_month", now);
		expect(start).toBe(Date.UTC(2028, 1, 1));
		expect(calendarMonthEndMs(now) - start).toBe(29 * DAY);
	});

	it("crosses a month end: 31 Jan and 1 Feb are different windows", () => {
		const janLast = Date.UTC(2026, 0, 31, 23, 59, 59, 999);
		const febFirst = Date.UTC(2026, 1, 1, 0, 0, 0, 0);
		expect(computeSpendWindowStartMs("calendar_month", janLast)).toBe(
			Date.UTC(2026, 0, 1),
		);
		expect(computeSpendWindowStartMs("calendar_month", febFirst)).toBe(
			Date.UTC(2026, 1, 1),
		);
		expect(spendWindowInstanceKey("calendar_month", janLast)).not.toBe(
			spendWindowInstanceKey("calendar_month", febFirst),
		);
	});

	it("crosses a year end: 31 Dec and 1 Jan are different windows", () => {
		const decLast = Date.UTC(2026, 11, 31, 23, 59, 59, 999);
		const janFirst = Date.UTC(2027, 0, 1, 0, 0, 0, 0);
		expect(computeSpendWindowStartMs("calendar_month", decLast)).toBe(
			Date.UTC(2026, 11, 1),
		);
		expect(calendarMonthEndMs(decLast)).toBe(Date.UTC(2027, 0, 1));
		expect(computeSpendWindowStartMs("calendar_month", janFirst)).toBe(
			Date.UTC(2027, 0, 1),
		);
		expect(spendWindowInstanceKey("calendar_month", decLast)).toBe(
			"calendar_month:2026-12",
		);
		expect(spendWindowInstanceKey("calendar_month", janFirst)).toBe(
			"calendar_month:2027-1",
		);
	});

	it("start and end agree with the standalone helpers", () => {
		for (const month of [0, 1, 3, 6, 11]) {
			const now = Date.UTC(2026, month, 14, 7, 0, 0, 0);
			expect(computeSpendWindowStartMs("calendar_month", now)).toBe(
				calendarMonthStartMs(now),
			);
			expect(calendarMonthEndMs(now)).toBeGreaterThan(
				calendarMonthStartMs(now),
			);
		}
	});
});

describe("computeSpendWindowResetMs", () => {
	it("calendar_month resets at the start of next month, ignoring oldest spend", () => {
		const now = Date.UTC(2026, 5, 15, 12, 0, 0, 0);
		expect(computeSpendWindowResetMs("calendar_month", now, null)).toBe(
			Date.UTC(2026, 6, 1),
		);
		expect(computeSpendWindowResetMs("calendar_month", now, now - DAY)).toBe(
			Date.UTC(2026, 6, 1),
		);
	});

	it("calendar_month in December resets in January of the next year", () => {
		const now = Date.UTC(2026, 11, 20);
		expect(computeSpendWindowResetMs("calendar_month", now, null)).toBe(
			Date.UTC(2027, 0, 1),
		);
	});

	it("a rolling window relieves when its oldest counted request ages out", () => {
		const now = Date.UTC(2026, 5, 15);
		const oldest = now - 6 * DAY;
		expect(computeSpendWindowResetMs("rolling_7d", now, oldest)).toBe(
			oldest + 7 * DAY,
		);
		expect(computeSpendWindowResetMs("rolling_30d", now, oldest)).toBe(
			oldest + 30 * DAY,
		);
	});

	it("a rolling window with no counted spend has an UNKNOWN reset, not zero", () => {
		const now = Date.UTC(2026, 5, 15);
		// null must not be read as "now" (retry immediately, hammering) or as
		// "never" (a client told to give up on a window that does clear).
		expect(computeSpendWindowResetMs("rolling_7d", now, null)).toBeNull();
		expect(
			computeSpendWindowResetMs("rolling_30d", now, Number.NaN),
		).toBeNull();
	});
});

describe("spendWindowInstanceKey", () => {
	it("is constant for a rolling window — it slides, it has no instances", () => {
		const a = Date.UTC(2026, 0, 31);
		const b = Date.UTC(2026, 1, 1);
		expect(spendWindowInstanceKey("rolling_7d", a)).toBe(
			spendWindowInstanceKey("rolling_7d", b),
		);
		expect(spendWindowInstanceKey("rolling_30d", a)).toBe("rolling_30d");
	});

	it("changes for calendar_month exactly at the month boundary", () => {
		const justBefore = Date.UTC(2026, 2, 31, 23, 59, 59, 999);
		const justAfter = Date.UTC(2026, 3, 1, 0, 0, 0, 0);
		expect(spendWindowInstanceKey("calendar_month", justBefore)).toBe(
			"calendar_month:2026-3",
		);
		expect(spendWindowInstanceKey("calendar_month", justAfter)).toBe(
			"calendar_month:2026-4",
		);
	});
});
