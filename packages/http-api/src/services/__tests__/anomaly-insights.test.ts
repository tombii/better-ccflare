import { describe, expect, test } from "bun:test";
import type { ModelRates } from "@better-ccflare/core";
import {
	type AnomalyRequestRow,
	buildAnomalyInsightsResponse,
	computeBaselines,
	detectModelMisrouting,
	detectRunawayLoops,
	detectTokenOutliers,
} from "../anomaly-insights";

/**
 * Tests for the pure anomaly-detection math service.
 *
 * Token values are chosen so means/stddevs are exact in floating point,
 * e.g. nine requests at 100 tokens plus one at 1000 gives mean 190,
 * stddev 270 and a z-score of exactly 3 for the spike.
 */

const OPUS_RATES: ModelRates = {
	input: 15,
	output: 75,
	cacheRead: 1.5,
	cacheWrite: 18.75,
};

const HAIKU_RATES: ModelRates = {
	input: 1,
	output: 4,
	cacheRead: 0.1,
	cacheWrite: 1.25,
};

let nextId = 0;

function req(partial: Partial<AnomalyRequestRow> = {}): AnomalyRequestRow {
	nextId += 1;
	return {
		id: `req-${nextId}`,
		timestamp: 0,
		account: "acc",
		model: "claude-opus-4-8",
		project: null,
		inputTokens: 0,
		cacheReadInputTokens: 0,
		cacheCreationInputTokens: 0,
		outputTokens: 0,
		costUsd: 0,
		...partial,
	};
}

/** Nine requests totalling 100 tokens each plus one 1000-token spike. */
function spikeRows(): AnomalyRequestRow[] {
	const rows = Array.from({ length: 9 }, () => req({ inputTokens: 100 }));
	rows.push(req({ id: "spike", inputTokens: 1000 }));
	return rows;
}

describe("computeBaselines", () => {
	test("computes mean and population stddev per account/model", () => {
		const rows = [
			...Array.from({ length: 5 }, () =>
				req({ inputTokens: 90, outputTokens: 0 }),
			),
			...Array.from({ length: 5 }, () =>
				req({ inputTokens: 110, outputTokens: 0 }),
			),
		];
		const baselines = computeBaselines(rows, 10);
		expect(baselines).toHaveLength(1);
		expect(baselines[0].account).toBe("acc");
		expect(baselines[0].model).toBe("claude-opus-4-8");
		expect(baselines[0].requests).toBe(10);
		expect(baselines[0].meanTotalTokens).toBe(100);
		expect(baselines[0].stdDevTotalTokens).toBe(10);
		expect(baselines[0].meanOutputTokens).toBe(0);
		expect(baselines[0].stdDevOutputTokens).toBe(0);
	});

	test("total tokens sum input, cache read, cache creation and output", () => {
		const rows = Array.from({ length: 10 }, () =>
			req({
				inputTokens: 10,
				cacheReadInputTokens: 20,
				cacheCreationInputTokens: 30,
				outputTokens: 40,
			}),
		);
		const baselines = computeBaselines(rows, 10);
		expect(baselines[0].meanTotalTokens).toBe(100);
	});

	test("excludes zero-token rows from the baseline", () => {
		const rows = [
			...Array.from({ length: 10 }, () => req({ inputTokens: 100 })),
			...Array.from({ length: 10 }, () => req()), // failed requests, no tokens
		];
		const baselines = computeBaselines(rows, 10);
		expect(baselines).toHaveLength(1);
		expect(baselines[0].requests).toBe(10);
		expect(baselines[0].meanTotalTokens).toBe(100);
	});

	test("omits groups below minBaselineRequests", () => {
		const rows = Array.from({ length: 9 }, () => req({ inputTokens: 100 }));
		expect(computeBaselines(rows, 10)).toHaveLength(0);
	});

	test("groups separately per account and model, normalizing null to Unknown", () => {
		const rows = [
			...Array.from({ length: 3 }, () =>
				req({ account: "a1", model: "m1", inputTokens: 100 }),
			),
			...Array.from({ length: 3 }, () =>
				req({ account: "a1", model: "m2", inputTokens: 200 }),
			),
			...Array.from({ length: 3 }, () =>
				req({ account: null, model: null, inputTokens: 300 }),
			),
		];
		const baselines = computeBaselines(rows, 3);
		expect(baselines).toHaveLength(3);
		const unknown = baselines.find((b) => b.account === "Unknown");
		expect(unknown?.model).toBe("Unknown");
		expect(unknown?.meanTotalTokens).toBe(300);
	});
});

describe("detectTokenOutliers", () => {
	test("flags requests at or above the z-score threshold", () => {
		const rows = spikeRows();
		const baselines = computeBaselines(rows, 10);
		const outliers = detectTokenOutliers(rows, baselines, 3, "total_tokens");
		expect(outliers).toHaveLength(1);
		expect(outliers[0].requestId).toBe("spike");
		expect(outliers[0].metric).toBe("total_tokens");
		expect(outliers[0].value).toBe(1000);
		expect(outliers[0].baselineMean).toBe(190);
		expect(outliers[0].baselineStdDev).toBe(270);
		expect(outliers[0].zScore).toBe(3);
	});

	test("does not flag low-side outliers", () => {
		// Nine 1000-token requests plus one at 100: the small one has z = -3.
		const rows = Array.from({ length: 9 }, () => req({ inputTokens: 1000 }));
		rows.push(req({ inputTokens: 100 }));
		const baselines = computeBaselines(rows, 10);
		expect(
			detectTokenOutliers(rows, baselines, 3, "total_tokens"),
		).toHaveLength(0);
	});

	test("returns nothing when the baseline has zero variance", () => {
		const rows = Array.from({ length: 10 }, () => req({ inputTokens: 100 }));
		const baselines = computeBaselines(rows, 10);
		expect(
			detectTokenOutliers(rows, baselines, 3, "total_tokens"),
		).toHaveLength(0);
	});

	test("returns nothing for groups without a baseline", () => {
		const rows = spikeRows();
		expect(detectTokenOutliers(rows, [], 3, "total_tokens")).toHaveLength(0);
	});

	test("output_tokens metric detects output blowups independently", () => {
		// Constant 200 total tokens, but one response with 100 output tokens
		// against a baseline of 10: z = 3 on the output metric only.
		const rows = Array.from({ length: 9 }, () =>
			req({ inputTokens: 190, outputTokens: 10 }),
		);
		rows.push(req({ id: "blowup", inputTokens: 100, outputTokens: 100 }));
		const baselines = computeBaselines(rows, 10);
		expect(
			detectTokenOutliers(rows, baselines, 3, "total_tokens"),
		).toHaveLength(0);
		const blowups = detectTokenOutliers(rows, baselines, 3, "output_tokens");
		expect(blowups).toHaveLength(1);
		expect(blowups[0].requestId).toBe("blowup");
		expect(blowups[0].metric).toBe("output_tokens");
		expect(blowups[0].zScore).toBe(3);
	});

	test("sorts outliers by z-score descending", () => {
		const rows = [
			...Array.from({ length: 18 }, () => req({ inputTokens: 100 })),
			req({ id: "big", inputTokens: 1000 }),
			req({ id: "bigger", inputTokens: 2000 }),
		];
		const baselines = computeBaselines(rows, 10);
		// z(big) ~ 1.69, z(bigger) ~ 3.92 against mean 240, stddev ~448.8.
		const outliers = detectTokenOutliers(rows, baselines, 1.5, "total_tokens");
		expect(outliers.map((o) => o.requestId)).toEqual(["bigger", "big"]);
	});
});

describe("detectRunawayLoops", () => {
	const opts = {
		windowMs: 5 * 60_000,
		minRequests: 10,
		similarityTolerance: 0.25,
	};

	test("flags a dense burst of near-identical requests", () => {
		// 12 requests, one every 10s, identical token profile.
		const rows = Array.from({ length: 12 }, (_, i) =>
			req({ timestamp: i * 10_000, inputTokens: 500, project: "proj" }),
		);
		const loops = detectRunawayLoops(rows, opts);
		expect(loops).toHaveLength(1);
		expect(loops[0].account).toBe("acc");
		expect(loops[0].project).toBe("proj");
		expect(loops[0].requests).toBe(12);
		expect(loops[0].windowStartMs).toBe(0);
		expect(loops[0].windowEndMs).toBe(110_000);
		expect(loops[0].meanInputTokens).toBe(500);
		expect(loops[0].inputTokenSpread).toBe(0);
		// 12 requests over 110s
		expect(loops[0].requestsPerMinute).toBeCloseTo((12 * 60_000) / 110_000, 6);
	});

	test("does not flag sparse traffic", () => {
		// One request every 10 minutes: never enough in any 5-minute window.
		const rows = Array.from({ length: 12 }, (_, i) =>
			req({ timestamp: i * 600_000, inputTokens: 500 }),
		);
		expect(detectRunawayLoops(rows, opts)).toHaveLength(0);
	});

	test("does not flag bursts with dissimilar token profiles", () => {
		const rows = Array.from({ length: 12 }, (_, i) =>
			req({ timestamp: i * 10_000, inputTokens: i % 2 === 0 ? 10 : 10_000 }),
		);
		expect(detectRunawayLoops(rows, opts)).toHaveLength(0);
	});

	test("splits groups by project", () => {
		// 6 requests in each of two projects: neither reaches minRequests.
		const rows = Array.from({ length: 12 }, (_, i) =>
			req({
				timestamp: i * 10_000,
				inputTokens: 500,
				project: i % 2 === 0 ? "p1" : "p2",
			}),
		);
		expect(detectRunawayLoops(rows, opts)).toHaveLength(0);
	});

	test("flags repeated zero-token requests (e.g. failing retries)", () => {
		const rows = Array.from({ length: 12 }, (_, i) =>
			req({ timestamp: i * 5_000 }),
		);
		const loops = detectRunawayLoops(rows, opts);
		expect(loops).toHaveLength(1);
		expect(loops[0].meanInputTokens).toBe(0);
		expect(loops[0].inputTokenSpread).toBe(0);
	});

	test("merges overlapping qualifying windows into one sustained run", () => {
		// 30 requests, one every 30s (14.5 minutes total). Every 5-minute
		// window holds 10-11 requests, so the run must merge into one group.
		const rows = Array.from({ length: 30 }, (_, i) =>
			req({ timestamp: i * 30_000, inputTokens: 500 }),
		);
		const loops = detectRunawayLoops(rows, opts);
		expect(loops).toHaveLength(1);
		expect(loops[0].requests).toBe(30);
		expect(loops[0].windowStartMs).toBe(0);
		expect(loops[0].windowEndMs).toBe(29 * 30_000);
	});
});

describe("detectModelMisrouting", () => {
	const rates = new Map<string, ModelRates | null>([
		["claude-opus-4-8", OPUS_RATES],
		["claude-haiku-4-5", HAIKU_RATES],
		["mystery-model", null],
	]);
	const opts = {
		maxTotalTokens: 500,
		minOutputRateUsd: 25,
		minRequests: 5,
	};

	test("flags small calls on expensive models", () => {
		const rows = Array.from({ length: 5 }, (_, i) =>
			req({
				timestamp: i,
				inputTokens: 80,
				outputTokens: 20,
				costUsd: 0.01,
			}),
		);
		const groups = detectModelMisrouting(rows, rates, opts);
		expect(groups).toHaveLength(1);
		expect(groups[0].account).toBe("acc");
		expect(groups[0].model).toBe("claude-opus-4-8");
		expect(groups[0].requests).toBe(5);
		expect(groups[0].meanTotalTokens).toBe(100);
		expect(groups[0].outputRateUsd).toBe(75);
		expect(groups[0].totalCostUsd).toBeCloseTo(0.05, 10);
		expect(groups[0].exampleRequestIds).toHaveLength(5);
	});

	test("caps exampleRequestIds at five", () => {
		const rows = Array.from({ length: 8 }, (_, i) =>
			req({ timestamp: i, inputTokens: 100 }),
		);
		const groups = detectModelMisrouting(rows, rates, opts);
		expect(groups[0].requests).toBe(8);
		expect(groups[0].exampleRequestIds).toHaveLength(5);
	});

	test("ignores cheap models", () => {
		const rows = Array.from({ length: 5 }, () =>
			req({ model: "claude-haiku-4-5", inputTokens: 100 }),
		);
		expect(detectModelMisrouting(rows, rates, opts)).toHaveLength(0);
	});

	test("ignores models with unknown rates", () => {
		const rows = Array.from({ length: 5 }, () =>
			req({ model: "mystery-model", inputTokens: 100 }),
		);
		expect(detectModelMisrouting(rows, rates, opts)).toHaveLength(0);
	});

	test("ignores calls above the trivial-size threshold and zero-token rows", () => {
		const rows = [
			...Array.from({ length: 5 }, () => req({ inputTokens: 501 })),
			...Array.from({ length: 5 }, () => req()),
		];
		expect(detectModelMisrouting(rows, rates, opts)).toHaveLength(0);
	});

	test("requires minRequests trivial calls before flagging", () => {
		const rows = Array.from({ length: 4 }, () => req({ inputTokens: 100 }));
		expect(detectModelMisrouting(rows, rates, opts)).toHaveLength(0);
	});

	test("sorts groups by total cost descending", () => {
		const rows = [
			...Array.from({ length: 5 }, () =>
				req({ account: "cheap-acc", inputTokens: 100, costUsd: 0.01 }),
			),
			...Array.from({ length: 5 }, () =>
				req({ account: "pricey-acc", inputTokens: 100, costUsd: 0.05 }),
			),
		];
		const groups = detectModelMisrouting(rows, rates, opts);
		expect(groups.map((g) => g.account)).toEqual(["pricey-acc", "cheap-acc"]);
	});
});

describe("buildAnomalyInsightsResponse", () => {
	const rates = new Map<string, ModelRates | null>([
		["claude-opus-4-8", OPUS_RATES],
	]);

	test("echoes the effective options in meta", () => {
		const response = buildAnomalyInsightsResponse({
			rows: [],
			rates,
			options: { range: "7d" },
		});
		expect(response.meta).toEqual({
			range: "7d",
			zScoreThreshold: 3,
			minBaselineRequests: 20,
			loopWindowMinutes: 5,
			loopMinRequests: 10,
			loopSimilarityTolerance: 0.25,
			misroutingMaxTotalTokens: 500,
			misroutingMinOutputRateUsd: 25,
			misroutingMinRequests: 5,
			maxEventsPerDetector: 50,
			scannedRequests: 0,
			truncated: false,
		});
		expect(response.baselines).toHaveLength(0);
		expect(response.tokenOutliers).toHaveLength(0);
		expect(response.outputBlowups).toHaveLength(0);
		expect(response.runawayLoops).toHaveLength(0);
		expect(response.misrouting).toHaveLength(0);
	});

	test("reports scanned row count and truncation in meta", () => {
		const rows = Array.from({ length: 3 }, () => req({ inputTokens: 100 }));
		const response = buildAnomalyInsightsResponse({
			rows,
			rates,
			options: { range: "30d", truncated: true },
		});
		expect(response.meta.scannedRequests).toBe(3);
		expect(response.meta.truncated).toBe(true);
	});

	test("runs all detectors over the same rows", () => {
		const rows: AnomalyRequestRow[] = [
			// Baseline + total-token spike (also an output blowup). Totals stay
			// above misroutingMaxTotalTokens so they don't trip that detector.
			...Array.from({ length: 19 }, (_, i) =>
				req({ timestamp: i * 600_000, inputTokens: 900, outputTokens: 100 }),
			),
			req({
				id: "spike",
				timestamp: 19 * 600_000,
				inputTokens: 90_000,
				outputTokens: 10_000,
			}),
			// Runaway loop burst on another account/project; the model has no
			// known rates so the small calls don't count as misrouting.
			...Array.from({ length: 12 }, (_, i) =>
				req({
					account: "loop-acc",
					project: "loop-proj",
					model: "loop-model",
					timestamp: i * 10_000,
					inputTokens: 50,
				}),
			),
			// Misrouting: small opus calls on a third account.
			...Array.from({ length: 5 }, (_, i) =>
				req({
					account: "tiny-acc",
					timestamp: i,
					inputTokens: 50,
					outputTokens: 10,
					costUsd: 0.02,
				}),
			),
		];
		const response = buildAnomalyInsightsResponse({
			rows,
			rates,
			options: { range: "24h", minBaselineRequests: 20 },
		});
		expect(
			response.baselines.some((b) => b.account === "acc" && b.requests === 20),
		).toBe(true);
		expect(response.tokenOutliers.map((o) => o.requestId)).toEqual(["spike"]);
		expect(response.outputBlowups.map((o) => o.requestId)).toEqual(["spike"]);
		expect(response.runawayLoops).toHaveLength(1);
		expect(response.runawayLoops[0].account).toBe("loop-acc");
		expect(response.misrouting).toHaveLength(1);
		expect(response.misrouting[0].account).toBe("tiny-acc");
	});

	test("caps every detector list at maxEventsPerDetector", () => {
		const rows: AnomalyRequestRow[] = [
			...Array.from({ length: 18 }, () => req({ inputTokens: 100 })),
			req({ id: "big", inputTokens: 1000 }),
			req({ id: "bigger", inputTokens: 2000 }),
		];
		const response = buildAnomalyInsightsResponse({
			rows,
			rates,
			options: {
				range: "24h",
				minBaselineRequests: 10,
				// At 1.5 both "big" and "bigger" qualify; the cap keeps one.
				zScoreThreshold: 1.5,
				maxEventsPerDetector: 1,
			},
		});
		expect(response.tokenOutliers).toHaveLength(1);
		// The cap keeps the highest z-score.
		expect(response.tokenOutliers[0].requestId).toBe("bigger");
	});
});
