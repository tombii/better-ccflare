import { describe, expect, it } from "bun:test";
import {
	evaluateUsagePause,
	parseUsagePauseThreshold,
	readUsageUtilization,
	USAGE_THRESHOLD_PAUSE_REASON,
} from "./usage-threshold";

const NO_THRESHOLDS = { fiveHour: null, weekly: null };

describe("parseUsagePauseThreshold", () => {
	it("accepts whole percentages from 1 to 100", () => {
		expect(parseUsagePauseThreshold(1)).toBe(1);
		expect(parseUsagePauseThreshold(80)).toBe(80);
		expect(parseUsagePauseThreshold(100)).toBe(100);
	});

	it("reads numeric strings, so a form field can be handed over as-is", () => {
		expect(parseUsagePauseThreshold("80")).toBe(80);
	});

	it("treats null, undefined and empty string as 'no threshold'", () => {
		expect(parseUsagePauseThreshold(null)).toBeNull();
		expect(parseUsagePauseThreshold(undefined)).toBeNull();
		expect(parseUsagePauseThreshold("")).toBeNull();
	});

	it("rejects out-of-range, fractional and non-numeric values", () => {
		expect(() => parseUsagePauseThreshold(0)).toThrow();
		expect(() => parseUsagePauseThreshold(101)).toThrow();
		expect(() => parseUsagePauseThreshold(-5)).toThrow();
		expect(() => parseUsagePauseThreshold(80.5)).toThrow();
		expect(() => parseUsagePauseThreshold("eighty")).toThrow();
		expect(() => parseUsagePauseThreshold(Number.NaN)).toThrow();
	});
});

describe("evaluateUsagePause", () => {
	it("does nothing when no threshold is configured", () => {
		expect(
			evaluateUsagePause({
				thresholds: NO_THRESHOLDS,
				utilization: { fiveHour: 99, weekly: 99 },
				paused: false,
				pauseReason: null,
			}),
		).toStrictEqual({ action: "none" });
	});

	it("pauses once the 5-hour window reaches its threshold", () => {
		expect(
			evaluateUsagePause({
				thresholds: { fiveHour: 80, weekly: null },
				utilization: { fiveHour: 80, weekly: 10 },
				paused: false,
				pauseReason: null,
			}),
		).toStrictEqual({
			action: "pause",
			window: "five_hour",
			utilization: 80,
			threshold: 80,
		});
	});

	it("pauses once the weekly window reaches its threshold", () => {
		expect(
			evaluateUsagePause({
				thresholds: { fiveHour: null, weekly: 90 },
				utilization: { fiveHour: 5, weekly: 93 },
				paused: false,
				pauseReason: null,
			}),
		).toStrictEqual({
			action: "pause",
			window: "weekly",
			utilization: 93,
			threshold: 90,
		});
	});

	it("reports the 5-hour window first when both windows are over", () => {
		const decision = evaluateUsagePause({
			thresholds: { fiveHour: 50, weekly: 50 },
			utilization: { fiveHour: 60, weekly: 70 },
			paused: false,
			pauseReason: null,
		});
		expect(decision).toStrictEqual({
			action: "pause",
			window: "five_hour",
			utilization: 60,
			threshold: 50,
		});
	});

	it("stays out of the way below the threshold", () => {
		expect(
			evaluateUsagePause({
				thresholds: { fiveHour: 80, weekly: 80 },
				utilization: { fiveHour: 79, weekly: 0 },
				paused: false,
				pauseReason: null,
			}),
		).toStrictEqual({ action: "none" });
	});

	it("treats 0% as a real reading, not a missing one", () => {
		expect(
			evaluateUsagePause({
				thresholds: { fiveHour: 80, weekly: null },
				utilization: { fiveHour: 0, weekly: null },
				paused: true,
				pauseReason: USAGE_THRESHOLD_PAUSE_REASON,
			}),
		).toStrictEqual({ action: "resume" });
	});

	it("ignores a window the usage API did not report", () => {
		expect(
			evaluateUsagePause({
				thresholds: { fiveHour: 80, weekly: 80 },
				utilization: { fiveHour: null, weekly: 12 },
				paused: false,
				pauseReason: null,
			}),
		).toStrictEqual({ action: "none" });
	});

	it("does not pause an account that is already paused", () => {
		expect(
			evaluateUsagePause({
				thresholds: { fiveHour: 80, weekly: null },
				utilization: { fiveHour: 95, weekly: null },
				paused: true,
				pauseReason: USAGE_THRESHOLD_PAUSE_REASON,
			}),
		).toStrictEqual({ action: "none" });
	});

	it("never touches a manually paused account", () => {
		expect(
			evaluateUsagePause({
				thresholds: { fiveHour: 80, weekly: null },
				utilization: { fiveHour: 95, weekly: null },
				paused: true,
				pauseReason: "manual",
			}),
		).toStrictEqual({ action: "none" });
		expect(
			evaluateUsagePause({
				thresholds: { fiveHour: 80, weekly: null },
				utilization: { fiveHour: 3, weekly: null },
				paused: true,
				pauseReason: "manual",
			}),
		).toStrictEqual({ action: "none" });
	});

	it("leaves an overage pause to the overage logic", () => {
		expect(
			evaluateUsagePause({
				thresholds: { fiveHour: 80, weekly: null },
				utilization: { fiveHour: 3, weekly: null },
				paused: true,
				pauseReason: "overage",
			}),
		).toStrictEqual({ action: "none" });
	});

	it("resumes once the window that paused the account has rolled over", () => {
		expect(
			evaluateUsagePause({
				thresholds: { fiveHour: 80, weekly: 90 },
				utilization: { fiveHour: 2, weekly: 45 },
				paused: true,
				pauseReason: USAGE_THRESHOLD_PAUSE_REASON,
			}),
		).toStrictEqual({ action: "resume" });
	});

	it("keeps the account paused while any configured window is still over", () => {
		expect(
			evaluateUsagePause({
				thresholds: { fiveHour: 80, weekly: 90 },
				utilization: { fiveHour: 2, weekly: 95 },
				paused: true,
				pauseReason: USAGE_THRESHOLD_PAUSE_REASON,
			}),
		).toStrictEqual({ action: "none" });
	});

	it("keeps the account paused while a configured window is unreadable", () => {
		expect(
			evaluateUsagePause({
				thresholds: { fiveHour: 80, weekly: 90 },
				utilization: { fiveHour: 2, weekly: null },
				paused: true,
				pauseReason: USAGE_THRESHOLD_PAUSE_REASON,
			}),
		).toStrictEqual({ action: "none" });
	});

	it("resumes when the thresholds are removed while the account is paused", () => {
		expect(
			evaluateUsagePause({
				thresholds: NO_THRESHOLDS,
				utilization: { fiveHour: 99, weekly: 99 },
				paused: true,
				pauseReason: USAGE_THRESHOLD_PAUSE_REASON,
			}),
		).toStrictEqual({ action: "resume" });
	});

	it("does not resume on a snapshot that reports none of the configured windows", () => {
		expect(
			evaluateUsagePause({
				thresholds: { fiveHour: 80, weekly: 90 },
				utilization: { fiveHour: null, weekly: null },
				paused: true,
				pauseReason: USAGE_THRESHOLD_PAUSE_REASON,
			}),
		).toStrictEqual({ action: "none" });
	});
});

describe("readUsageUtilization", () => {
	it("reads the flat five_hour/seven_day windows", () => {
		expect(
			readUsageUtilization({
				five_hour: { utilization: 42, resets_at: null },
				seven_day: { utilization: 7, resets_at: null },
			}),
		).toStrictEqual({ fiveHour: 42, weekly: 7 });
	});

	it("falls back to limits[] when the flat windows are gone", () => {
		expect(
			readUsageUtilization({
				limits: [
					{ kind: "session", percent: 55, resets_at: null },
					{ kind: "weekly_all", percent: 12, resets_at: null },
				],
			}),
		).toStrictEqual({ fiveHour: 55, weekly: 12 });
	});

	it("prefers the flat window and fills the other one from limits[]", () => {
		expect(
			readUsageUtilization({
				five_hour: { utilization: 30, resets_at: null },
				limits: [
					{ kind: "session", percent: 99, resets_at: null },
					{ kind: "weekly_all", percent: 60, resets_at: null },
				],
			}),
		).toStrictEqual({ fiveHour: 30, weekly: 60 });
	});

	it("ignores per-model weekly caps", () => {
		expect(
			readUsageUtilization({
				limits: [
					{
						kind: "weekly_scoped",
						percent: 97,
						resets_at: null,
						scope: { model: { id: "opus", display_name: "Opus" } },
					},
				],
			}),
		).toStrictEqual({ fiveHour: null, weekly: null });
	});

	it("returns nulls for payloads it cannot read", () => {
		expect(readUsageUtilization(null)).toStrictEqual({
			fiveHour: null,
			weekly: null,
		});
		expect(readUsageUtilization("nope")).toStrictEqual({
			fiveHour: null,
			weekly: null,
		});
		expect(
			readUsageUtilization({ five_hour: { utilization: null } }),
		).toStrictEqual({ fiveHour: null, weekly: null });
	});
});
