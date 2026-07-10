import { describe, expect, it } from "bun:test";
import type { PredictionPoint } from "@better-ccflare/types";
import { computeUsagePrediction } from "../usage-prediction";

const H = 60 * 60 * 1000;

describe("computeUsagePrediction", () => {
	it("returns insufficient_data for < 3 points", () => {
		const p = computeUsagePrediction([
			{ t: 0, utilization: 10, resetsAt: null },
			{ t: H, utilization: 20, resetsAt: null },
		]);
		expect(p.state).toBe("insufficient_data");
		expect(p.etaExhaustMs).toBeNull();
	});

	it("anchors ETA at current usage and projects usage at reset", () => {
		const reset = 20 * H;
		// 10,20,30,40 over 0..3h → slope 10/h, current usage 40 at t=3h
		const points: PredictionPoint[] = [0, 1, 2, 3].map((h) => ({
			t: h * H,
			utilization: 10 * h + 10,
			resetsAt: reset,
		}));
		const p = computeUsagePrediction(points);
		expect(p.state).toBe("rising");
		expect(Math.round(p.slopePerHour)).toBe(10);
		// (100 - 40) / 10 = 6h from t=3h → t=9h
		expect(Math.round((p.etaExhaustMs ?? 0) / H)).toBe(9);
		// projected at reset: 40 + 10*(20-3) = 210 → clamped to 100
		expect(p.predictedAtReset).toBe(100);
		expect(p.willExhaustBeforeReset).toBe(true);
		expect(p.lowConfidence).toBe(false);
	});

	it("is stable (no eta) for flat usage; predictedAtReset ≈ current", () => {
		const points: PredictionPoint[] = [0, 1, 2, 3].map((h) => ({
			t: h * H,
			utilization: 42,
			resetsAt: 20 * H,
		}));
		const p = computeUsagePrediction(points);
		expect(p.state).toBe("stable");
		expect(p.etaExhaustMs).toBeNull();
		expect(p.predictedAtReset).toBe(42);
		expect(p.willExhaustBeforeReset).toBe(false);
	});

	it("segments at a resets_at change", () => {
		const reset1 = 5 * H;
		const reset2 = 25 * H;
		const points: PredictionPoint[] = [
			{ t: 0, utilization: 60, resetsAt: reset1 },
			{ t: 1 * H, utilization: 90, resetsAt: reset1 },
			{ t: 2 * H, utilization: 5, resetsAt: reset2 }, // new window
			{ t: 3 * H, utilization: 6, resetsAt: reset2 },
			{ t: 4 * H, utilization: 7, resetsAt: reset2 },
		];
		const p = computeUsagePrediction(points);
		expect(p.state).toBe("rising");
		expect(Math.round(p.slopePerHour)).toBe(1); // post-reset segment only
		expect(p.resetsAtMs).toBe(reset2);
	});

	it("tolerates sub-second resets_at jitter within one window (no false segmentation)", () => {
		// Real Anthropic data: every poll reports the SAME reset instant but the
		// stored epoch-ms jitters by ~±1s. Exact-inequality segmentation would cut
		// at every pair → segment length 1 → bogus "insufficient_data". A rising
		// window with ample data must still read as "rising" across the whole span.
		const base = 20 * H;
		const jitter = [120, -300, 80, -50, 200]; // ms, all within ±1s
		const points: PredictionPoint[] = [0, 1, 2, 3, 4].map((h) => ({
			t: h * H,
			utilization: 20 + 10 * h, // 20,30,40,50,60 → slope 10/h
			resetsAt: base + jitter[h],
		}));
		const p = computeUsagePrediction(points);
		expect(p.state).toBe("rising");
		expect(Math.round(p.slopePerHour)).toBe(10); // whole segment, not a lone point
	});

	it("stays stable across resets_at jitter for a flat window", () => {
		const base = 20 * H;
		const jitter = [120, -300, 80, -50, 200];
		const points: PredictionPoint[] = [0, 1, 2, 3, 4].map((h) => ({
			t: h * H,
			utilization: 51, // flat
			resetsAt: base + jitter[h],
		}));
		const p = computeUsagePrediction(points);
		expect(p.state).toBe("stable");
	});

	it("reports exhausted when the latest sample is at/over 100", () => {
		const reset = 20 * H;
		const points: PredictionPoint[] = [
			{ t: 0, utilization: 80, resetsAt: reset },
			{ t: 1 * H, utilization: 100, resetsAt: reset },
			{ t: 2 * H, utilization: 120, resetsAt: reset }, // overage
		];
		const p = computeUsagePrediction(points);
		expect(p.state).toBe("exhausted");
		expect(p.etaExhaustMs).toBe(2 * H);
	});

	it("ignores idle null-reset points that would flatten the slope", () => {
		const reset = 20 * H;
		const points: PredictionPoint[] = [
			{ t: 0, utilization: 0, resetsAt: null }, // idle
			{ t: 1 * H, utilization: 0, resetsAt: null }, // idle
			{ t: 2 * H, utilization: 0, resetsAt: null }, // idle
			{ t: 3 * H, utilization: 20, resetsAt: reset },
			{ t: 4 * H, utilization: 40, resetsAt: reset },
			{ t: 5 * H, utilization: 60, resetsAt: reset },
		];
		const p = computeUsagePrediction(points);
		expect(p.state).toBe("rising");
		expect(Math.round(p.slopePerHour)).toBe(20); // active pace, not diluted to ~10
	});

	it("drops pre-gift data so a mid-period refund never yields a negative slope", () => {
		const reset = 25 * H;
		const points: PredictionPoint[] = [
			{ t: 0, utilization: 60, resetsAt: reset },
			{ t: 1 * H, utilization: 86, resetsAt: reset },
			{ t: 2 * H, utilization: 7, resetsAt: reset }, // >5pp drop = refund/gift
			{ t: 3 * H, utilization: 8, resetsAt: reset },
			{ t: 4 * H, utilization: 9, resetsAt: reset },
		];
		const p = computeUsagePrediction(points);
		expect(p.slopePerHour).toBeGreaterThan(0); // NOT the bogus negative slope
		expect(Math.round(p.slopePerHour)).toBe(1); // post-gift trend ~1%/h
		expect(p.predictedAtReset).not.toBeNull();
		expect(p.predictedAtReset as number).toBeGreaterThanOrEqual(0); // never "-142%"
	});

	it("flags lowConfidence and suppresses eta for a sub-5-minute span", () => {
		const t0 = 1_000_000;
		const points: PredictionPoint[] = [0, 1, 2].map((i) => ({
			t: t0 + i * 60 * 1000, // 3 points across 2 minutes
			utilization: 10 + i * 5,
			resetsAt: t0 + 5 * H,
		}));
		const p = computeUsagePrediction(points);
		expect(p.lowConfidence).toBe(true);
		expect(p.etaExhaustMs).toBeNull();
		expect(p.predictedAtReset).toBeNull();
	});
});
