import { describe, expect, test } from "bun:test";
import type { ModelRates } from "@better-ccflare/core";
import {
	type AnomalyRequestRow,
	buildAnomalyInsightsResponse,
	computeBaselines,
	detectModelMisrouting,
	detectRunawayLoops,
	detectTokenOutliers,
	PROJECT_DISPLAY_MAX_CHARS,
	sanitizeProjectForDisplay,
} from "../anomaly-insights";

/**
 * Tests for the pure anomaly-detection math service.
 *
 * Since issue #410, baselines are computed as a log-space modified z-score
 * (median + scaled median absolute deviation, i.e. MAD) instead of a raw
 * mean/stddev. All expected numbers below are hand-recomputed from that
 * formula — NOT ported from the old mean/stddev fixtures, since the log
 * transform is nonlinear and medians/MADs do not correspond to the old
 * means/stddevs even for the same raw values.
 *
 * Formula recap:
 *   L_i = ln(v_i)
 *   medianLog = median(L_1..L_n)
 *   scaledMad = 1.4826 * median(|L_i - medianLog|)   // NOT floored; can be genuinely 0
 *   modifiedZ(x) = (ln(x) - medianLog) / scaledMad
 *
 * scaledMad is returned raw/unfloored by medianAndMad. When it is at or
 * below MIN_SCALED_MAD (an epsilon, not a floor applied to the value
 * itself), detectTokenOutliers treats the baseline as zero-variance and
 * SKIPS scoring that metric entirely (no event emitted) rather than
 * flagging every future micro-deviation — see the MIN_SCALED_MAD doc
 * comment in anomaly-insights.ts.
 *
 * A key property exploited throughout: with only two distinct values in a
 * group, the value that holds the majority (>50%) becomes both the median
 * AND makes >50% of the absolute deviations exactly 0, so the MAD collapses
 * to exactly 0 (zero-variance, skipped by detectTokenOutliers). Fixtures
 * below therefore use THREE distinct values wherever a non-degenerate MAD
 * is required for a flagging assertion, and deliberately use
 * identical/two-value fixtures where the intent IS to exercise the
 * zero-variance skip path.
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
		agentUsed: null,
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

/**
 * 19-row baseline with THREE distinct total-token values (80/100/130,
 * 6/7/6 split) so the MAD is non-degenerate. Median-of-logs lands exactly
 * on ln(100) (the value with the 7-row plurality and the middle rank of 19),
 * so medianLogTotalTokens = ln(100) exactly and approxMedianTotalTokens =
 * 100 exactly. madTotalTokens = 1.4826 * median(|L_i - ln(100)|) =
 * 1.4826 * ln(130/100) ≈ 0.330833 (the 6 values at 130 and 6 at 80 tie for
 * the largest deviation bucket at n=19, so the middle-ranked absolute
 * deviation is ln(1.3) either way by symmetry of counts... concretely:
 * sorted |L_i - ln(100)| has 7 zeros, then 12 copies of ln(1.3)-ish/ln(0.8)
 * mixed; the median (10th of 19) falls in that upper block). Verified
 * numerically; see comment on each assertion below for the precise value.
 */
function baseline19_80_100_130(
	options: { outputTokens?: number } = {},
): AnomalyRequestRow[] {
	// outputTokens is part of totalTokens, so when a non-zero outputTokens
	// is requested (to also satisfy the output-tokens baseline gate),
	// inputTokens is reduced by the same amount so the actual total-token
	// value for each row still lands exactly on 80/100/130.
	const out = options.outputTokens ?? 0;
	return [
		...Array.from({ length: 6 }, () =>
			req({ inputTokens: 80 - out, outputTokens: out }),
		),
		...Array.from({ length: 7 }, () =>
			req({ inputTokens: 100 - out, outputTokens: out }),
		),
		...Array.from({ length: 6 }, () =>
			req({ inputTokens: 130 - out, outputTokens: out }),
		),
	];
}

/**
 * Same shape as baseline19_80_100_130 but for the output-tokens metric
 * (8/10/13). inputTokens is fixed at 1000 (large relative to any scoring
 * row used against this baseline's total_tokens metric in these tests) so
 * the output-tokens signal can be isolated from the total-tokens signal:
 * a row that blows up outputTokens without a matching jump in totalTokens
 * should flag on the output_tokens metric only, never on total_tokens.
 */
function baseline19Output_8_10_13(
	overrides: Partial<AnomalyRequestRow> = {},
): AnomalyRequestRow[] {
	return [
		...Array.from({ length: 6 }, () =>
			req({ inputTokens: 1000, outputTokens: 8, ...overrides }),
		),
		...Array.from({ length: 7 }, () =>
			req({ inputTokens: 1000, outputTokens: 10, ...overrides }),
		),
		...Array.from({ length: 6 }, () =>
			req({ inputTokens: 1000, outputTokens: 13, ...overrides }),
		),
	];
}

describe("computeBaselines", () => {
	test("computes median and scaled-MAD in log space per account/model", () => {
		// 5 rows at 90 total tokens (input only), 5 rows at 110. Median of the
		// 10 ln-values is the average of the two middle-ranked logs:
		// (ln(90) + ln(110)) / 2 = 4.6001450... — NOT ln(100), because the
		// even-count median averages the two central *log* values, and
		// ln is nonlinear (this differs from the old linear mean, which
		// WAS exactly 100).
		//
		// MAD: every |L_i - medianLog| is |ln(90) - medianLog| = |ln(110) -
		// medianLog| = (ln(110) - ln(90)) / 2 = 0.1002532... (all 10 rows tie),
		// so scaledMad = 1.4826 * 0.1002532... = 0.1487572...
		const rows = [
			...Array.from({ length: 5 }, () =>
				req({ inputTokens: 90, outputTokens: 0 }),
			),
			...Array.from({ length: 5 }, () =>
				req({ inputTokens: 110, outputTokens: 0 }),
			),
		];
		// This fixture has outputTokens: 0 throughout, so no output baseline
		// can be formed (min=10 requires >=10 rows with outputTokens>0) —
		// covered by a dedicated test below. Both metrics gate the same
		// baseline entry, so carve an output-tokens signal (9 / 11) out of
		// each row's inputTokens (not on top of it) so totalTokens stays
		// exactly on 90/110 for both halves.
		const rowsWithOutput = rows.map((row, i) =>
			i < 5
				? { ...row, inputTokens: row.inputTokens - 9, outputTokens: 9 }
				: { ...row, inputTokens: row.inputTokens - 11, outputTokens: 11 },
		);
		const baselines = computeBaselines(rowsWithOutput, 10);
		expect(baselines).toHaveLength(1);
		const b = baselines[0];
		expect(b.account).toBe("acc");
		expect(b.model).toBe("claude-opus-4-8");
		expect(b.requests).toBe(10);
		expect(b.medianLogTotalTokens).toBeCloseTo(4.600145, 5);
		expect(b.madTotalTokens).toBeCloseTo(0.148757, 5);
		expect(b.approxMedianTotalTokens).toBeCloseTo(99.498744, 4);
		expect(b.medianLogOutputTokens).toBeCloseTo(2.29756, 5);
		expect(b.madOutputTokens).toBeCloseTo(0.148757, 5);
		expect(b.approxMedianOutputTokens).toBeCloseTo(9.949874, 4);
	});

	test("total tokens sum input, cache read, cache creation and output", () => {
		// Two-value split (100 total x5, 120 total x5; output 40 x5, 60 x5)
		// so there's real spread to compute a non-trivial MAD, while still
		// keeping the "sum of four token fields" property under test.
		const rows = [
			...Array.from({ length: 5 }, () =>
				req({
					inputTokens: 10,
					cacheReadInputTokens: 20,
					cacheCreationInputTokens: 30,
					outputTokens: 40,
				}),
			),
			...Array.from({ length: 5 }, () =>
				req({
					inputTokens: 10,
					cacheReadInputTokens: 20,
					cacheCreationInputTokens: 30,
					outputTokens: 60,
				}),
			),
		];
		const baselines = computeBaselines(rows, 10);
		// medianLog over [ln(100) x5, ln(120) x5] = (ln(100)+ln(120))/2 = 4.696331
		expect(baselines[0].medianLogTotalTokens).toBeCloseTo(4.696331, 5);
		expect(baselines[0].approxMedianTotalTokens).toBeCloseTo(109.544512, 4);
		expect(baselines[0].medianLogOutputTokens).toBeCloseTo(3.891612, 5);
		expect(baselines[0].approxMedianOutputTokens).toBeCloseTo(48.989795, 4);
	});

	test("excludes zero-token rows from the baseline", () => {
		const tokenRows = [
			...Array.from({ length: 10 }, () =>
				req({ inputTokens: 100, outputTokens: 10 }),
			),
			...Array.from({ length: 10 }, () => req()), // failed requests, no tokens
		];
		const baselines = computeBaselines(tokenRows, 10);
		expect(baselines).toHaveLength(1);
		expect(baselines[0].requests).toBe(10);
		// totalTokens = inputTokens + outputTokens = 100 + 10 = 110 per row.
		expect(baselines[0].approxMedianTotalTokens).toBeCloseTo(110, 6);
	});

	test("omits groups below minBaselineRequests", () => {
		const rows = Array.from({ length: 9 }, () =>
			req({ inputTokens: 100, outputTokens: 10 }),
		);
		expect(computeBaselines(rows, 10)).toHaveLength(0);
	});

	test("groups separately per account and model, normalizing null to Unknown", () => {
		const rows = [
			...Array.from({ length: 3 }, () =>
				req({ account: "a1", model: "m1", inputTokens: 100, outputTokens: 10 }),
			),
			...Array.from({ length: 3 }, () =>
				req({ account: "a1", model: "m2", inputTokens: 200, outputTokens: 20 }),
			),
			...Array.from({ length: 3 }, () =>
				req({ account: null, model: null, inputTokens: 300, outputTokens: 30 }),
			),
		];
		const baselines = computeBaselines(rows, 3);
		expect(baselines).toHaveLength(3);
		const unknown = baselines.find((b) => b.account === "Unknown");
		expect(unknown?.model).toBe("Unknown");
		// All-identical-value group: totalTokens = inputTokens + outputTokens
		// = 300 + 30 = 330 per row, so medianLog = ln(330) exactly.
		expect(unknown?.approxMedianTotalTokens).toBeCloseTo(330, 6);
	});

	test("output-tokens metric requires >= minBaselineRequests rows with outputTokens > 0, but does not sink the total-tokens side (issue #410 review fix)", () => {
		// 10 rows with total tokens = 100 (qualifies the total-tokens gate),
		// but only 6 of them have outputTokens > 0 (< minBaselineRequests=10).
		// The two metrics now qualify INDEPENDENTLY: the group still emits a
		// baseline entry with a valid total-tokens side, while the
		// output-tokens side is marked invalid (null) rather than the whole
		// entry being dropped.
		const rows = [
			...Array.from({ length: 6 }, () =>
				req({ inputTokens: 80, outputTokens: 20 }),
			),
			...Array.from({ length: 4 }, () => req({ inputTokens: 100 })),
		];
		const baselines = computeBaselines(rows, 10);
		expect(baselines).toHaveLength(1);
		expect(baselines[0].requests).toBe(10);
		expect(baselines[0].medianLogTotalTokens).not.toBeNull();
		expect(baselines[0].madTotalTokens).not.toBeNull();
		expect(baselines[0].medianLogOutputTokens).toBeNull();
		expect(baselines[0].madOutputTokens).toBeNull();
		expect(baselines[0].approxMedianOutputTokens).toBeNull();
	});

	test("the 'no baseline for this metric' sentinel is null, not NaN, and survives a JSON round-trip as literal null (issue #410 follow-up)", () => {
		// Regression: NaN was previously used as the internal "no baseline for
		// this metric" sentinel, but JSON.stringify(NaN) produces `null` on
		// the wire while AnomalyBaseline declared these fields as
		// non-nullable `number` — a type-contract violation. The sentinel is
		// now an explicit `null`, which both matches the declared
		// `number | null` type AND round-trips through JSON unchanged.
		const rows = [
			...Array.from({ length: 6 }, () =>
				req({ inputTokens: 80, outputTokens: 20 }),
			),
			...Array.from({ length: 4 }, () => req({ inputTokens: 100 })),
		];
		const baselines = computeBaselines(rows, 10);
		const baseline = baselines[0];
		expect(baseline.medianLogOutputTokens).toBeNull();
		expect(baseline.madOutputTokens).toBeNull();
		expect(baseline.approxMedianOutputTokens).toBeNull();

		const roundTripped = JSON.parse(JSON.stringify(baseline));
		expect(roundTripped.medianLogOutputTokens).toBeNull();
		expect(roundTripped.madOutputTokens).toBeNull();
		expect(roundTripped.approxMedianOutputTokens).toBeNull();
		// The fields must be PRESENT (not omitted) in the serialized JSON.
		expect(Object.hasOwn(roundTripped, "medianLogOutputTokens")).toBe(true);
		expect(Object.hasOwn(roundTripped, "madOutputTokens")).toBe(true);
		expect(Object.hasOwn(roundTripped, "approxMedianOutputTokens")).toBe(true);
	});

	test("a group with enough total-tokens rows but too few output-tokens rows still supports total-tokens outlier detection, while output-tokens produces none", () => {
		// 25 rows qualifying the total-tokens gate (minBaselineRequests=10)
		// with a 3-value spread (80/100/130-ish, scaled) for a non-degenerate
		// total-tokens MAD, but only 3 of them have outputTokens > 0 — well
		// below the minBaselineRequests=10 gate for the output-tokens side.
		const rows = [
			...Array.from({ length: 8 }, () => req({ inputTokens: 80 })),
			...Array.from({ length: 9 }, () => req({ inputTokens: 100 })),
			...Array.from({ length: 8 }, () =>
				req({ inputTokens: 130, outputTokens: 0 }),
			),
		].map((row, i) => (i < 3 ? { ...row, outputTokens: 5 } : row));
		const baselines = computeBaselines(rows, 10);
		expect(baselines).toHaveLength(1);
		expect(baselines[0].requests).toBe(25);
		expect(baselines[0].madTotalTokens).not.toBeNull();
		expect(baselines[0].madOutputTokens).toBeNull();

		// total_tokens outlier detection still works against this baseline.
		const spike = [req({ id: "total-spike", inputTokens: 100_000 })];
		const totalOutliers = detectTokenOutliers(
			spike,
			baselines,
			3.5,
			"total_tokens",
		);
		expect(totalOutliers).toHaveLength(1);
		expect(totalOutliers[0].requestId).toBe("total-spike");

		// output_tokens detection produces no events for this group — there is
		// no valid baseline for that metric to compare against.
		const outputSpike = [
			req({ id: "output-spike", inputTokens: 100, outputTokens: 100_000 }),
		];
		const outputOutliers = detectTokenOutliers(
			outputSpike,
			baselines,
			3.5,
			"output_tokens",
		);
		expect(outputOutliers).toHaveLength(0);
	});

	test("omits the group entirely only when NEITHER metric has enough qualifying rows", () => {
		const rows = Array.from({ length: 9 }, () =>
			req({ inputTokens: 100, outputTokens: 10 }),
		);
		expect(computeBaselines(rows, 10)).toHaveLength(0);
	});

	test("excludes rows with NEGATIVE total tokens (not just zero), preventing NaN from Math.log (issue #410 follow-up)", () => {
		// Regression: the original #410 fix only excluded totalTokens === 0.
		// A row with a large negative inputTokens (e.g. a corrupted/negative
		// usage record) produces a negative totalTokens, and Math.log() of a
		// negative number is NaN. That NaN must never enter the log-space
		// median/MAD computation — the guard must be `<= 0`, not `=== 0`.
		const rows = [
			...Array.from({ length: 10 }, () =>
				req({ inputTokens: 100, outputTokens: 10 }),
			),
			// Negative totalTokens: -50 + 10 = -40.
			req({ id: "negative-total", inputTokens: -50, outputTokens: 10 }),
		];
		const baselines = computeBaselines(rows, 10);
		expect(baselines).toHaveLength(1);
		// Only the 10 well-formed rows contribute; the negative-total row is
		// excluded entirely.
		expect(baselines[0].requests).toBe(10);
		expect(Number.isNaN(baselines[0].medianLogTotalTokens)).toBe(false);
		expect(Number.isNaN(baselines[0].madTotalTokens as number)).toBe(false);
		expect(baselines[0].approxMedianTotalTokens).toBeCloseTo(110, 6);
	});

	test("excludes rows with NEGATIVE outputTokens from the output-tokens baseline (issue #410 follow-up)", () => {
		// Symmetry check for the output-tokens metric, which already guarded
		// with `row.outputTokens <= 0` prior to this fix — confirm negative
		// values (not just zero) are excluded and never produce NaN.
		const rows = [
			...Array.from({ length: 10 }, () =>
				req({ inputTokens: 100, outputTokens: 10 }),
			),
			// Positive totalTokens overall (110) but negative outputTokens
			// itself: inputTokens 150, outputTokens -40 => total = 110.
			req({ id: "negative-output", inputTokens: 150, outputTokens: -40 }),
		];
		const baselines = computeBaselines(rows, 10);
		expect(baselines).toHaveLength(1);
		// The negative-output row still has positive totalTokens (110), so it
		// contributes to the total-tokens side, but must be excluded from the
		// output-tokens side by the `outputTokens > 0` filter.
		expect(baselines[0].requests).toBe(11);
		expect(Number.isNaN(baselines[0].medianLogOutputTokens as number)).toBe(
			false,
		);
		expect(Number.isNaN(baselines[0].madOutputTokens as number)).toBe(false);
		// All 10 output-qualifying rows have outputTokens = 10, so the
		// output-tokens median is exactly 10.
		expect(baselines[0].approxMedianOutputTokens).toBeCloseTo(10, 6);
	});
});

describe("detectTokenOutliers", () => {
	test("flags requests at or above the z-score threshold (total_tokens)", () => {
		const baselineRows = baseline19_80_100_130({ outputTokens: 10 });
		const baselines = computeBaselines(baselineRows, 10);
		expect(baselines).toHaveLength(1);
		// medianLogTotalTokens = ln(100) exactly; madTotalTokens ~ 0.330833
		expect(baselines[0].medianLogTotalTokens).toBeCloseTo(Math.log(100), 10);
		expect(baselines[0].madTotalTokens).toBeCloseTo(0.330833, 5);

		const scoringRows = [req({ id: "spike", inputTokens: 1000 })];
		const outliers = detectTokenOutliers(
			scoringRows,
			baselines,
			3.5,
			"total_tokens",
		);
		expect(outliers).toHaveLength(1);
		expect(outliers[0].requestId).toBe("spike");
		expect(outliers[0].metric).toBe("total_tokens");
		expect(outliers[0].value).toBe(1000);
		expect(outliers[0].baselineMedianLog).toBeCloseTo(Math.log(100), 10);
		expect(outliers[0].baselineMad).toBeCloseTo(0.330833, 5);
		expect(outliers[0].approxBaselineMedian).toBeCloseTo(100, 6);
		expect(outliers[0].zScore).toBeCloseTo(6.95997, 5);
	});

	test("does not flag low-side outliers", () => {
		// Baseline 800/1000/1300 x19 (same 6/7/6 shape, scaled x10 from the
		// 80/100/130 fixture). A scoring row far BELOW the baseline (100)
		// produces a large-magnitude NEGATIVE z-score and must never be
		// reported.
		const baselineRows = [
			...Array.from({ length: 6 }, () => req({ inputTokens: 800 })),
			...Array.from({ length: 7 }, () => req({ inputTokens: 1000 })),
			...Array.from({ length: 6 }, () => req({ inputTokens: 1300 })),
		];
		const baselines = computeBaselines(baselineRows, 10);
		const scoringRows = [req({ inputTokens: 100 })];
		expect(
			detectTokenOutliers(scoringRows, baselines, 3.5, "total_tokens"),
		).toHaveLength(0);
	});

	test("does not flag a value equal to a constant (zero-variance) baseline", () => {
		// All-identical baseline: scaledMad is genuinely 0 (no longer floored
		// by medianAndMad), so an EXACT match to the median is skipped (no
		// signal to score against either way).
		const baselineRows = Array.from({ length: 10 }, () =>
			req({ inputTokens: 100, outputTokens: 10 }),
		);
		const baselines = computeBaselines(baselineRows, 10);
		const scoringRows = [req({ inputTokens: 100 })];
		expect(
			detectTokenOutliers(scoringRows, baselines, 3.5, "total_tokens"),
		).toHaveLength(0);
	});

	test("zero-variance baseline is SKIPPED, not flagged: neither a tiny nor a huge deviation produces an event (issue #410 review fix)", () => {
		// Regression: before this fix, a zero-variance baseline's scaledMad
		// was floored to a tiny epsilon (1e-9), which made ANY differing
		// value produce a z-score in the millions — always past the default
		// 3.5 threshold. This mirrors the OLD pre-#410 `if (stdDev <= 0)
		// continue;` behavior: a genuinely zero-variance baseline carries no
		// signal, so it must be skipped entirely, not turned into an
		// alert-storm trigger. All 20 baseline requests use exactly 500
		// tokens (deterministic traffic, e.g. a fixed-size health check).
		const baselineRows = Array.from({ length: 20 }, () =>
			req({ inputTokens: 500 }),
		);
		const baselines = computeBaselines(baselineRows, 10);
		expect(baselines).toHaveLength(1);

		// A slightly different value (501 tokens, ~0.2% deviation).
		const slightlyDifferent = [req({ id: "slight", inputTokens: 501 })];
		expect(
			detectTokenOutliers(slightlyDifferent, baselines, 3.5, "total_tokens"),
		).toHaveLength(0);

		// A wildly different value (50000 tokens, 100x the baseline) — still
		// intentionally not flagged, since there is no baseline signal at
		// all to compare against (conservative, matching pre-#410 behavior).
		const wildlyDifferent = [req({ id: "wild", inputTokens: 50_000 })];
		expect(
			detectTokenOutliers(wildlyDifferent, baselines, 3.5, "total_tokens"),
		).toHaveLength(0);
	});

	test("returns nothing for groups without a baseline", () => {
		const scoringRows = spikeRows();
		expect(
			detectTokenOutliers(scoringRows, [], 3.5, "total_tokens"),
		).toHaveLength(0);
	});

	test("skips scoring rows with outputTokens <= 0 for the output_tokens metric", () => {
		const baselineRows = baseline19Output_8_10_13();
		const baselines = computeBaselines(baselineRows, 10);
		const scoringRows = [req({ inputTokens: 100, outputTokens: 0 })];
		expect(
			detectTokenOutliers(scoringRows, baselines, 3.5, "output_tokens"),
		).toHaveLength(0);
	});

	test("skips scoring rows with NEGATIVE totalTokens instead of leaking a NaN zScore into outliers (issue #410 follow-up)", () => {
		// Regression: reported by zenprocess. A scoring row with negative
		// totalTokens produces Math.log(negative) = NaN. Because the skip
		// condition was `if (modifiedZ < zScoreThreshold) continue;`, and
		// `NaN < threshold` is `false` in JS, the row was NOT skipped and a
		// `zScore: NaN` event leaked into the API response. The guard must
		// exclude totalTokens <= 0 (not just === 0) so the row never reaches
		// the modifiedZ computation at all.
		const baselineRows = baseline19_80_100_130({ outputTokens: 10 });
		const baselines = computeBaselines(baselineRows, 10);
		expect(baselines).toHaveLength(1);

		const scoringRows = [
			// Negative totalTokens: -200 + 10 = -190.
			req({ id: "negative-total", inputTokens: -200, outputTokens: 10 }),
			// A genuine, well-formed outlier alongside it, to prove the guard
			// only removes the malformed row and doesn't over-suppress.
			req({ id: "spike", inputTokens: 1000 }),
		];
		const outliers = detectTokenOutliers(
			scoringRows,
			baselines,
			3.5,
			"total_tokens",
		);
		// The negative row must be absent entirely — not present with a NaN
		// zScore.
		expect(outliers.map((o) => o.requestId)).not.toContain("negative-total");
		expect(outliers.some((o) => Number.isNaN(o.zScore))).toBe(false);
		// The well-formed spike is still flagged normally.
		expect(outliers.map((o) => o.requestId)).toEqual(["spike"]);
	});

	test("skips scoring rows with NEGATIVE outputTokens for the output_tokens metric (issue #410 follow-up)", () => {
		// Symmetry check: a row with negative outputTokens (but positive
		// totalTokens overall) must never produce a NaN zScore on the
		// output_tokens metric either.
		const baselineRows = baseline19Output_8_10_13();
		const baselines = computeBaselines(baselineRows, 10);
		expect(baselines).toHaveLength(1);

		const scoringRows = [
			// totalTokens = 1000 + (-40) = 960 (positive), but outputTokens
			// itself is negative.
			req({ id: "negative-output", inputTokens: 1000, outputTokens: -40 }),
			req({ id: "blowup", inputTokens: 100, outputTokens: 100 }),
		];
		const outliers = detectTokenOutliers(
			scoringRows,
			baselines,
			3.5,
			"output_tokens",
		);
		expect(outliers.map((o) => o.requestId)).not.toContain("negative-output");
		expect(outliers.some((o) => Number.isNaN(o.zScore))).toBe(false);
		expect(outliers.map((o) => o.requestId)).toEqual(["blowup"]);
	});

	test("output_tokens metric detects output blowups independently", () => {
		const baselineRows = baseline19Output_8_10_13();
		const baselines = computeBaselines(baselineRows, 10);
		expect(baselines[0].medianLogOutputTokens).toBeCloseTo(Math.log(10), 10);
		expect(baselines[0].madOutputTokens).toBeCloseTo(0.330833, 5);

		const scoringRows = [
			req({ id: "blowup", inputTokens: 100, outputTokens: 100 }),
		];
		expect(
			detectTokenOutliers(scoringRows, baselines, 3.5, "total_tokens"),
		).toHaveLength(0);
		const blowups = detectTokenOutliers(
			scoringRows,
			baselines,
			3.5,
			"output_tokens",
		);
		expect(blowups).toHaveLength(1);
		expect(blowups[0].requestId).toBe("blowup");
		expect(blowups[0].metric).toBe("output_tokens");
		expect(blowups[0].zScore).toBeCloseTo(6.95997, 5);
	});

	test("sorts outliers by z-score descending", () => {
		const baselineRows = baseline19_80_100_130({ outputTokens: 10 });
		const baselines = computeBaselines(baselineRows, 10);
		const scoringRows = [
			req({ id: "big", inputTokens: 300 }),
			req({ id: "bigger", inputTokens: 600 }),
		];
		// z(300) ~ 3.320750, z(600) ~ 5.415909 against medianLog=ln(100), mad~0.330833
		const outliers = detectTokenOutliers(
			scoringRows,
			baselines,
			3,
			"total_tokens",
		);
		expect(outliers.map((o) => o.requestId)).toEqual(["bigger", "big"]);
		expect(outliers[0].zScore).toBeCloseTo(5.415909, 5);
		expect(outliers[1].zScore).toBeCloseTo(3.32075, 5);
	});

	test("baseline computation is independent of which rows are scored (leave-one-out contract)", () => {
		// Regression for #410: baselineRows and scoringRows are decoupled row
		// sets. Prove the baseline stats are bit-for-bit identical whichever
		// scoringRows slice is later scored against them.
		const baselineRows = baseline19_80_100_130({ outputTokens: 10 });
		const baselinesA = computeBaselines(baselineRows, 10);
		const baselinesB = computeBaselines(baselineRows, 10);
		expect(baselinesA).toEqual(baselinesB);

		const scoringA = [req({ inputTokens: 500 })];
		const scoringB = [req({ inputTokens: 900 }), req({ inputTokens: 50 })];
		const outliersA = detectTokenOutliers(
			scoringA,
			baselinesA,
			3,
			"total_tokens",
		);
		const outliersB = detectTokenOutliers(
			scoringB,
			baselinesB,
			3,
			"total_tokens",
		);
		// Whichever rows are scored, both draw on the SAME baseline numbers.
		expect(outliersA[0]?.baselineMedianLog).toBeCloseTo(
			outliersB[0]?.baselineMedianLog ?? Number.NaN,
			10,
		);
		expect(baselinesA[0].medianLogTotalTokens).toBeCloseTo(Math.log(100), 10);
	});

	test("regression: a moderately-above-pack value against a large baseline does NOT flag (cap is gone, not loosened)", () => {
		// n=200 lognormal-ish baseline centered near 100 (sigma ~0.15 in log
		// space), generated with a fixed LCG seed for reproducibility.
		// approxMedianTotalTokens ~ 99.620083, madTotalTokens ~ 0.184808.
		const baselineRows = lognormalBaselineRows(200, 7, 100, 0.15);
		const baselines = computeBaselines(baselineRows, 10);
		expect(baselines).toHaveLength(1);
		expect(baselines[0].approxMedianTotalTokens).toBeCloseTo(99.620083, 4);
		expect(baselines[0].madTotalTokens).toBeCloseTo(0.184808, 5);

		// z(180) ~ 3.201121 — clearly above the pack but under the 3.5
		// default threshold, so it must NOT flag.
		const scoringRows = [req({ id: "moderate", inputTokens: 180 })];
		expect(
			detectTokenOutliers(scoringRows, baselines, 3.5, "total_tokens"),
		).toHaveLength(0);
	});

	test("regression: a genuine 100x outlier against a large baseline DOES flag with z far beyond any sqrt(n-1) ceiling", () => {
		const baselineRows = lognormalBaselineRows(200, 7, 100, 0.15);
		const baselines = computeBaselines(baselineRows, 10);
		const approxMedian = baselines[0].approxMedianTotalTokens;
		const spikeValue = Math.round(approxMedian * 100);

		const scoringRows = [req({ id: "huge-spike", inputTokens: spikeValue })];
		const outliers = detectTokenOutliers(
			scoringRows,
			baselines,
			3.5,
			"total_tokens",
		);
		expect(outliers).toHaveLength(1);
		// sqrt(n-1) for any realistic baseline size (even n=1000) tops out
		// around 31.6; a z-score of ~24.9 here already exceeds what any
		// n <= 200 population-stddev ceiling could produce (sqrt(199) ~
		// 14.1), and there is no n for which the OLD formula could even
		// reach this magnitude from a single self-inclusive spike without
		// dominating the mean itself. Assert well clear of 10 to make the
		// "no ceiling" property unambiguous.
		expect(outliers[0].zScore).toBeGreaterThan(10);
		expect(outliers[0].zScore).toBeCloseTo(24.918659, 4);
	});

	test("regression: reproduces the reporter's n=24 shape and the z-score is NOT sqrt(23) (~4.7959)", () => {
		// The original bug (issue #410): with a self-inclusive population of
		// 24 rows (23 baseline + the scored row itself), the OLD mean/stddev
		// formula mathematically CAPPED the z-score at sqrt(23) ~ 4.7959,
		// regardless of how extreme the spike was. The new formula has no
		// such structural cap.
		const baselineRows = lognormalBaselineRows(23, 13, 100, 0.1);
		const baselines = computeBaselines(baselineRows, 10);
		expect(baselines).toHaveLength(1);
		expect(baselines[0].approxMedianTotalTokens).toBeCloseTo(98.68755, 4);
		expect(baselines[0].madTotalTokens).toBeCloseTo(0.096415, 5);

		// scoringRows is disjoint from baselineRows (the row being scored
		// here was never part of the 23-row baseline population).
		const scoringRows = [req({ id: "spike", inputTokens: 1000 })];
		const outliers = detectTokenOutliers(
			scoringRows,
			baselines,
			3.5,
			"total_tokens",
		);
		expect(outliers).toHaveLength(1);
		expect(Math.abs(outliers[0].zScore - Math.sqrt(23))).toBeGreaterThan(0.5);
		expect(outliers[0].zScore).toBeCloseTo(24.019106, 4);
	});
});

/**
 * Deterministic pseudo-lognormal baseline row generator: `n` rows whose
 * total tokens are drawn from a lognormal distribution centered at
 * `centerValue` with log-space spread `sigma`, using a fixed linear
 * congruential generator seeded with `seed` so results are 100%
 * reproducible across runs (no reliance on Math.random).
 */
function lognormalBaselineRows(
	n: number,
	seed: number,
	centerValue: number,
	sigma: number,
): AnomalyRequestRow[] {
	let s = seed;
	const rand = () => {
		s = (s * 9301 + 49297) % 233280;
		return s / 233280;
	};
	const rows: AnomalyRequestRow[] = [];
	for (let i = 0; i < n; i++) {
		const u1 = rand();
		const u2 = rand();
		const gaussian = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
		// `value` is the intended TOTAL token count for the row. outputTokens
		// is carved out of it (rather than added on top) so the row's actual
		// totalTokens (inputTokens + outputTokens) still equals `value`
		// exactly — this keeps the total-tokens baseline numbers matching
		// what was generated, while still giving the output-tokens metric a
		// non-trivial (if noisier) signal to compute its own baseline from.
		const value = Math.exp(Math.log(centerValue) + sigma * gaussian);
		const outputTokens = Math.max(1, Math.round(value / 10));
		rows.push(
			req({
				inputTokens: value - outputTokens,
				outputTokens,
			}),
		);
	}
	return rows;
}

describe("detectRunawayLoops", () => {
	const opts = {
		windowMs: 5 * 60_000,
		minRequests: 10,
		similarityTolerance: 0.25,
	};

	test("flags a dense burst of near-identical requests", () => {
		// 12 requests, one every 10s, identical token profile, same agent.
		const rows = Array.from({ length: 12 }, (_, i) =>
			req({
				timestamp: i * 10_000,
				inputTokens: 500,
				project: "proj",
				agentUsed: "agent-a",
			}),
		);
		const loops = detectRunawayLoops(rows, opts);
		expect(loops).toHaveLength(1);
		expect(loops[0].account).toBe("acc");
		expect(loops[0].project).toBe("proj");
		expect(loops[0].agentUsed).toBe("agent-a");
		expect(loops[0].requests).toBe(12);
		expect(loops[0].windowStartMs).toBe(0);
		expect(loops[0].windowEndMs).toBe(110_000);
		expect(loops[0].meanRequestSideTokens).toBe(500);
		expect(loops[0].requestSideTokenSpread).toBe(0);
		// 12 requests over 110s
		expect(loops[0].requestsPerMinute).toBeCloseTo((12 * 60_000) / 110_000, 6);
	});

	test("does not flag sparse traffic", () => {
		// One request every 10 minutes: never enough in any 5-minute window.
		const rows = Array.from({ length: 12 }, (_, i) =>
			req({ timestamp: i * 600_000, inputTokens: 500, agentUsed: "agent-a" }),
		);
		expect(detectRunawayLoops(rows, opts)).toHaveLength(0);
	});

	test("does not flag bursts with dissimilar token profiles", () => {
		const rows = Array.from({ length: 12 }, (_, i) =>
			req({
				timestamp: i * 10_000,
				inputTokens: i % 2 === 0 ? 10 : 10_000,
				agentUsed: "agent-a",
			}),
		);
		expect(detectRunawayLoops(rows, opts)).toHaveLength(0);
	});

	test("splits groups by project when agent id is absent", () => {
		// Regression guard for issue #367: when no agent attribution is
		// present (live traffic — `agent_used` is NULL on 100% of
		// rows), the project must still split the bucket. 6 requests in
		// each of two projects: neither reaches minRequests, and the
		// combined 12-row bucket would falsely report as a loop if the
		// key dropped project entirely.
		const rows = Array.from({ length: 12 }, (_, i) =>
			req({
				timestamp: i * 10_000,
				inputTokens: 500,
				project: i % 2 === 0 ? "p1" : "p2",
				agentUsed: null,
			}),
		);
		expect(detectRunawayLoops(rows, opts)).toHaveLength(0);
	});

	test("does NOT flag parallel-fleet traffic from N distinct agents", () => {
		// Production evidence (issue #367): a fleet of independent workers
		// shared one (account, model, project). Each worker ran its own
		// agent and did modest per-agent traffic. With the old
		// (account, model, project) keying the fleet collapsed into ONE
		// bucket and the burst looked like a runaway loop (97 CRITICAL
		// pages in 3h). With per-agent keying the burst splits into N
		// buckets, each below opts.minRequests, and no loop fires.
		//
		// To produce a definitive negative-control shape:
		//   - Per-worker count (9) is below opts.minRequests (10).
		//   - Per-worker tokens are identical (CoV = 0) — without the fix,
		//     the combined 108-row bucket has CoV = 0 and clearly qualifies.
		const rows: AnomalyRequestRow[] = [];
		const workerCount = 12;
		const requestsPerWorker = 9; // < opts.minRequests = 10
		for (let w = 0; w < workerCount; w++) {
			for (let r = 0; r < requestsPerWorker; r++) {
				rows.push(
					req({
						timestamp: r * 1100 + w * 13, // slight per-agent skew
						inputTokens: 500, // identical across one worker
						cacheReadInputTokens: 0,
						project: "fleet-proj",
						agentUsed: `worker-${w}`,
					}),
				);
			}
		}
		const loops = detectRunawayLoops(rows, opts);
		expect(loops).toHaveLength(0);
	});

	test("DOES flag a single agent repeating the same request (true loop)", () => {
		// The reverse case: one agent / one session, repeating the same
		// request shape many times inside one window.
		const rows = Array.from({ length: 12 }, (_, i) =>
			req({
				timestamp: i * 10_000,
				inputTokens: 500,
				project: "proj",
				agentUsed: "agent-a",
			}),
		);
		const loops = detectRunawayLoops(rows, opts);
		expect(loops).toHaveLength(1);
		expect(loops[0].agentUsed).toBe("agent-a");
		expect(loops[0].requests).toBe(12);
	});

	test("N concurrent distinct sessions do NOT fire, one session repeating DOES", () => {
		// Mirrors the live fleet: the only stable per-worker signal
		// is the x-claude-code-session-id header, surfaced as agentUsed
		// via the session_header attribution source. 12 concurrent
		// distinct sessions, 9 requests each — none should reach
		// opts.minRequests (10) on its own. Then one session repeats
		// 12 times — that bucket DOES fire.
		const concurrentSessions = 12;
		const requestsPerSession = 9; // < opts.minRequests (10)
		const concurrentRows: AnomalyRequestRow[] = [];
		for (let s = 0; s < concurrentSessions; s++) {
			for (let r = 0; r < requestsPerSession; r++) {
				concurrentRows.push(
					req({
						timestamp: r * 1_100 + s * 13, // slight per-session skew
						inputTokens: 500,
						project: "fleet-proj",
						agentUsed: `sess-${s}`,
					}),
				);
			}
		}
		expect(detectRunawayLoops(concurrentRows, opts)).toHaveLength(0);

		// One session repeating 12 times in one window => exactly one loop.
		const repeatingRows = Array.from({ length: 12 }, (_, i) =>
			req({
				timestamp: i * 10_000,
				inputTokens: 500,
				project: "fleet-proj",
				agentUsed: "sess-0",
			}),
		);
		const loops = detectRunawayLoops(repeatingRows, opts);
		expect(loops).toHaveLength(1);
		expect(loops[0].agentUsed).toBe("sess-0");
		expect(loops[0].requests).toBe(12);
	});

	test("flags repeated zero-token requests (e.g. failing retries)", () => {
		const rows = Array.from({ length: 12 }, (_, i) =>
			req({ timestamp: i * 5_000, agentUsed: "agent-a" }),
		);
		const loops = detectRunawayLoops(rows, opts);
		expect(loops).toHaveLength(1);
		expect(loops[0].meanRequestSideTokens).toBe(0);
		expect(loops[0].requestSideTokenSpread).toBe(0);
	});

	test("reports adjacent bursts with different profiles as separate loops", () => {
		// Burst A: 12 requests at 100 tokens (t = 0..110s). Burst B: 12
		// requests at 10000 tokens (t = 120s..230s). Both fit inside one
		// 5-minute window, so a post-merge similarity check would drop both;
		// per-window qualification must report each burst on its own.
		const rows = [
			...Array.from({ length: 12 }, (_, i) =>
				req({ timestamp: i * 10_000, inputTokens: 100, agentUsed: "agent-a" }),
			),
			...Array.from({ length: 12 }, (_, i) =>
				req({
					timestamp: 120_000 + i * 10_000,
					inputTokens: 10_000,
					agentUsed: "agent-a",
				}),
			),
		];
		const loops = detectRunawayLoops(rows, opts);
		expect(loops).toHaveLength(2);
		const means = loops
			.map((loop) => loop.meanRequestSideTokens)
			.sort((a, b) => a - b);
		expect(means).toEqual([100, 10_000]);
		for (const loop of loops) {
			expect(loop.requests).toBe(12);
			expect(loop.requestSideTokenSpread).toBe(0);
		}
	});

	test("merges overlapping qualifying windows into one sustained run", () => {
		// 30 requests, one every 30s (14.5 minutes total). Every 5-minute
		// window holds 10-11 requests, so the run must merge into one group.
		const rows = Array.from({ length: 30 }, (_, i) =>
			req({ timestamp: i * 30_000, inputTokens: 500, agentUsed: "agent-a" }),
		);
		const loops = detectRunawayLoops(rows, opts);
		expect(loops).toHaveLength(1);
		expect(loops[0].requests).toBe(30);
		expect(loops[0].windowStartMs).toBe(0);
		expect(loops[0].windowEndMs).toBe(29 * 30_000);
	});

	test("distinct projects that share a 63-char prefix do NOT collapse into one loop", () => {
		// Regression for Greptile review on PR #369: toAnomalyRow used to
		// call sanitizeProjectForDisplay BEFORE handing rows to the
		// detectors, so any project longer than 64 chars was sliced to 63
		// chars + ellipsis. Two projects that share their first 63 chars
		// and differ at byte 64 (or beyond) collapse to the same display
		// value, and the (account, model, project) grouping key in
		// detectRunawayLoops then merges them into one loop. After the fix,
		// toAnomalyRow hands the raw project to the detectors (the DB-side
		// sanitizeProjectName already caps at PROJECT_NAME_MAX_LEN=64 and
		// strips C0 control chars), so this test must surface TWO loops
		// with the original project values preserved.
		const sharedPrefix = "z".repeat(63);
		const projectA = `${sharedPrefix}A_suffix`;
		const projectB = `${sharedPrefix}B_suffix`;
		// Demonstrate the bug we are protecting against: the sanitiser
		// truncates both projects to 63 chars + ellipsis, so the display
		// values are identical under the old behaviour. If the sanitiser
		// ever stops truncating, this assert fails and the test no longer
		// exercises the regression — that is the signal to revisit.
		expect(sanitizeProjectForDisplay(projectA)).toBe(
			sanitizeProjectForDisplay(projectB),
		);
		// The detector sees the raw (un-truncated) projects, which is what
		// toAnomalyRow now provides after the fix.
		const rows = [
			...Array.from({ length: 12 }, (_, i) =>
				req({
					timestamp: i * 10_000,
					inputTokens: 500,
					project: projectA,
				}),
			),
			...Array.from({ length: 12 }, (_, i) =>
				req({
					timestamp: i * 10_000,
					inputTokens: 500,
					project: projectB,
				}),
			),
		];
		const loops = detectRunawayLoops(rows, opts);
		expect(loops).toHaveLength(2);
		const projects = loops.map((l) => l.project).sort();
		expect(projects).toEqual([projectA, projectB].sort());
		// Each loop carries its 12 un-punctuated rows — the original project
		// propagates end-to-end, not the truncated display value.
		for (const loop of loops) {
			expect(loop.requests).toBe(12);
			expect(loop.project).not.toContain("…");
		}
	});

	test("honors a configurable loopMinRequests threshold", () => {
		// Per-agent key, but the threshold is the count of requests for
		// one agent inside the window. With loopMinRequests=12 this exact
		// 11-request steady stream should NOT fire; relaxing to 10 makes
		// it fire. This is the configurable knob the operator needs.
		const rows = Array.from({ length: 11 }, (_, i) =>
			req({
				timestamp: i * 10_000,
				inputTokens: 500,
				agentUsed: "agent-a",
			}),
		);
		expect(detectRunawayLoops(rows, { ...opts, minRequests: 12 })).toHaveLength(
			0,
		);
		const loops = detectRunawayLoops(rows, { ...opts, minRequests: 10 });
		expect(loops).toHaveLength(1);
		expect(loops[0].requests).toBe(11);
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
			baselineRows: [],
			scoringRows: [],
			rates,
			options: { range: "7d" },
		});
		expect(response.meta).toEqual({
			range: "7d",
			zScoreThreshold: 3.5,
			minBaselineRequests: 20,
			baselineWindowMinutes: 24 * 60,
			baselineWindowRequests: 0,
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

	test("respects a custom baselineWindowMinutes and reports baselineWindowRequests separately from scannedRequests", () => {
		const baselineRows = Array.from({ length: 7 }, () =>
			req({ inputTokens: 100 }),
		);
		const scoringRows = Array.from({ length: 3 }, () =>
			req({ inputTokens: 100 }),
		);
		const response = buildAnomalyInsightsResponse({
			baselineRows,
			scoringRows,
			rates,
			options: { range: "30d", baselineWindowMinutes: 60 },
		});
		expect(response.meta.baselineWindowMinutes).toBe(60);
		expect(response.meta.baselineWindowRequests).toBe(7);
		expect(response.meta.scannedRequests).toBe(3);
	});

	test("reports scanned row count and truncation in meta", () => {
		const rows = Array.from({ length: 3 }, () => req({ inputTokens: 100 }));
		const response = buildAnomalyInsightsResponse({
			baselineRows: rows,
			scoringRows: rows,
			rates,
			options: { range: "30d", truncated: true },
		});
		expect(response.meta.scannedRequests).toBe(3);
		expect(response.meta.baselineWindowRequests).toBe(3);
		expect(response.meta.truncated).toBe(true);
	});

	test("runs all detectors, baselines built from baselineRows and detectors scanning only scoringRows", () => {
		// Baseline population: 20 rows with a 3-value spread (80/100/130 x
		// account "acc") so total-tokens baseline has real variance.
		const baselineRows = [
			...Array.from({ length: 6 }, () =>
				req({ inputTokens: 80, outputTokens: 8 }),
			),
			...Array.from({ length: 8 }, () =>
				req({ inputTokens: 100, outputTokens: 10 }),
			),
			...Array.from({ length: 6 }, () =>
				req({ inputTokens: 130, outputTokens: 13 }),
			),
		];
		const scoringRows: AnomalyRequestRow[] = [
			// A clear total-token AND output-token spike, scored against the
			// baseline above (NOT part of baselineRows).
			req({
				id: "spike",
				timestamp: 19 * 600_000,
				inputTokens: 9000,
				outputTokens: 1000,
			}),
			// Runaway loop burst on another account/agent; the model has no
			// known rates so the small calls don't count as misrouting.
			...Array.from({ length: 12 }, (_, i) =>
				req({
					account: "loop-acc",
					project: "loop-proj",
					agentUsed: "loop-agent",
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
			baselineRows,
			scoringRows,
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
		const baselineRows = baseline19_80_100_130({ outputTokens: 8 });
		const scoringRows: AnomalyRequestRow[] = [
			req({ id: "big", inputTokens: 300 }),
			req({ id: "bigger", inputTokens: 600 }),
		];
		const response = buildAnomalyInsightsResponse({
			baselineRows,
			scoringRows,
			rates,
			options: {
				range: "24h",
				minBaselineRequests: 10,
				// z(300) ~ 3.32, z(600) ~ 5.42 — both qualify at 3; cap keeps one.
				zScoreThreshold: 3,
				maxEventsPerDetector: 1,
			},
		});
		expect(response.tokenOutliers).toHaveLength(1);
		// The cap keeps the highest z-score.
		expect(response.tokenOutliers[0].requestId).toBe("bigger");
	});

	test("reports totalCount + truncation per detector so the UI can distinguish '50-of-50' from '50-of-847'", () => {
		// Baseline rows dominate so the median stays low; spikes are far
		// enough above to register as outliers. Cap of 5 forces 5 of N to
		// be shown. Same 6/7/6-shaped total-token spread as the smaller
		// fixtures, just repeated ~5.5x for a larger n (~104 rows).
		const out = 8;
		const baselineRows = [
			...Array.from({ length: 34 }, () =>
				req({ inputTokens: 80 - out, outputTokens: out }),
			),
			...Array.from({ length: 33 }, () =>
				req({ inputTokens: 100 - out, outputTokens: out }),
			),
			...Array.from({ length: 33 }, () =>
				req({ inputTokens: 130 - out, outputTokens: out }),
			),
		];
		const scoringRows = Array.from({ length: 10 }, (_, i) =>
			req({ id: `spike-${i}`, inputTokens: 50000 }),
		);
		const response = buildAnomalyInsightsResponse({
			baselineRows,
			scoringRows,
			rates,
			options: {
				range: "24h",
				minBaselineRequests: 10,
				zScoreThreshold: 3,
				maxEventsPerDetector: 5,
			},
		});
		// Without totalCount the UI cannot tell "5 hidden" from "no more".
		expect(response.tokenOutliersSummary.totalCount).toBe(10);
		expect(response.tokenOutliersSummary.truncated).toBe(true);
		expect(response.tokenOutliers).toHaveLength(5);
		// Output blowups: scoringRows carry no outputTokens at all (0), so
		// they're skipped by the output_tokens metric guard entirely.
		expect(response.outputBlowupsSummary.totalCount).toBe(0);
		expect(response.outputBlowupsSummary.truncated).toBe(false);
	});

	test("summary.truncated is false when the full count fits under the cap", () => {
		// Reuses the shared 6/7/6 80/100/130 baseline (with an output-tokens
		// signal so the output-gate in computeBaselines is satisfied);
		// medianLog/scaledMad are identical to the plain 80/100/130 split
		// regardless of exact per-value counts, so the z-scores below hold.
		const baselineRows = baseline19_80_100_130({ outputTokens: 8 });
		// z(300) ~ 3.32, z(600) ~ 5.42 at threshold 3 => exactly 2 outliers.
		const scoringRows = [
			req({ id: "big", inputTokens: 300 }),
			req({ id: "bigger", inputTokens: 600 }),
		];
		const response = buildAnomalyInsightsResponse({
			baselineRows,
			scoringRows,
			rates,
			options: {
				range: "24h",
				minBaselineRequests: 10,
				zScoreThreshold: 3,
				maxEventsPerDetector: 50,
			},
		});
		expect(response.tokenOutliersSummary.totalCount).toBe(2);
		expect(response.tokenOutliersSummary.truncated).toBe(false);
		expect(response.tokenOutliers).toHaveLength(2);
	});

	test("summary is correct for runawayLoops and misrouting as well", () => {
		// 12 near-identical loops on one (account, model) using a model
		// with no known rates so the same rows are NOT flagged as
		// misrouting.
		const loopRows: AnomalyRequestRow[] = Array.from({ length: 12 }, (_, i) =>
			req({
				timestamp: i * 10_000,
				inputTokens: 500,
				project: "loop-proj",
				model: "unknown-loop-model",
			}),
		);
		// And one tiny-call account for misrouting
		const tinyRows: AnomalyRequestRow[] = Array.from({ length: 5 }, (_, i) =>
			req({
				account: "tiny-acc",
				timestamp: i,
				inputTokens: 50,
				costUsd: 0.02,
			}),
		);
		const scoringRows = [...loopRows, ...tinyRows];
		const response = buildAnomalyInsightsResponse({
			baselineRows: scoringRows,
			scoringRows,
			rates,
			options: {
				range: "24h",
				minBaselineRequests: 5,
				maxEventsPerDetector: 1,
			},
		});
		expect(response.runawayLoopsSummary.totalCount).toBeGreaterThanOrEqual(1);
		expect(response.runawayLoops).toHaveLength(1);
		if (response.runawayLoopsSummary.totalCount > 1) {
			expect(response.runawayLoopsSummary.truncated).toBe(true);
		}
		expect(response.misroutingSummary.totalCount).toBe(1);
		expect(response.misroutingSummary.truncated).toBe(false);
	});
});

describe("sanitizeProjectForDisplay", () => {
	test("returns null for null / undefined / empty / whitespace-only input", () => {
		expect(sanitizeProjectForDisplay(null)).toBeNull();
		expect(sanitizeProjectForDisplay(undefined)).toBeNull();
		expect(sanitizeProjectForDisplay("")).toBeNull();
		expect(sanitizeProjectForDisplay("   \t\n  ")).toBeNull();
	});

	test("strips C0 control characters and DEL so prompt content cannot smuggle bytes through the UI", () => {
		const hostile = "hello\x00\x07\x1b[31m\x7fworld";
		expect(sanitizeProjectForDisplay(hostile)).toBe("helloworld");
	});

	test("collapses whitespace runs and trims", () => {
		// The gap between `alpha` and `beta` is purely C0 whitespace, so
		// after stripping the control chars the words become adjacent
		// (sanitisation cannot fabricate a space where none existed).
		expect(sanitizeProjectForDisplay("  alpha\n\n\tbeta  ")).toBe("alphabeta");
		// Spaces inside the input are real whitespace and DO get collapsed.
		expect(sanitizeProjectForDisplay("  alpha    beta  ")).toBe("alpha beta");
	});

	test("clamps to PROJECT_DISPLAY_MAX_CHARS and appends an ellipsis", () => {
		const long = "x".repeat(PROJECT_DISPLAY_MAX_CHARS + 50);
		const out = sanitizeProjectForDisplay(long);
		expect(out).not.toBeNull();
		expect(out?.length).toBe(PROJECT_DISPLAY_MAX_CHARS);
		expect(out?.endsWith("…")).toBe(true);
	});

	test("passes a normal project name through unchanged", () => {
		expect(sanitizeProjectForDisplay("repo-frontend")).toBe("repo-frontend");
	});

	test("returns null when the input is only control characters", () => {
		expect(sanitizeProjectForDisplay("\x00\x01\x02")).toBeNull();
	});
});
