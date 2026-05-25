import { describe, expect, it } from "bun:test";
import { effectiveBurnRateDays } from "../analytics";

const DAY = 24 * 60 * 60 * 1000;
const NOW = 1_700_000_000_000;

describe("effectiveBurnRateDays", () => {
	it("returns the full window when there is no data", () => {
		expect(effectiveBurnRateDays(null, NOW - 7 * DAY, 7, NOW)).toBe(7);
		expect(effectiveBurnRateDays(null, NOW - 30 * DAY, 30, NOW)).toBe(30);
	});

	it("returns the full window when history extends back to (or past) the window start", () => {
		expect(effectiveBurnRateDays(NOW - 9 * DAY, NOW - 7 * DAY, 7, NOW)).toBe(7);
		expect(effectiveBurnRateDays(NOW - 7 * DAY, NOW - 7 * DAY, 7, NOW)).toBe(7);
		expect(effectiveBurnRateDays(NOW - 60 * DAY, NOW - 30 * DAY, 30, NOW)).toBe(
			30,
		);
	});

	it("clamps to the actual age of the data when history is thinner than the window", () => {
		// 5 full days of data, 7d window → divide by 5, not 7
		expect(effectiveBurnRateDays(NOW - 5 * DAY, NOW - 7 * DAY, 7, NOW)).toBe(5);
		// 5 full days of data, 30d window → divide by 5, not 30
		expect(effectiveBurnRateDays(NOW - 5 * DAY, NOW - 30 * DAY, 30, NOW)).toBe(
			5,
		);
	});

	it("rounds a partial first day up to a whole day and clamps to a minimum of 1", () => {
		// First row 30 minutes ago — Avg/day should not divide by 0.02 days
		expect(
			effectiveBurnRateDays(NOW - 30 * 60 * 1000, NOW - 7 * DAY, 7, NOW),
		).toBe(1);
		// First row 25 hours ago → 2 days (ceil)
		expect(
			effectiveBurnRateDays(NOW - 25 * 60 * 60 * 1000, NOW - 7 * DAY, 7, NOW),
		).toBe(2);
	});

	it("matches the weekly-from-30d use case under thin history", () => {
		// Five days of data with $8000 total plan cost.
		// 30d weekly = (sum / effectiveDays) * 7 = (8000 / 5) * 7 = 11200
		const planCost30d = 8000;
		const firstPlanTs = NOW - 5 * DAY;
		const divisor = effectiveBurnRateDays(firstPlanTs, NOW - 30 * DAY, 30, NOW);
		const weekly = (planCost30d / divisor) * 7;
		expect(divisor).toBe(5);
		expect(weekly).toBe(11200);
	});
});
