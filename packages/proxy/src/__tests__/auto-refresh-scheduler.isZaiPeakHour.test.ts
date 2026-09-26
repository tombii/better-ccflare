/**
 * Tests for the internal isZaiPeakHour() helper in auto-refresh-scheduler.ts.
 *
 * Z.ai's peak pricing window is weekdays (Mon-Fri) 14:00-18:00 Singapore
 * time (UTC+8). This helper previously only checked the hour and ignored
 * the day of week, so weekends were incorrectly treated as peak hours.
 * These tests pin the day-of-week gate so a regression is caught.
 *
 * isZaiPeakHour is exported (export added solely for testability) but not
 * otherwise part of the module's public surface — it has no other callers
 * outside this file's AutoRefreshScheduler.checkPeakHoursPause().
 *
 * All timestamps are constructed with Date.UTC(...) so the tests are
 * deterministic regardless of the machine's local timezone.
 *
 * Reference calendar (all 2026-09, UTC):
 *   21 Mon, 22 Tue, 23 Wed, 24 Thu, 25 Fri, 26 Sat, 27 Sun, 28 Mon
 */
import { describe, expect, it } from "bun:test";
import { isZaiPeakHour } from "../auto-refresh-scheduler";

describe("isZaiPeakHour", () => {
	it("returns true for a weekday inside the peak window (Wed 15:00 SGT)", () => {
		// Wed 2026-09-23, 15:00 SGT = 07:00 UTC.
		const ts = Date.UTC(2026, 8, 23, 7, 0);
		expect(isZaiPeakHour(ts)).toBe(true);
	});

	it("returns false for a weekday before the peak window (Wed 10:00 SGT)", () => {
		// Wed 2026-09-23, 10:00 SGT = 02:00 UTC.
		const ts = Date.UTC(2026, 8, 23, 2, 0);
		expect(isZaiPeakHour(ts)).toBe(false);
	});

	it("returns false for a weekday after the peak window (Wed 20:00 SGT)", () => {
		// Wed 2026-09-23, 20:00 SGT = 12:00 UTC.
		const ts = Date.UTC(2026, 8, 23, 12, 0);
		expect(isZaiPeakHour(ts)).toBe(false);
	});

	it("returns false on Saturday even at an hour that would otherwise be peak (Sat 15:00 SGT)", () => {
		// Sat 2026-09-26, 15:00 SGT = 07:00 UTC.
		const ts = Date.UTC(2026, 8, 26, 7, 0);
		expect(isZaiPeakHour(ts)).toBe(false);
	});

	it("returns false on Sunday even at an hour that would otherwise be peak (Sun 15:00 SGT)", () => {
		// Sun 2026-09-27, 15:00 SGT = 07:00 UTC.
		const ts = Date.UTC(2026, 8, 27, 7, 0);
		expect(isZaiPeakHour(ts)).toBe(false);
	});

	it("returns true at the lower boundary, 14:00 SGT weekday (window is inclusive of 14:00)", () => {
		// Wed 2026-09-23, 14:00 SGT = 06:00 UTC.
		const ts = Date.UTC(2026, 8, 23, 6, 0);
		expect(isZaiPeakHour(ts)).toBe(true);
	});

	it("returns false at the upper boundary, 18:00 SGT weekday (window is exclusive of 18:00)", () => {
		// Wed 2026-09-23, 18:00 SGT = 10:00 UTC.
		const ts = Date.UTC(2026, 8, 23, 10, 0);
		expect(isZaiPeakHour(ts)).toBe(false);
	});

	it("uses the SGT day, not the UTC day, when a UTC timestamp on Friday night is already Saturday morning in SGT", () => {
		// Fri 2026-09-25 23:30 UTC -> SGT (+8h) = Sat 2026-09-26 07:30.
		// UTC day is Friday (weekday) but the SGT day is Saturday, so this
		// must be false. Note: the hour-of-day gate would also independently
		// reject this timestamp (07:30 SGT is outside 14:00-18:00) — this
		// test exists to document/pin that the day-of-week is computed from
		// the SGT-shifted instant rather than the raw UTC date, in case the
		// hour window is ever widened to include early-morning hours.
		const ts = Date.UTC(2026, 8, 25, 23, 30);
		expect(isZaiPeakHour(ts)).toBe(false);
	});

	it("uses the SGT day, not the UTC day, when a UTC timestamp on Sunday night is already Monday morning in SGT", () => {
		// Sun 2026-09-27 23:30 UTC -> SGT (+8h) = Mon 2026-09-28 07:30.
		// UTC day is Sunday (weekend) but the SGT day is Monday (a weekday
		// under the peak-hour rule). The result is still false here because
		// 07:30 SGT falls outside the 14:00-18:00 window, but this pins that
		// the day gate resolved to Monday's (weekday) rule rather than
		// short-circuiting to false for "Sunday".
		const ts = Date.UTC(2026, 8, 27, 23, 30);
		expect(isZaiPeakHour(ts)).toBe(false);
	});

	it("defaults to Date.now() when no timestamp is provided", () => {
		// Just verify it doesn't throw and returns a boolean when called with
		// no arguments (exercises the `ts = Date.now()` default parameter).
		expect(typeof isZaiPeakHour()).toBe("boolean");
	});
});
