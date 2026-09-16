import { describe, expect, it } from "bun:test";
import {
	effectiveThreshold,
	evaluateUsagePause,
	parseUsagePauseThreshold,
	readUsageUtilization,
	supportsUsagePauseThreshold,
	USAGE_THRESHOLD_PAUSE_REASON,
} from "./usage-threshold";

const off = { enabled: false, percent: null };
const NO_THRESHOLDS = { fiveHour: off, weekly: off };
/** A window switched on at `percent`. */
const on = (percent: number) => ({ enabled: true, percent });

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
				thresholds: { fiveHour: on(80), weekly: off },
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
				thresholds: { fiveHour: off, weekly: on(90) },
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
			thresholds: { fiveHour: on(50), weekly: on(50) },
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
				thresholds: { fiveHour: on(80), weekly: on(80) },
				utilization: { fiveHour: 79, weekly: 0 },
				paused: false,
				pauseReason: null,
			}),
		).toStrictEqual({ action: "none" });
	});

	it("treats 0% as a real reading, not a missing one", () => {
		expect(
			evaluateUsagePause({
				thresholds: { fiveHour: on(80), weekly: off },
				utilization: { fiveHour: 0, weekly: null },
				paused: true,
				pauseReason: USAGE_THRESHOLD_PAUSE_REASON,
			}),
		).toStrictEqual({ action: "resume" });
	});

	it("ignores a window the usage API did not report", () => {
		expect(
			evaluateUsagePause({
				thresholds: { fiveHour: on(80), weekly: on(80) },
				utilization: { fiveHour: null, weekly: 12 },
				paused: false,
				pauseReason: null,
			}),
		).toStrictEqual({ action: "none" });
	});

	it("does not pause an account that is already paused", () => {
		expect(
			evaluateUsagePause({
				thresholds: { fiveHour: on(80), weekly: off },
				utilization: { fiveHour: 95, weekly: null },
				paused: true,
				pauseReason: USAGE_THRESHOLD_PAUSE_REASON,
			}),
		).toStrictEqual({ action: "none" });
	});

	it("never touches a manually paused account", () => {
		expect(
			evaluateUsagePause({
				thresholds: { fiveHour: on(80), weekly: off },
				utilization: { fiveHour: 95, weekly: null },
				paused: true,
				pauseReason: "manual",
			}),
		).toStrictEqual({ action: "none" });
		expect(
			evaluateUsagePause({
				thresholds: { fiveHour: on(80), weekly: off },
				utilization: { fiveHour: 3, weekly: null },
				paused: true,
				pauseReason: "manual",
			}),
		).toStrictEqual({ action: "none" });
	});

	it("uses a reason the load balancer will not auto-unpause", () => {
		// The load balancer resumes `overage`, `rate_limit_window` and unset
		// reasons once the stored rate_limit_reset elapses. That timestamp covers
		// one window, so an account benched for its weekly threshold could be
		// resumed by a 5-hour reset. Resuming is the poller's job alone.
		expect(USAGE_THRESHOLD_PAUSE_REASON).toBe("usage_threshold");
	});

	it("leaves a rate_limit_window pause to the load balancer", () => {
		expect(
			evaluateUsagePause({
				thresholds: { fiveHour: on(80), weekly: off },
				utilization: { fiveHour: 3, weekly: null },
				paused: true,
				pauseReason: "rate_limit_window",
			}),
		).toStrictEqual({ action: "none" });
	});

	it("leaves an overage pause to the overage logic", () => {
		expect(
			evaluateUsagePause({
				thresholds: { fiveHour: on(80), weekly: off },
				utilization: { fiveHour: 3, weekly: null },
				paused: true,
				pauseReason: "overage",
			}),
		).toStrictEqual({ action: "none" });
	});

	it("resumes once the window that paused the account has rolled over", () => {
		expect(
			evaluateUsagePause({
				thresholds: { fiveHour: on(80), weekly: on(90) },
				utilization: { fiveHour: 2, weekly: 45 },
				paused: true,
				pauseReason: USAGE_THRESHOLD_PAUSE_REASON,
			}),
		).toStrictEqual({ action: "resume" });
	});

	it("keeps the account paused while any configured window is still over", () => {
		expect(
			evaluateUsagePause({
				thresholds: { fiveHour: on(80), weekly: on(90) },
				utilization: { fiveHour: 2, weekly: 95 },
				paused: true,
				pauseReason: USAGE_THRESHOLD_PAUSE_REASON,
			}),
		).toStrictEqual({ action: "none" });
	});

	it("keeps the account paused while a configured window is unreadable", () => {
		expect(
			evaluateUsagePause({
				thresholds: { fiveHour: on(80), weekly: on(90) },
				utilization: { fiveHour: 2, weekly: null },
				paused: true,
				pauseReason: USAGE_THRESHOLD_PAUSE_REASON,
			}),
		).toStrictEqual({ action: "none" });
	});

	it("resumes when a window is switched off while the account is paused", () => {
		expect(
			evaluateUsagePause({
				thresholds: { fiveHour: { enabled: false, percent: 80 }, weekly: off },
				utilization: { fiveHour: 99, weekly: 99 },
				paused: true,
				pauseReason: USAGE_THRESHOLD_PAUSE_REASON,
			}),
		).toStrictEqual({ action: "resume" });
	});

	it("ignores a window that is on but has no percentage yet", () => {
		expect(
			evaluateUsagePause({
				thresholds: { fiveHour: { enabled: true, percent: null }, weekly: off },
				utilization: { fiveHour: 99, weekly: 99 },
				paused: false,
				pauseReason: null,
			}),
		).toStrictEqual({ action: "none" });
	});

	it("keeps the stored percentage out of the decision while the window is off", () => {
		expect(
			evaluateUsagePause({
				thresholds: { fiveHour: { enabled: false, percent: 10 }, weekly: off },
				utilization: { fiveHour: 99, weekly: 99 },
				paused: false,
				pauseReason: null,
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
				thresholds: { fiveHour: on(80), weekly: on(90) },
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

	it("still reads the flat five_hour/seven_day windows when provider is explicitly 'anthropic'", () => {
		expect(
			readUsageUtilization(
				{
					five_hour: { utilization: 42, resets_at: null },
					seven_day: { utilization: 7, resets_at: null },
				},
				"anthropic",
			),
		).toStrictEqual({ fiveHour: 42, weekly: 7 });
	});

	it("still falls back to limits[] when provider is explicitly 'anthropic'", () => {
		expect(
			readUsageUtilization(
				{
					limits: [
						{ kind: "session", percent: 55, resets_at: null },
						{ kind: "weekly_all", percent: 12, resets_at: null },
					],
				},
				"anthropic",
			),
		).toStrictEqual({ fiveHour: 55, weekly: 12 });
	});

	it("uses the Anthropic-shaped fallback for codex and xai (unchanged payload shape)", () => {
		const payload = {
			five_hour: { utilization: 33, resets_at: null },
			seven_day: { utilization: 66, resets_at: null },
		};
		expect(readUsageUtilization(payload, "codex")).toStrictEqual({
			fiveHour: 33,
			weekly: 66,
		});
		expect(readUsageUtilization(payload, "xai")).toStrictEqual({
			fiveHour: 33,
			weekly: 66,
		});
	});

	it("parses a minimax-shaped payload via the existing flat-shape path, no new branch required", () => {
		expect(
			readUsageUtilization(
				{
					five_hour: { utilization: 21, resetAt: 1_700_000_000_000 },
					seven_day: { utilization: 84, resetAt: 1_700_600_000_000 },
				},
				"minimax",
			),
		).toStrictEqual({ fiveHour: 21, weekly: 84 });
	});

	describe("zai payload shape", () => {
		it("reads both tokens_limit.percentage and tokens_limit_weekly.percentage", () => {
			expect(
				readUsageUtilization(
					{
						time_limit: { percentage: 5 },
						tokens_limit: { percentage: 30 },
						tokens_limit_weekly: { percentage: 65 },
					},
					"zai",
				),
			).toStrictEqual({ fiveHour: 30, weekly: 65 });
		});

		it("treats a missing tokens_limit_weekly as null (single-window plan)", () => {
			expect(
				readUsageUtilization(
					{
						time_limit: { percentage: 5 },
						tokens_limit: { percentage: 30 },
						tokens_limit_weekly: null,
					},
					"zai",
				),
			).toStrictEqual({ fiveHour: 30, weekly: null });
		});

		it("treats a fully absent tokens_limit_weekly field as null", () => {
			expect(
				readUsageUtilization(
					{
						tokens_limit: { percentage: 12 },
					},
					"zai",
				),
			).toStrictEqual({ fiveHour: 12, weekly: null });
		});

		it("never reads time_limit into either window", () => {
			expect(
				readUsageUtilization(
					{
						time_limit: { percentage: 99 },
						tokens_limit: null,
						tokens_limit_weekly: null,
					},
					"zai",
				),
			).toStrictEqual({ fiveHour: null, weekly: null });
		});

		it("treats a non-numeric or missing percentage as null", () => {
			expect(
				readUsageUtilization(
					{
						tokens_limit: { percentage: "not-a-number" },
						tokens_limit_weekly: {},
					},
					"zai",
				),
			).toStrictEqual({ fiveHour: null, weekly: null });
		});
	});

	describe("nanogpt payload shape", () => {
		it("reads daily/monthly percentUsed and multiplies by 100 when active", () => {
			expect(
				readUsageUtilization(
					{
						active: true,
						daily: { percentUsed: 0.42 },
						monthly: { percentUsed: 0.1 },
					},
					"nanogpt",
				),
			).toStrictEqual({ fiveHour: 42, weekly: 10 });
		});

		it("preserves floating point precision without rounding, e.g. 0.055 -> 5.5", () => {
			expect(
				readUsageUtilization(
					{
						active: true,
						daily: { percentUsed: 0.055 },
						monthly: { percentUsed: 0.2 },
					},
					"nanogpt",
				),
			).toStrictEqual({ fiveHour: 5.5, weekly: 20 });
		});

		it("returns nulls for both windows when active is false, regardless of daily/monthly", () => {
			expect(
				readUsageUtilization(
					{
						active: false,
						daily: { percentUsed: 0.9 },
						monthly: { percentUsed: 0.9 },
					},
					"nanogpt",
				),
			).toStrictEqual({ fiveHour: null, weekly: null });
		});

		it("treats missing or non-numeric percentUsed as null", () => {
			expect(
				readUsageUtilization(
					{
						active: true,
						daily: {},
						monthly: { percentUsed: "nope" },
					},
					"nanogpt",
				),
			).toStrictEqual({ fiveHour: null, weekly: null });
		});
	});
});

describe("supportsUsagePauseThreshold", () => {
	it("returns true for anthropic, codex, xai, zai, nanogpt and minimax", () => {
		expect(supportsUsagePauseThreshold("anthropic")).toBe(true);
		expect(supportsUsagePauseThreshold("codex")).toBe(true);
		expect(supportsUsagePauseThreshold("xai")).toBe(true);
		expect(supportsUsagePauseThreshold("zai")).toBe(true);
		expect(supportsUsagePauseThreshold("nanogpt")).toBe(true);
		expect(supportsUsagePauseThreshold("minimax")).toBe(true);
	});

	it("returns false for kilo, alibaba-coding-plan, unknown providers, null and undefined", () => {
		expect(supportsUsagePauseThreshold("kilo")).toBe(false);
		expect(supportsUsagePauseThreshold("alibaba-coding-plan")).toBe(false);
		expect(supportsUsagePauseThreshold("some-other-provider")).toBe(false);
		expect(supportsUsagePauseThreshold(null)).toBe(false);
		expect(supportsUsagePauseThreshold(undefined)).toBe(false);
	});
});

describe("effectiveThreshold", () => {
	it("reads the percentage only while the window is switched on", () => {
		expect(effectiveThreshold({ enabled: true, percent: 80 })).toBe(80);
		expect(effectiveThreshold({ enabled: false, percent: 80 })).toBeNull();
		expect(effectiveThreshold({ enabled: true, percent: null })).toBeNull();
		expect(effectiveThreshold(null)).toBeNull();
		expect(effectiveThreshold(undefined)).toBeNull();
	});
});
