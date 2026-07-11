import { describe, expect, it } from "bun:test";
import {
	computeWindowStartMs,
	FIXED_WINDOW_DURATION_MS,
} from "@better-ccflare/core";

const RESET = 1_700_000_000_000;
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const SEVEN_DAYS = 7 * DAY;

describe("computeWindowStartMs", () => {
	it("computes start for explicitly-listed fixed windows", () => {
		expect(computeWindowStartMs(RESET, "five_hour")).toBe(RESET - 5 * HOUR);
		expect(computeWindowStartMs(RESET, "seven_day")).toBe(RESET - SEVEN_DAYS);
		expect(computeWindowStartMs(RESET, "seven_day_opus")).toBe(
			RESET - SEVEN_DAYS,
		);
		expect(computeWindowStartMs(RESET, "seven_day_sonnet")).toBe(
			RESET - SEVEN_DAYS,
		);
		expect(computeWindowStartMs(RESET, "daily")).toBe(RESET - DAY);
		expect(computeWindowStartMs(RESET, "tokens_limit")).toBe(RESET - 5 * HOUR);
	});

	it("treats any unlisted seven_day_* tier as a 7-day window (Fable + future tiers)", () => {
		expect(computeWindowStartMs(RESET, "seven_day_fable")).toBe(
			RESET - SEVEN_DAYS,
		);
		expect(computeWindowStartMs(RESET, "seven_day_future_model")).toBe(
			RESET - SEVEN_DAYS,
		);
	});

	it("stays generic — no per-tier fable entry added to the duration table", () => {
		expect(FIXED_WINDOW_DURATION_MS.seven_day_fable).toBeUndefined();
	});

	it("computes monthly start from the preceding month's actual duration", () => {
		// reset at 2023-03-01 UTC → preceding month is February 2023 (28 days)
		const marchFirst = Date.UTC(2023, 2, 1);
		const febDuration = Date.UTC(2023, 2, 1) - Date.UTC(2023, 1, 1);
		expect(computeWindowStartMs(marchFirst, "monthly")).toBe(
			marchFirst - febDuration,
		);
	});

	it("returns null for unknown non-weekly windows", () => {
		expect(computeWindowStartMs(RESET, "totally_unknown")).toBeNull();
		// time_limit is intentionally omitted (ZAI duration unknown)
		expect(computeWindowStartMs(RESET, "time_limit")).toBeNull();
	});

	it("returns null for non-finite resetMs", () => {
		expect(computeWindowStartMs(Number.NaN, "seven_day")).toBeNull();
		expect(
			computeWindowStartMs(Number.POSITIVE_INFINITY, "seven_day_fable"),
		).toBeNull();
	});
});
