import { describe, expect, it } from "bun:test";
import type { UsageHistoryWindowSeries } from "@better-ccflare/types";
import {
	buildUsageChartData,
	formatPredictionAnnotation,
	resetMarkers,
} from "../chart-data";

/** Find a row by timestamp, throwing with a clear message if absent (instead of a silent `!` assertion). */
function findRowByT<T extends { t: number }>(rows: T[], t: number): T {
	const row = rows.find((r) => r.t === t);
	if (!row) {
		throw new Error(`Expected a row with t=${t}, but none was found`);
	}
	return row;
}

const H = 60 * 60 * 1000;
const NOW = 3 * H;

/** Build a single-window series with an inline prediction, for annotation tests. */
function annSeries(
	window: string,
	prediction: UsageHistoryWindowSeries["prediction"],
): UsageHistoryWindowSeries {
	return {
		window,
		points: [{ t: 1000, utilization: 50, resetsAt: prediction.resetsAtMs }],
		prediction,
	};
}

function series(): UsageHistoryWindowSeries[] {
	return [
		{
			window: "five_hour",
			points: [
				{ t: 1000, utilization: 10, resetsAt: 5 * H },
				{ t: 2000, utilization: 20, resetsAt: 5 * H },
			],
			prediction: {
				slopePerHour: 10,
				etaExhaustMs: 4 * H,
				predictedAtReset: 100,
				resetsAtMs: 5 * H,
				willExhaustBeforeReset: true,
				state: "rising",
				lowConfidence: false,
			},
		},
		{
			window: "seven_day",
			points: [{ t: 2000, utilization: 3, resetsAt: null }],
			prediction: {
				slopePerHour: 0,
				etaExhaustMs: null,
				predictedAtReset: null,
				resetsAtMs: null,
				willExhaustBeforeReset: false,
				state: "stable",
				lowConfidence: false,
			},
		},
	];
}

describe("buildUsageChartData", () => {
	it("merges actual + prediction segments into one dataset", () => {
		const { rows, windowKeys, predictionKeys } = buildUsageChartData(
			series(),
			NOW,
			24 * H,
		);
		expect(windowKeys).toEqual(["five_hour", "seven_day"]);
		expect(predictionKeys).toEqual(["five_hour__pred"]); // only the rising window
		// distinct timestamps: 1000, 2000 (actual) + 4h (eta endpoint) = 3 rows
		expect(rows.map((r) => r.t)).toEqual([1000, 2000, 4 * H]);
		const t2 = findRowByT(rows, 2000);
		expect(t2.five_hour).toBe(20);
		expect(t2.seven_day).toBe(3);
		expect(t2.five_hour__pred).toBe(20); // prediction anchored at last actual
		const eta = findRowByT(rows, 4 * H);
		// Endpoint value now interpolates the straight-line forecast at the (capped)
		// endpoint time rather than snapping to 100. This synthetic fixture's ETA
		// (4h) is inconsistent with its slope, so the interpolation lands below 100.
		const expectedEta = 20 + 10 * ((4 * H - 2000) / H);
		expect(eta.five_hour__pred).toBeCloseTo(expectedEta, 5);
		expect(eta.five_hour).toBeNull(); // no actual point there
		const t1 = findRowByT(rows, 1000);
		expect(t1.seven_day).toBeNull(); // gap
	});

	it("caps the forecast at the reset when the ETA is beyond it", () => {
		const windows = [
			{
				window: "seven_day",
				points: [
					{ t: 0, utilization: 40, resetsAt: 10 * H },
					{ t: 1 * H, utilization: 42, resetsAt: 10 * H },
				],
				prediction: {
					slopePerHour: 2,
					etaExhaustMs: 30 * H, // ETA far beyond the 10h reset
					predictedAtReset: 58,
					resetsAtMs: 10 * H,
					willExhaustBeforeReset: false,
					state: "rising" as const,
					lowConfidence: false,
				},
			},
		];
		const { rows, predictionKeys } = buildUsageChartData(windows, NOW, 24 * H);
		expect(predictionKeys).toEqual(["seven_day__pred"]);
		// forecast endpoint is at the reset (10h), NOT 30h. Value now interpolates
		// the straight line to that endpoint: 42 + slope(2) * (10h - 1h) = 60.
		expect(rows.map((r) => r.t)).toEqual([0, 1 * H, 10 * H]);
		expect(rows.find((r) => r.t === 10 * H)?.seven_day__pred).toBe(60);
	});

	it("caps a rising window's forecast at the nearest reset across windows", () => {
		// Window A (five_hour) resets SOON (1h); window B (seven_day) resets FAR
		// (10h). B's own reset/ETA are far out, but the nearest reset across ALL
		// windows is A's 1h — B's forecast endpoint must be capped there so a
		// far-horizon window can't stretch the x-domain right (near-term detail).
		const HOUR = 60 * 60 * 1000;
		const windows: UsageHistoryWindowSeries[] = [
			{
				window: "five_hour",
				points: [{ t: 0, utilization: 50, resetsAt: 1 * HOUR }],
				prediction: {
					slopePerHour: 10,
					etaExhaustMs: 5 * HOUR,
					predictedAtReset: 60,
					resetsAtMs: 1 * HOUR,
					willExhaustBeforeReset: false,
					state: "rising",
					lowConfidence: false,
				},
			},
			{
				window: "seven_day",
				points: [{ t: 0, utilization: 20, resetsAt: 10 * HOUR }],
				prediction: {
					slopePerHour: 2,
					etaExhaustMs: 40 * HOUR,
					predictedAtReset: 44,
					resetsAtMs: 10 * HOUR,
					willExhaustBeforeReset: false,
					state: "rising",
					lowConfidence: false,
				},
			},
		];
		const { rows, predictionKeys } = buildUsageChartData(windows, 0, 24 * HOUR);
		expect(predictionKeys).toEqual(["five_hour__pred", "seven_day__pred"]);
		// B's forecast endpoint is at A's reset (1h), NOT at B's own 10h.
		expect(rows.find((r) => r.t === 10 * HOUR)).toBeUndefined();
		// interpolated value at the capped endpoint: 20 + slopeB(2) * 1h = 22
		expect(rows.find((r) => r.t === 1 * HOUR)?.seven_day__pred).toBe(22);
		// domain not stretched: the max row t is A's reset (1h), not 10h
		const maxT = Math.max(...rows.map((r) => r.t));
		expect(maxT).toBe(1 * HOUR);
		expect(maxT).toBeLessThanOrEqual(1 * HOUR);
	});

	it("leaves a single rising window's forecast endpoint at its own reset/ETA", () => {
		// Only one window ⇒ nearestReset == its own reset ⇒ endpoint == min(own
		// reset, ETA) exactly as before the multi-window cap was introduced.
		const HOUR = 60 * 60 * 1000;
		const windows: UsageHistoryWindowSeries[] = [
			{
				window: "five_hour",
				points: [{ t: 0, utilization: 60, resetsAt: 5 * HOUR }],
				prediction: {
					slopePerHour: 10,
					etaExhaustMs: 4 * HOUR, // ETA before the reset ⇒ endpoint at ETA
					predictedAtReset: 100,
					resetsAtMs: 5 * HOUR,
					willExhaustBeforeReset: true,
					state: "rising",
					lowConfidence: false,
				},
			},
		];
		const { rows, predictionKeys } = buildUsageChartData(windows, 0, 24 * HOUR);
		expect(predictionKeys).toEqual(["five_hour__pred"]);
		// endpoint sits at the ETA (4h) — unchanged; value interpolates to 100.
		expect(rows.find((r) => r.t === 4 * HOUR)?.five_hour__pred).toBe(100);
		expect(Math.max(...rows.map((r) => r.t))).toBe(4 * HOUR);
	});

	it("threads horizonMs into markers — a far reset is dropped", () => {
		// seven_day resets 19h out; a 6h horizon must not surface it as a marker.
		const windows: UsageHistoryWindowSeries[] = [
			{
				window: "seven_day",
				points: [{ t: 0, utilization: 40, resetsAt: 19 * H }],
				prediction: {
					slopePerHour: 0,
					etaExhaustMs: null,
					predictedAtReset: null,
					resetsAtMs: 19 * H,
					willExhaustBeforeReset: false,
					state: "stable",
					lowConfidence: false,
				},
			},
		];
		expect(buildUsageChartData(windows, 0, 6 * H).markers).toEqual([]);
	});
});

describe("resetMarkers", () => {
	it("returns a single marker at the nearest upcoming reset", () => {
		// series() has a five_hour window resetting at 5h (+ a null-reset window).
		expect(resetMarkers(series(), 3 * H, 24 * H).map((m) => m.x)).toEqual([
			5 * H,
		]);
	});

	it("returns [] when now is after every reset", () => {
		expect(resetMarkers(series(), 6 * H, 24 * H)).toEqual([]);
	});

	it("keeps a reset that is within the forward horizon", () => {
		const windows: UsageHistoryWindowSeries[] = [
			{
				window: "five_hour",
				points: [{ t: 0, utilization: 20, resetsAt: 4.5 * H }],
				prediction: {
					slopePerHour: 0,
					etaExhaustMs: null,
					predictedAtReset: null,
					resetsAtMs: 4.5 * H,
					willExhaustBeforeReset: false,
					state: "stable",
					lowConfidence: false,
				},
			},
		];
		// now=0, horizon=6h → 4.5h ≤ 6h, marker kept.
		expect(resetMarkers(windows, 0, 6 * H).map((m) => m.x)).toEqual([4.5 * H]);
	});

	it("drops a reset that is beyond the forward horizon", () => {
		const windows: UsageHistoryWindowSeries[] = [
			{
				window: "seven_day",
				points: [{ t: 0, utilization: 40, resetsAt: 19 * H }],
				prediction: {
					slopePerHour: 0,
					etaExhaustMs: null,
					predictedAtReset: null,
					resetsAtMs: 19 * H,
					willExhaustBeforeReset: false,
					state: "stable",
					lowConfidence: false,
				},
			},
		];
		// now=0, horizon=6h → 19h > 6h, marker dropped (this is the new bound).
		expect(resetMarkers(windows, 0, 6 * H)).toEqual([]);
	});

	it("picks the earliest reset within the horizon, ignoring farther ones beyond it", () => {
		const windows: UsageHistoryWindowSeries[] = [
			{
				window: "seven_day",
				points: [{ t: 0, utilization: 40, resetsAt: 19 * H }],
				prediction: {
					slopePerHour: 0,
					etaExhaustMs: null,
					predictedAtReset: null,
					resetsAtMs: 19 * H,
					willExhaustBeforeReset: false,
					state: "stable",
					lowConfidence: false,
				},
			},
			{
				window: "five_hour",
				points: [{ t: 0, utilization: 20, resetsAt: 4.5 * H }],
				prediction: {
					slopePerHour: 0,
					etaExhaustMs: null,
					predictedAtReset: null,
					resetsAtMs: 4.5 * H,
					willExhaustBeforeReset: false,
					state: "stable",
					lowConfidence: false,
				},
			},
		];
		// now=0, horizon=6h → 4.5h kept, 19h dropped.
		expect(resetMarkers(windows, 0, 6 * H).map((m) => m.x)).toEqual([4.5 * H]);
	});

	it("picks the earliest future reset across multiple windows, skipping past ones", () => {
		const windows: UsageHistoryWindowSeries[] = [
			{
				window: "seven_day",
				points: [{ t: 0, utilization: 40, resetsAt: 10 * H }],
				prediction: {
					slopePerHour: 0,
					etaExhaustMs: null,
					predictedAtReset: null,
					resetsAtMs: 10 * H,
					willExhaustBeforeReset: false,
					state: "stable",
					lowConfidence: false,
				},
			},
			{
				window: "five_hour",
				points: [{ t: 0, utilization: 20, resetsAt: 3 * H }],
				prediction: {
					slopePerHour: 0,
					etaExhaustMs: null,
					predictedAtReset: null,
					resetsAtMs: 3 * H,
					willExhaustBeforeReset: false,
					state: "stable",
					lowConfidence: false,
				},
			},
		];
		// both resets in the future (now=1h) → earliest (3h) wins
		expect(resetMarkers(windows, 1 * H, 24 * H).map((m) => m.x)).toEqual([
			3 * H,
		]);
		// now past the 3h reset → the next future reset (10h) is chosen
		expect(resetMarkers(windows, 4 * H, 24 * H).map((m) => m.x)).toEqual([
			10 * H,
		]);
	});
});

describe("formatPredictionAnnotation", () => {
	it("summarizes a rising window that will exhaust before reset", () => {
		const out = formatPredictionAnnotation(series()[0], 3 * H);
		expect(out).toContain("five_hour");
		expect(out.toLowerCase()).toContain("limit");
	});
	it("says stable for a stable window", () => {
		expect(formatPredictionAnnotation(series()[1], 0).toLowerCase()).toContain(
			"stable",
		);
	});

	// Load-bearing guard: a rising window with NO known reset must never claim
	// "safe until reset" (Fable M6). Pins the negative direction.
	it("never claims safe for a rising window with no known reset", () => {
		const out = formatPredictionAnnotation(
			annSeries("five_hour", {
				slopePerHour: 5,
				etaExhaustMs: null,
				predictedAtReset: null,
				resetsAtMs: null,
				willExhaustBeforeReset: false,
				state: "rising",
				lowConfidence: false,
			}),
			NOW,
		);
		expect(out.toLowerCase()).not.toContain("safe");
		expect(out).toContain("five_hour");
		expect(out.toLowerCase()).toContain("rising");
	});

	it("says collecting for insufficient_data", () => {
		const out = formatPredictionAnnotation(
			annSeries("seven_day", {
				slopePerHour: 0,
				etaExhaustMs: null,
				predictedAtReset: null,
				resetsAtMs: null,
				willExhaustBeforeReset: false,
				state: "insufficient_data",
				lowConfidence: false,
			}),
			NOW,
		);
		expect(out.toLowerCase()).toContain("collecting");
	});

	it("says at limit for an exhausted window", () => {
		const out = formatPredictionAnnotation(
			annSeries("five_hour", {
				slopePerHour: 20,
				etaExhaustMs: NOW,
				predictedAtReset: 100,
				resetsAtMs: 5 * H,
				willExhaustBeforeReset: true,
				state: "exhausted",
				lowConfidence: false,
			}),
			NOW,
		);
		expect(out.toLowerCase()).toContain("limit");
	});

	it("flags low confidence for a rising low-confidence window", () => {
		const out = formatPredictionAnnotation(
			annSeries("five_hour", {
				slopePerHour: 8,
				etaExhaustMs: null,
				predictedAtReset: null,
				resetsAtMs: 5 * H,
				willExhaustBeforeReset: false,
				state: "rising",
				lowConfidence: true,
			}),
			NOW,
		);
		expect(out.toLowerCase()).toContain("low confidence");
	});

	// Positive counterpart to the guard: a rising window WITH a known reset that
	// won't exhaust before it should say "safe". Together these pin both directions.
	it("says safe until reset for a rising window with a known reset", () => {
		const out = formatPredictionAnnotation(
			annSeries("five_hour", {
				slopePerHour: 6,
				etaExhaustMs: 8 * H,
				predictedAtReset: 70,
				resetsAtMs: 5 * H,
				willExhaustBeforeReset: false,
				state: "rising",
				lowConfidence: false,
			}),
			NOW,
		);
		expect(out.toLowerCase()).toContain("safe");
	});
});
