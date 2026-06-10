import type { ModelRates } from "@better-ccflare/core";
import type {
	AnomalyBaseline,
	AnomalyInsightsResponse,
	ModelMisroutingGroup,
	RunawayLoopGroup,
	TokenOutlierEvent,
	TokenOutlierMetric,
} from "@better-ccflare/types";

/**
 * Pure anomaly-detection math for the anomaly insights endpoint.
 *
 * No DB access and no pricing-engine imports: per-request rows and model
 * rates ($ per 1M tokens) are injected as plain data. The response shapes
 * live in @better-ccflare/types and are re-exported here for convenience.
 *
 * Detectors (all batch, computed over the requested window):
 * - baselines: mean/stddev of tokens per request per (account, model)
 * - tokenOutliers / outputBlowups: requests >= zScoreThreshold stddevs
 *   above their baseline mean (total tokens / output tokens respectively)
 * - runawayLoops: dense bursts of near-identical requests per
 *   (account, model, project)
 * - misrouting: expensive models repeatedly used for trivially small calls
 */

export type {
	AnomalyBaseline,
	AnomalyInsightsMeta,
	AnomalyInsightsResponse,
	ModelMisroutingGroup,
	RunawayLoopGroup,
	TokenOutlierEvent,
	TokenOutlierMetric,
} from "@better-ccflare/types";

/** One request row fetched from the requests table for anomaly analysis. */
export interface AnomalyRequestRow {
	id: string;
	timestamp: number;
	account: string | null;
	model: string | null;
	project: string | null;
	inputTokens: number;
	cacheReadInputTokens: number;
	cacheCreationInputTokens: number;
	outputTokens: number;
	costUsd: number;
}

export interface AnomalyInsightsOptions {
	range: string;
	/** Flag requests >= this many stddevs above the baseline mean. Default 3. */
	zScoreThreshold?: number;
	/** Minimum token-bearing requests per (account, model) to form a baseline. Default 20. */
	minBaselineRequests?: number;
	/** Sliding window length for runaway-loop detection. Default 5. */
	loopWindowMinutes?: number;
	/** Minimum requests inside one window to qualify as a loop. Default 10. */
	loopMinRequests?: number;
	/** Max coefficient of variation of request-side tokens within a burst. Default 0.25. */
	loopSimilarityTolerance?: number;
	/** Calls at or below this many total tokens count as trivial. Default 500. */
	misroutingMaxTotalTokens?: number;
	/** A model is "expensive" when its output rate ($/1M) is at least this. Default 25. */
	misroutingMinOutputRateUsd?: number;
	/** Minimum trivial calls per (account, model) before flagging. Default 5. */
	misroutingMinRequests?: number;
	/** Cap applied to every list in the response. Default 50. */
	maxEventsPerDetector?: number;
	/** Whether the caller's row fetch hit its scan cap (echoed in meta). Default false. */
	truncated?: boolean;
}

export interface BuildAnomalyInsightsInput {
	rows: AnomalyRequestRow[];
	/** Rates per model id ($ per 1M tokens); null for unknown models. */
	rates: Map<string, ModelRates | null>;
	options: AnomalyInsightsOptions;
}

export const DEFAULT_Z_SCORE_THRESHOLD = 3;
export const DEFAULT_MIN_BASELINE_REQUESTS = 20;
export const DEFAULT_LOOP_WINDOW_MINUTES = 5;
export const DEFAULT_LOOP_MIN_REQUESTS = 10;
export const DEFAULT_LOOP_SIMILARITY_TOLERANCE = 0.25;
export const DEFAULT_MISROUTING_MAX_TOTAL_TOKENS = 500;
export const DEFAULT_MISROUTING_MIN_OUTPUT_RATE_USD = 25;
export const DEFAULT_MISROUTING_MIN_REQUESTS = 5;
export const DEFAULT_MAX_EVENTS_PER_DETECTOR = 50;

const UNKNOWN_KEY = "Unknown";
const GROUP_KEY_SEPARATOR = "\u001f"; // unit separator: never appears in names, keys cannot collide
const MAX_EXAMPLE_REQUEST_IDS = 5;

function normalizeKey(key: string | null | undefined): string {
	return key == null || key === "" ? UNKNOWN_KEY : key;
}

/** All token volume attributed to a request, prompt side and output side. */
function totalTokens(row: AnomalyRequestRow): number {
	return (
		row.inputTokens +
		row.cacheReadInputTokens +
		row.cacheCreationInputTokens +
		row.outputTokens
	);
}

/** Request-side tokens only; the "shape" of the prompt for loop similarity. */
function requestSideTokens(row: AnomalyRequestRow): number {
	return (
		row.inputTokens + row.cacheReadInputTokens + row.cacheCreationInputTokens
	);
}

function meanAndStdDev(values: number[]): { mean: number; stdDev: number } {
	if (values.length === 0) return { mean: 0, stdDev: 0 };
	let sum = 0;
	for (const value of values) sum += value;
	const mean = sum / values.length;
	let sumSquares = 0;
	for (const value of values) {
		const deviation = value - mean;
		sumSquares += deviation * deviation;
	}
	// Population stddev: the window is the whole population we report on.
	return { mean, stdDev: Math.sqrt(sumSquares / values.length) };
}

function baselineKey(account: string | null, model: string | null): string {
	return `${normalizeKey(account)}${GROUP_KEY_SEPARATOR}${normalizeKey(model)}`;
}

/**
 * Compute per-(account, model) token baselines over the window.
 *
 * Rows with zero total tokens (failed or empty requests) carry no token
 * signal and are excluded so they don't drag means down. Groups with fewer
 * than minBaselineRequests qualifying rows produce no baseline.
 *
 * Sorted by requests descending, then account/model ascending.
 */
export function computeBaselines(
	rows: AnomalyRequestRow[],
	minBaselineRequests: number,
): AnomalyBaseline[] {
	const groups = new Map<string, AnomalyRequestRow[]>();
	for (const row of rows) {
		if (totalTokens(row) === 0) continue;
		const key = baselineKey(row.account, row.model);
		const group = groups.get(key);
		if (group) {
			group.push(row);
		} else {
			groups.set(key, [row]);
		}
	}

	const baselines: AnomalyBaseline[] = [];
	for (const group of groups.values()) {
		if (group.length < minBaselineRequests) continue;
		const total = meanAndStdDev(group.map(totalTokens));
		const output = meanAndStdDev(group.map((row) => row.outputTokens));
		baselines.push({
			account: normalizeKey(group[0].account),
			model: normalizeKey(group[0].model),
			requests: group.length,
			meanTotalTokens: total.mean,
			stdDevTotalTokens: total.stdDev,
			meanOutputTokens: output.mean,
			stdDevOutputTokens: output.stdDev,
		});
	}
	return baselines.sort(
		(a, b) =>
			b.requests - a.requests ||
			a.account.localeCompare(b.account) ||
			a.model.localeCompare(b.model),
	);
}

/**
 * Flag requests whose token usage sits >= zScoreThreshold stddevs ABOVE
 * their (account, model) baseline mean. Low-side deviations are not
 * anomalies for cost purposes and are never reported. Groups without a
 * baseline, or with zero variance, produce no outliers.
 *
 * Sorted by z-score descending.
 */
export function detectTokenOutliers(
	rows: AnomalyRequestRow[],
	baselines: AnomalyBaseline[],
	zScoreThreshold: number,
	metric: TokenOutlierMetric,
): TokenOutlierEvent[] {
	const baselineByKey = new Map<string, AnomalyBaseline>(
		baselines.map((baseline) => [
			`${baseline.account}${GROUP_KEY_SEPARATOR}${baseline.model}`,
			baseline,
		]),
	);

	const outliers: TokenOutlierEvent[] = [];
	for (const row of rows) {
		if (totalTokens(row) === 0) continue;
		const baseline = baselineByKey.get(baselineKey(row.account, row.model));
		if (!baseline) continue;
		const mean =
			metric === "total_tokens"
				? baseline.meanTotalTokens
				: baseline.meanOutputTokens;
		const stdDev =
			metric === "total_tokens"
				? baseline.stdDevTotalTokens
				: baseline.stdDevOutputTokens;
		if (stdDev <= 0) continue;
		const value =
			metric === "total_tokens" ? totalTokens(row) : row.outputTokens;
		const zScore = (value - mean) / stdDev;
		if (zScore < zScoreThreshold) continue;
		outliers.push({
			requestId: row.id,
			timestamp: row.timestamp,
			account: normalizeKey(row.account),
			model: normalizeKey(row.model),
			project: row.project,
			metric,
			value,
			baselineMean: mean,
			baselineStdDev: stdDev,
			zScore,
		});
	}
	return outliers.sort(
		(a, b) => b.zScore - a.zScore || a.requestId.localeCompare(b.requestId),
	);
}

export interface RunawayLoopOptions {
	windowMs: number;
	minRequests: number;
	similarityTolerance: number;
}

/**
 * Detect runaway loops: bursts of >= minRequests requests within windowMs
 * for one (account, model, project), where the request-side token profile
 * is similar (coefficient of variation <= similarityTolerance).
 *
 * All rows count, including zero-token ones — repeated failing retries are
 * exactly the signal. Overlapping qualifying windows merge into one
 * sustained run so a long loop is reported once, not per window position.
 *
 * Sorted by request count descending.
 */
export function detectRunawayLoops(
	rows: AnomalyRequestRow[],
	options: RunawayLoopOptions,
): RunawayLoopGroup[] {
	const groups = new Map<string, AnomalyRequestRow[]>();
	for (const row of rows) {
		const key = `${baselineKey(row.account, row.model)}${GROUP_KEY_SEPARATOR}${normalizeKey(row.project)}`;
		const group = groups.get(key);
		if (group) {
			group.push(row);
		} else {
			groups.set(key, [row]);
		}
	}

	const loops: RunawayLoopGroup[] = [];
	for (const group of groups.values()) {
		group.sort((a, b) => a.timestamp - b.timestamp);

		// Find qualifying windows with two pointers and merge overlapping
		// index ranges into maximal runs.
		const runs: Array<{ start: number; end: number }> = [];
		let end = 0;
		for (let start = 0; start < group.length; start++) {
			if (end < start) end = start;
			while (
				end + 1 < group.length &&
				group[end + 1].timestamp - group[start].timestamp <= options.windowMs
			) {
				end++;
			}
			if (end - start + 1 < options.minRequests) continue;
			const last = runs[runs.length - 1];
			if (last && start <= last.end) {
				last.end = Math.max(last.end, end);
			} else {
				runs.push({ start, end });
			}
		}

		for (const run of runs) {
			const burst = group.slice(run.start, run.end + 1);
			const { mean, stdDev } = meanAndStdDev(burst.map(requestSideTokens));
			const spread = mean > 0 ? stdDev / mean : 0;
			if (spread > options.similarityTolerance) continue;
			const windowStartMs = burst[0].timestamp;
			const windowEndMs = burst[burst.length - 1].timestamp;
			loops.push({
				account: normalizeKey(burst[0].account),
				model: normalizeKey(burst[0].model),
				project: burst[0].project,
				windowStartMs,
				windowEndMs,
				requests: burst.length,
				requestsPerMinute:
					(burst.length * 60_000) /
					Math.max(windowEndMs - windowStartMs, 60_000),
				meanInputTokens: mean,
				inputTokenSpread: spread,
			});
		}
	}
	return loops.sort(
		(a, b) =>
			b.requests - a.requests ||
			a.windowStartMs - b.windowStartMs ||
			a.account.localeCompare(b.account),
	);
}

export interface ModelMisroutingOptions {
	maxTotalTokens: number;
	minOutputRateUsd: number;
	minRequests: number;
}

/**
 * Detect model misrouting: an expensive model (output rate >=
 * minOutputRateUsd $/1M) repeatedly handling trivially small calls
 * (0 < total tokens <= maxTotalTokens). Models with unknown rates are
 * never flagged.
 *
 * Sorted by total logged cost descending.
 */
export function detectModelMisrouting(
	rows: AnomalyRequestRow[],
	rates: Map<string, ModelRates | null>,
	options: ModelMisroutingOptions,
): ModelMisroutingGroup[] {
	const groups = new Map<
		string,
		{ rows: AnomalyRequestRow[]; outputRateUsd: number }
	>();
	for (const row of rows) {
		const tokens = totalTokens(row);
		if (tokens === 0 || tokens > options.maxTotalTokens) continue;
		const model = normalizeKey(row.model);
		if (model === UNKNOWN_KEY) continue;
		const modelRates = rates.get(model);
		if (!modelRates || modelRates.output < options.minOutputRateUsd) continue;
		const key = baselineKey(row.account, row.model);
		const group = groups.get(key);
		if (group) {
			group.rows.push(row);
		} else {
			groups.set(key, { rows: [row], outputRateUsd: modelRates.output });
		}
	}

	const result: ModelMisroutingGroup[] = [];
	for (const group of groups.values()) {
		if (group.rows.length < options.minRequests) continue;
		group.rows.sort((a, b) => a.timestamp - b.timestamp);
		let tokenSum = 0;
		let costSum = 0;
		for (const row of group.rows) {
			tokenSum += totalTokens(row);
			costSum += row.costUsd;
		}
		result.push({
			account: normalizeKey(group.rows[0].account),
			model: normalizeKey(group.rows[0].model),
			requests: group.rows.length,
			meanTotalTokens: tokenSum / group.rows.length,
			outputRateUsd: group.outputRateUsd,
			totalCostUsd: costSum,
			exampleRequestIds: group.rows
				.slice(0, MAX_EXAMPLE_REQUEST_IDS)
				.map((row) => row.id),
		});
	}
	return result.sort(
		(a, b) =>
			b.totalCostUsd - a.totalCostUsd ||
			b.requests - a.requests ||
			a.account.localeCompare(b.account),
	);
}

/**
 * Run all detectors over one window of request rows and assemble the
 * response. Every list is capped at maxEventsPerDetector (already sorted
 * most-significant first by each detector).
 */
export function buildAnomalyInsightsResponse(
	input: BuildAnomalyInsightsInput,
): AnomalyInsightsResponse {
	const { options } = input;
	const zScoreThreshold = options.zScoreThreshold ?? DEFAULT_Z_SCORE_THRESHOLD;
	const minBaselineRequests =
		options.minBaselineRequests ?? DEFAULT_MIN_BASELINE_REQUESTS;
	const loopWindowMinutes =
		options.loopWindowMinutes ?? DEFAULT_LOOP_WINDOW_MINUTES;
	const loopMinRequests = options.loopMinRequests ?? DEFAULT_LOOP_MIN_REQUESTS;
	const loopSimilarityTolerance =
		options.loopSimilarityTolerance ?? DEFAULT_LOOP_SIMILARITY_TOLERANCE;
	const misroutingMaxTotalTokens =
		options.misroutingMaxTotalTokens ?? DEFAULT_MISROUTING_MAX_TOTAL_TOKENS;
	const misroutingMinOutputRateUsd =
		options.misroutingMinOutputRateUsd ??
		DEFAULT_MISROUTING_MIN_OUTPUT_RATE_USD;
	const misroutingMinRequests =
		options.misroutingMinRequests ?? DEFAULT_MISROUTING_MIN_REQUESTS;
	const maxEventsPerDetector =
		options.maxEventsPerDetector ?? DEFAULT_MAX_EVENTS_PER_DETECTOR;

	const baselines = computeBaselines(input.rows, minBaselineRequests);
	const tokenOutliers = detectTokenOutliers(
		input.rows,
		baselines,
		zScoreThreshold,
		"total_tokens",
	);
	const outputBlowups = detectTokenOutliers(
		input.rows,
		baselines,
		zScoreThreshold,
		"output_tokens",
	);
	const runawayLoops = detectRunawayLoops(input.rows, {
		windowMs: loopWindowMinutes * 60_000,
		minRequests: loopMinRequests,
		similarityTolerance: loopSimilarityTolerance,
	});
	const misrouting = detectModelMisrouting(input.rows, input.rates, {
		maxTotalTokens: misroutingMaxTotalTokens,
		minOutputRateUsd: misroutingMinOutputRateUsd,
		minRequests: misroutingMinRequests,
	});

	return {
		meta: {
			range: options.range,
			zScoreThreshold,
			minBaselineRequests,
			loopWindowMinutes,
			loopMinRequests,
			loopSimilarityTolerance,
			misroutingMaxTotalTokens,
			misroutingMinOutputRateUsd,
			misroutingMinRequests,
			maxEventsPerDetector,
			scannedRequests: input.rows.length,
			truncated: options.truncated ?? false,
		},
		baselines: baselines.slice(0, maxEventsPerDetector),
		tokenOutliers: tokenOutliers.slice(0, maxEventsPerDetector),
		outputBlowups: outputBlowups.slice(0, maxEventsPerDetector),
		runawayLoops: runawayLoops.slice(0, maxEventsPerDetector),
		misrouting: misrouting.slice(0, maxEventsPerDetector),
	};
}
