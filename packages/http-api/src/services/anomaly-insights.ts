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
 * - baselines: log-space median/MAD of tokens per request per (account, model)
 * - tokenOutliers / outputBlowups: requests >= zScoreThreshold modified
 *   z-scores above their baseline median (total tokens / output tokens
 *   respectively), scored in log space (see detectTokenOutliers doc comment
 *   for why this eliminates the old sqrt(n-1) ceiling — issue #410)
 * - runawayLoops: dense bursts of near-identical requests per
 *   (account, model, project, agent) — keyed by per-agent identity so
 *   many workers sharing one account+model+project (each on its own
 *   agent) do not collapse into one bucket that falsely reports as a
 *   loop. `project` is also part of the key so requests with no agent
 *   attribution still split by project (the x-claude-code-session-id
 *   header is unreliable in some clients and is not always present).
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
	/**
	 * Per-request agent identity (from the agent-attribution pipeline).
	 * Used by the runaway-loop detector as the per-bucket key so distinct
	 * workers sharing one (account, model, project) do not collapse
	 * into a single bucket that falsely reports as a loop.
	 */
	agentUsed: string | null;
	inputTokens: number;
	cacheReadInputTokens: number;
	cacheCreationInputTokens: number;
	outputTokens: number;
	costUsd: number;
}

export interface AnomalyInsightsOptions {
	range: string;
	/**
	 * Flag requests >= this many modified z-score units (log-space
	 * median/MAD) above the baseline median. Default 3.5.
	 */
	zScoreThreshold?: number;
	/** Minimum token-bearing requests per (account, model) to form a baseline. Default 20. */
	minBaselineRequests?: number;
	/**
	 * Minutes of trailing history the baseline is built from, decoupled from
	 * the scoring window. Echoed back verbatim in meta.baselineWindowMinutes;
	 * purely informational at this layer — the caller is responsible for
	 * actually fetching baselineRows over this window. Default 1440 (24h).
	 */
	baselineWindowMinutes?: number;
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
	/**
	 * Rows the baselines (median/MAD per account+model) are computed from.
	 * Should span the trailing baselineWindowMinutes, decoupled from
	 * scoringRows so a scored row is never a member of its own baseline
	 * population (issue #410 — see detectTokenOutliers doc comment).
	 */
	baselineRows: AnomalyRequestRow[];
	/**
	 * Rows actually scored/scanned by every detector (token outliers,
	 * output blowups, runaway loops, model misrouting). Typically the
	 * newly-arrived slice since the last alert sweep.
	 */
	scoringRows: AnomalyRequestRow[];
	/** Rates per model id ($ per 1M tokens); null for unknown models. */
	rates: Map<string, ModelRates | null>;
	options: AnomalyInsightsOptions;
}

/**
 * Iglewicz & Hoaglin (1993) standard cutoff for the modified z-score
 * (median/MAD based), applied here in log space. This is NOT a raw
 * standard-deviation count — see detectTokenOutliers for the full
 * modified-z-score contract.
 */
export const DEFAULT_Z_SCORE_THRESHOLD = 3.5;
export const DEFAULT_MIN_BASELINE_REQUESTS = 20;
export const DEFAULT_BASELINE_WINDOW_MINUTES = 24 * 60;
export const DEFAULT_LOOP_WINDOW_MINUTES = 5;
export const DEFAULT_LOOP_MIN_REQUESTS = 10;
export const DEFAULT_LOOP_SIMILARITY_TOLERANCE = 0.25;
export const DEFAULT_MISROUTING_MAX_TOTAL_TOKENS = 500;
export const DEFAULT_MISROUTING_MIN_OUTPUT_RATE_USD = 25;
export const DEFAULT_MISROUTING_MIN_REQUESTS = 5;
export const DEFAULT_MAX_EVENTS_PER_DETECTOR = 50;

/**
 * Display cap for project names. The upstream `project` field on requests
 * is built from free-form text (#368 — known to sometimes leak prompt
 * content), so this is a defense-in-depth at the presentation layer: any
 * string leaving the API/alert pipeline through a `project` slot is
 * stripped of control characters and clamped to this many chars with an
 * ellipsis. Longer values look like obvious junk to the operator rather
 * than authentic-looking prompt content.
 */
export const PROJECT_DISPLAY_MAX_CHARS = 64;
/** Replacement character used when an input cannot be rendered. */
const ELLIPSIS = "…";

/**
 * Defence-in-depth sanitiser for values that originate as a request's
 * `project` field. The real extraction bug (prompt content leaking into
 * `project`) is fixed upstream in proxy/src/project-attribution.ts (#368)
 * — this function does not address that, it only ensures that whatever
 * reaches the JSON response or an alert message can never render as if
 * it were a normal label.
 *
 * - null / undefined / empty -> null
 * - control chars (incl. newlines, tabs) are stripped
 * - collapses runs of whitespace
 * - clamps to PROJECT_DISPLAY_MAX_CHARS, appending an ellipsis when truncated
 */
export function sanitizeProjectForDisplay(
	raw: string | null | undefined,
): string | null {
	if (raw == null) return null;
	// Strip ANSI CSI sequences FIRST while the leading ESC byte is
	// still present, then strip remaining C0 control chars (incl. any
	// orphan ESC) and DEL so prompt content cannot smuggle terminal
	// control bytes through the UI. See sanitizeProjectName in
	// packages/proxy/src/project-attribution.ts for the same pattern.
	const stripped = raw
		// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI CSI sequences are the target, not a literal
		.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "")
		// biome-ignore lint/suspicious/noControlCharactersInRegex: C0 control range is the target, not a literal
		.replace(/[\x00-\x1f\x7f]+/g, "")
		.replace(/\s+/g, " ")
		.trim();
	if (stripped === "") return null;
	if (stripped.length <= PROJECT_DISPLAY_MAX_CHARS) return stripped;
	return stripped.slice(0, PROJECT_DISPLAY_MAX_CHARS - 1) + ELLIPSIS;
}

const UNKNOWN_KEY = "Unknown";
export const GROUP_KEY_SEPARATOR = "\u001f"; // unit separator: never appears in names, keys cannot collide
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

/**
 * Epsilon below which a baseline's scaledMad is treated as genuinely zero
 * variance (all baseline values identical — plausible for deterministic
 * health-check calls, fixed-size embedding requests, templated system
 * prompts). There is deliberately NO flooring of scaledMad in medianAndMad
 * anymore: a zero-variance baseline carries no signal to score against, so
 * detectTokenOutliers SKIPS scoring that metric for that baseline entirely
 * (mirroring the pre-#410 `if (stdDev <= 0) continue;` guard) rather than
 * flagging every non-identical future value as an extreme anomaly. Flooring
 * scaledMad to a tiny positive number would make even a 1-token deviation
 * produce a z-score in the millions (ln(101/100) / 1e-9 ≈ 9.95e6), which
 * would always exceed the default 3.5 threshold and cause alert storms for
 * deterministic traffic.
 */
const MIN_SCALED_MAD = 1e-6;

/** Standard median: sorts a copy, averages the two middle values if even length. */
function median(values: number[]): number {
	if (values.length === 0) {
		throw new Error("median() requires at least one value");
	}
	const sorted = [...values].sort((a, b) => a - b);
	const mid = Math.floor(sorted.length / 2);
	return sorted.length % 2 === 0
		? (sorted[mid - 1] + sorted[mid]) / 2
		: sorted[mid];
}

/**
 * Median + scaled median-absolute-deviation of ln(values), the log-space
 * statistic the modified z-score is built from (issue #410).
 *
 * `values` are RAW (non-log, must be > 0); this function takes the log
 * internally. `scaledMad` is returned RAW/unfloored — it can genuinely be
 * 0 when every value in the group is identical. The "no signal, skip
 * scoring" decision for a zero-variance baseline belongs to the caller
 * (detectTokenOutliers), not here — see MIN_SCALED_MAD.
 */
function medianAndMad(values: number[]): {
	medianLog: number;
	scaledMad: number;
} {
	if (values.length === 0) {
		throw new Error("medianAndMad() requires at least one value");
	}
	const logs = values.map((v) => Math.log(v));
	const medianLog = median(logs);
	const mad = median(logs.map((l) => Math.abs(l - medianLog)));
	// 1.4826: consistency constant that makes scaledMad a consistent
	// estimator of the standard deviation for normally-distributed data.
	const scaledMad = 1.4826 * mad;
	return { medianLog, scaledMad };
}

function baselineKey(account: string | null, model: string | null): string {
	return `${normalizeKey(account)}${GROUP_KEY_SEPARATOR}${normalizeKey(model)}`;
}

/**
 * Compute per-(account, model) token baselines from `baselineRows`.
 *
 * `baselineRows` is a DIFFERENT row set than whatever is later scored
 * against these baselines (see detectTokenOutliers) — this function has
 * no knowledge of, and does not need, the scoring rows.
 *
 * Rows with zero total tokens (failed or empty requests) carry no token
 * signal and are excluded so they don't distort the log-space statistics
 * (ln(0) is undefined). The output-tokens metric additionally filters to
 * outputTokens > 0 for the same reason (a request with zero output tokens,
 * e.g. an input-only call, has no signal for the output-blowup detector).
 *
 * The two metrics (total tokens, output tokens) qualify INDEPENDENTLY: a
 * group with enough rows overall but fewer than minBaselineRequests rows
 * with outputTokens > 0 still gets a valid total-tokens baseline — only the
 * output-tokens side of that entry is marked invalid (medianLogOutputTokens
 * / madOutputTokens / approxMedianOutputTokens set to `null`), which
 * detectTokenOutliers treats as "no baseline for this metric" and skips.
 * The group is omitted entirely only when NEITHER metric has enough rows.
 *
 * `null` (not `NaN`) is the sentinel for "no baseline for this metric" so
 * the value survives JSON.stringify/parse as a literal `null` instead of
 * silently becoming `null` anyway via NaN's non-standard JSON serialization
 * while the declared AnomalyBaseline type claimed a non-nullable `number`
 * (issue #410 follow-up).
 *
 * Sorted by requests descending, then account/model ascending.
 */
export function computeBaselines(
	baselineRows: AnomalyRequestRow[],
	minBaselineRequests: number,
): AnomalyBaseline[] {
	const groups = new Map<string, AnomalyRequestRow[]>();
	for (const row of baselineRows) {
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
		const outputRows = group.filter((row) => row.outputTokens > 0);
		const hasTotal = group.length >= minBaselineRequests;
		const hasOutput = outputRows.length >= minBaselineRequests;
		// Neither metric has enough data: no baseline entry at all for this
		// group (nothing downstream could use it).
		if (!hasTotal && !hasOutput) continue;
		const total = hasTotal ? medianAndMad(group.map(totalTokens)) : null;
		const output = hasOutput
			? medianAndMad(outputRows.map((row) => row.outputTokens))
			: null;
		baselines.push({
			account: normalizeKey(group[0].account),
			model: normalizeKey(group[0].model),
			requests: group.length,
			medianLogTotalTokens: total ? total.medianLog : null,
			madTotalTokens: total ? total.scaledMad : null,
			medianLogOutputTokens: output ? output.medianLog : null,
			madOutputTokens: output ? output.scaledMad : null,
			approxMedianTotalTokens: total ? Math.exp(total.medianLog) : null,
			approxMedianOutputTokens: output ? Math.exp(output.medianLog) : null,
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
 * Flag requests whose token usage sits >= zScoreThreshold modified z-score
 * units ABOVE their (account, model) baseline median, in log space. Low-side
 * deviations are not anomalies for cost purposes and are never reported.
 * Groups without a baseline produce no outliers.
 *
 * LEAVE-ONE-OUT CONTRACT (issue #410): `scoringRows` and the rows that fed
 * `baselines` (via computeBaselines' `baselineRows`) are two independent
 * row sets. A row being scored here is not assumed to be a member of the
 * population its baseline was built from. This matters even when the
 * caller happens to pass the same underlying data for both — the periodic
 * alert sweep always uses genuinely disjoint sets (new rows scored against
 * a trailing history window).
 *
 * There is deliberately no `sqrt(n-1)`-style ceiling on the resulting
 * z-score, for two independent reasons:
 *   1. Structural — because scoringRows and baselineRows are decoupled, a
 *      scored value is not necessarily part of the population it's
 *      compared against, so there is no algebraic identity binding the
 *      z-score to the baseline's sample size.
 *   2. Statistical — median/MAD (unlike mean/stddev) has a 50% breakdown
 *      point: even in the on-demand case where scoringRows and
 *      baselineRows happen to be the same set, one extreme point out of
 *      minBaselineRequests (default 20) cannot materially shift the
 *      median or MAD, so it cannot cap its own z-score the way one point
 *      out of n could cap a population-stddev z-score at sqrt(n-1).
 *
 * Sorted by z-score descending.
 */
export function detectTokenOutliers(
	scoringRows: AnomalyRequestRow[],
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
	for (const row of scoringRows) {
		if (totalTokens(row) === 0) continue;
		if (metric === "output_tokens" && row.outputTokens <= 0) continue;
		const baseline = baselineByKey.get(baselineKey(row.account, row.model));
		if (!baseline) continue;
		const medianLog =
			metric === "total_tokens"
				? baseline.medianLogTotalTokens
				: baseline.medianLogOutputTokens;
		const scaledMad =
			metric === "total_tokens"
				? baseline.madTotalTokens
				: baseline.madOutputTokens;
		// Two independent "no signal" cases, both skipped without emitting an
		// event (never flagged):
		//  - null: this metric's side of the baseline didn't qualify at all
		//    (computeBaselines saw < minBaselineRequests rows for it).
		//  - <= MIN_SCALED_MAD: the baseline is genuinely zero-variance (every
		//    value identical). Mirrors the pre-#410 `if (stdDev <= 0) continue;`
		//    guard — see MIN_SCALED_MAD doc comment for why this must skip
		//    rather than floor-and-flag.
		if (medianLog === null || scaledMad === null || scaledMad <= MIN_SCALED_MAD)
			continue;
		const value =
			metric === "total_tokens" ? totalTokens(row) : row.outputTokens;
		const modifiedZ = (Math.log(value) - medianLog) / scaledMad;
		if (modifiedZ < zScoreThreshold) continue;
		outliers.push({
			requestId: row.id,
			timestamp: row.timestamp,
			account: normalizeKey(row.account),
			model: normalizeKey(row.model),
			accountRaw: row.account,
			modelRaw: row.model,
			project: row.project,
			metric,
			value,
			baselineMedianLog: medianLog,
			baselineMad: scaledMad,
			approxBaselineMedian: Math.exp(medianLog),
			zScore: modifiedZ,
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
 * for one (account, model, project, agent), where the request-side token
 * profile is similar (coefficient of variation <= similarityTolerance).
 *
 * The key carries BOTH `project` and `agentUsed` so the bucket is no
 * coarser than the most informative available signal:
 *  - When `agentUsed` is set (e.g. via x-better-ccflare-agent-id or
 *    x-claude-code-session-id), many independent workers sharing one
 *    (account, model, project) — each running its own agent — do not
 *    collapse into a single bucket that falsely reports as a loop.
 *  - When `agentUsed` is null, `project` still distinguishes requests
 *    on the (account, model) pair so unattributed traffic does not
 *    collapse either.
 *  - Both signals collapse to `Unknown` only when both are null, which
 *    is the strictest reasonable bucket.
 *
 * All rows count, including zero-token ones — repeated failing retries are
 * exactly the signal.
 *
 * Both count and similarity are checked PER WINDOW (forward-maximal windows
 * from each start row plus backward-maximal windows from each end row, so a
 * burst adjacent to dissimilar traffic on either side is still found), and
 * only then are overlapping qualifying windows merged, so a long loop is
 * reported once. Two adjacent bursts with different profiles inside one
 * window length therefore surface as two separate loops. A merged run's
 * reported spread is computed over the whole run and can exceed the
 * tolerance when the profile drifts across merged windows.
 *
 * Sorted by request count descending.
 */
export function detectRunawayLoops(
	rows: AnomalyRequestRow[],
	options: RunawayLoopOptions,
): RunawayLoopGroup[] {
	const groups = new Map<string, AnomalyRequestRow[]>();
	for (const row of rows) {
		const key = `${baselineKey(row.account, row.model)}${GROUP_KEY_SEPARATOR}${normalizeKey(row.project)}${GROUP_KEY_SEPARATOR}${normalizeKey(row.agentUsed)}`;
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
		const n = group.length;

		// Prefix sums of request-side tokens so any window's mean/stddev is
		// O(1); token counts are small enough that the sum-of-squares form
		// is numerically safe in doubles.
		const prefixSum = new Float64Array(n + 1);
		const prefixSumSquares = new Float64Array(n + 1);
		for (let i = 0; i < n; i++) {
			const tokens = requestSideTokens(group[i]);
			prefixSum[i + 1] = prefixSum[i] + tokens;
			prefixSumSquares[i + 1] = prefixSumSquares[i] + tokens * tokens;
		}

		const windowStats = (start: number, end: number) => {
			const count = end - start + 1;
			const mean = (prefixSum[end + 1] - prefixSum[start]) / count;
			const variance = Math.max(
				(prefixSumSquares[end + 1] - prefixSumSquares[start]) / count -
					mean * mean,
				0,
			);
			const stdDev = Math.sqrt(variance);
			// All-zero-token windows (failing retries) are identical profiles.
			return { mean, spread: mean > 0 ? stdDev / mean : 0 };
		};

		const qualifies = (start: number, end: number) =>
			end - start + 1 >= options.minRequests &&
			windowStats(start, end).spread <= options.similarityTolerance;

		// Forward-maximal window for each start row, backward-maximal window
		// for each end row (both two-pointer, so O(n) per group).
		const ranges: Array<{ start: number; end: number }> = [];
		let forwardEnd = 0;
		for (let start = 0; start < n; start++) {
			if (forwardEnd < start) forwardEnd = start;
			while (
				forwardEnd + 1 < n &&
				group[forwardEnd + 1].timestamp - group[start].timestamp <=
					options.windowMs
			) {
				forwardEnd++;
			}
			if (qualifies(start, forwardEnd)) {
				ranges.push({ start, end: forwardEnd });
			}
		}
		let backwardStart = 0;
		for (let end = 0; end < n; end++) {
			while (
				group[end].timestamp - group[backwardStart].timestamp >
				options.windowMs
			) {
				backwardStart++;
			}
			if (qualifies(backwardStart, end)) {
				ranges.push({ start: backwardStart, end });
			}
		}

		// Merge overlapping qualifying windows into maximal runs.
		ranges.sort((a, b) => a.start - b.start || a.end - b.end);
		const runs: Array<{ start: number; end: number }> = [];
		for (const range of ranges) {
			const last = runs[runs.length - 1];
			if (last && range.start <= last.end) {
				last.end = Math.max(last.end, range.end);
			} else {
				runs.push({ ...range });
			}
		}

		for (const run of runs) {
			const { mean, spread } = windowStats(run.start, run.end);
			const windowStartMs = group[run.start].timestamp;
			const windowEndMs = group[run.end].timestamp;
			loops.push({
				account: normalizeKey(group[run.start].account),
				model: normalizeKey(group[run.start].model),
				project: group[run.start].project,
				agentUsed: group[run.start].agentUsed,
				windowStartMs,
				windowEndMs,
				requests: run.end - run.start + 1,
				requestsPerMinute:
					((run.end - run.start + 1) * 60_000) /
					Math.max(windowEndMs - windowStartMs, 60_000),
				meanRequestSideTokens: mean,
				requestSideTokenSpread: spread,
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
		// Look up rates with the raw model id — the rates map is keyed by the
		// raw values, normalizeKey is only for display grouping.
		if (row.model == null || row.model === "") continue;
		const modelRates = rates.get(row.model);
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
	const baselineWindowMinutes =
		options.baselineWindowMinutes ?? DEFAULT_BASELINE_WINDOW_MINUTES;

	const baselines = computeBaselines(input.baselineRows, minBaselineRequests);
	const tokenOutliers = detectTokenOutliers(
		input.scoringRows,
		baselines,
		zScoreThreshold,
		"total_tokens",
	);
	const outputBlowups = detectTokenOutliers(
		input.scoringRows,
		baselines,
		zScoreThreshold,
		"output_tokens",
	);
	const runawayLoops = detectRunawayLoops(input.scoringRows, {
		windowMs: loopWindowMinutes * 60_000,
		minRequests: loopMinRequests,
		similarityTolerance: loopSimilarityTolerance,
	});
	const misrouting = detectModelMisrouting(input.scoringRows, input.rates, {
		maxTotalTokens: misroutingMaxTotalTokens,
		minOutputRateUsd: misroutingMinOutputRateUsd,
		minRequests: misroutingMinRequests,
	});

	const baselinesTop = baselines.slice(0, maxEventsPerDetector);
	const tokenOutliersTop = tokenOutliers.slice(0, maxEventsPerDetector);
	const outputBlowupsTop = outputBlowups.slice(0, maxEventsPerDetector);
	const runawayLoopsTop = runawayLoops.slice(0, maxEventsPerDetector);
	const misroutingTop = misrouting.slice(0, maxEventsPerDetector);

	return {
		meta: {
			range: options.range,
			zScoreThreshold,
			minBaselineRequests,
			baselineWindowMinutes,
			baselineWindowRequests: input.baselineRows.length,
			loopWindowMinutes,
			loopMinRequests,
			loopSimilarityTolerance,
			misroutingMaxTotalTokens,
			misroutingMinOutputRateUsd,
			misroutingMinRequests,
			maxEventsPerDetector,
			scannedRequests: input.scoringRows.length,
			truncated: options.truncated ?? false,
		},
		baselines: baselinesTop,
		tokenOutliers: tokenOutliersTop,
		tokenOutliersSummary: {
			totalCount: tokenOutliers.length,
			truncated: tokenOutliers.length > tokenOutliersTop.length,
		},
		outputBlowups: outputBlowupsTop,
		outputBlowupsSummary: {
			totalCount: outputBlowups.length,
			truncated: outputBlowups.length > outputBlowupsTop.length,
		},
		runawayLoops: runawayLoopsTop,
		runawayLoopsSummary: {
			totalCount: runawayLoops.length,
			truncated: runawayLoops.length > runawayLoopsTop.length,
		},
		misrouting: misroutingTop,
		misroutingSummary: {
			totalCount: misrouting.length,
			truncated: misrouting.length > misroutingTop.length,
		},
	};
}
