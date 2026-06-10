import { getModelRates, type ModelRates } from "@better-ccflare/core";
import {
	errorResponse,
	InternalServerError,
	jsonResponse,
} from "@better-ccflare/http-common";
import { Logger } from "@better-ccflare/logger";
import {
	type AnomalyRequestRow,
	buildAnomalyInsightsResponse,
	DEFAULT_LOOP_MIN_REQUESTS,
	DEFAULT_LOOP_SIMILARITY_TOLERANCE,
	DEFAULT_LOOP_WINDOW_MINUTES,
	DEFAULT_MAX_EVENTS_PER_DETECTOR,
	DEFAULT_MIN_BASELINE_REQUESTS,
	DEFAULT_MISROUTING_MAX_TOTAL_TOKENS,
	DEFAULT_MISROUTING_MIN_OUTPUT_RATE_USD,
	DEFAULT_MISROUTING_MIN_REQUESTS,
	DEFAULT_Z_SCORE_THRESHOLD,
} from "../services/anomaly-insights";
import {
	buildCacheInsightsResponse,
	DEFAULT_THRESHOLD_PERCENT,
	type GroupedTokenRow,
} from "../services/cache-insights";
import type { APIContext } from "../types";
import { buildRequestFilters, getRangeConfig } from "../utils/query-filters";

const log = new Logger("InsightsHandler");

/** Raw GROUP BY row shape shared by both insights queries. */
interface GroupedTokenSqlRow {
	dimension_key: string | null;
	model: string | null;
	requests: number;
	uncached_input_tokens: number;
	cache_read_input_tokens: number;
	cache_creation_input_tokens: number;
}

function toGroupedTokenRow(row: GroupedTokenSqlRow): GroupedTokenRow {
	return {
		dimensionKey: row.dimension_key,
		model: row.model,
		requests: Number(row.requests) || 0,
		uncachedInputTokens: Number(row.uncached_input_tokens) || 0,
		cacheReadInputTokens: Number(row.cache_read_input_tokens) || 0,
		cacheCreationInputTokens: Number(row.cache_creation_input_tokens) || 0,
	};
}

/** Parse the threshold query param: float, default 50, clamped to 0-100. */
function parseThresholdPercent(raw: string | null): number {
	if (raw === null) return DEFAULT_THRESHOLD_PERCENT;
	const parsed = Number.parseFloat(raw);
	if (!Number.isFinite(parsed)) return DEFAULT_THRESHOLD_PERCENT;
	return Math.min(100, Math.max(0, parsed));
}

/**
 * GET /api/insights/cache — cache efficiency insights.
 *
 * Aggregates token sums per (account, model) and (project, model) over the
 * requested range/filters, prices the cache volume via the pricing catalogue,
 * and returns hit rates, dollar savings and low-hit-rate flags.
 */
export function createCacheInsightsHandler(context: APIContext) {
	return async (searchParams: URLSearchParams): Promise<Response> => {
		const db = context.dbOps.getAdapter();
		// Normalize the raw query param so meta.range reflects the window used.
		const { startMs, range } = getRangeConfig(
			searchParams.get("range") ?? "24h",
		);
		const { whereClause, params: queryParams } = buildRequestFilters(
			searchParams,
			startMs,
		);
		const thresholdPercent = parseThresholdPercent(
			searchParams.get("threshold"),
		);

		try {
			// account x model (also the source for byModel and totals)
			const accountModelSqlRows = await db.query<GroupedTokenSqlRow>(
				`
				SELECT
					COALESCE(a.name, 'Unknown') as dimension_key,
					r.model as model,
					COUNT(*) as requests,
					SUM(COALESCE(r.input_tokens, 0)) as uncached_input_tokens,
					SUM(COALESCE(r.cache_read_input_tokens, 0)) as cache_read_input_tokens,
					SUM(COALESCE(r.cache_creation_input_tokens, 0)) as cache_creation_input_tokens
				FROM requests r
				LEFT JOIN accounts a ON a.id = r.account_used
				WHERE ${whereClause}
				GROUP BY COALESCE(a.name, 'Unknown'), r.model
			`,
				queryParams,
			);

			// project x model
			const projectModelSqlRows = await db.query<GroupedTokenSqlRow>(
				`
				SELECT
					COALESCE(r.project, 'Unknown') as dimension_key,
					r.model as model,
					COUNT(*) as requests,
					SUM(COALESCE(r.input_tokens, 0)) as uncached_input_tokens,
					SUM(COALESCE(r.cache_read_input_tokens, 0)) as cache_read_input_tokens,
					SUM(COALESCE(r.cache_creation_input_tokens, 0)) as cache_creation_input_tokens
				FROM requests r
				WHERE ${whereClause}
				GROUP BY COALESCE(r.project, 'Unknown'), r.model
			`,
				queryParams,
			);

			const accountModelRows = accountModelSqlRows.map(toGroupedTokenRow);
			const projectModelRows = projectModelSqlRows.map(toGroupedTokenRow);

			// Price each distinct model id once; null/empty models are handled by
			// the service as "Unknown" and never priced.
			const modelIds = [
				...new Set(
					[...accountModelRows, ...projectModelRows]
						.map((row) => row.model)
						.filter((model): model is string => model != null && model !== ""),
				),
			];
			const rateList = await Promise.all(
				modelIds.map((modelId) => getModelRates(modelId)),
			);
			const rates = new Map<string, ModelRates | null>(
				modelIds.map((modelId, index) => [modelId, rateList[index]]),
			);

			return jsonResponse(
				buildCacheInsightsResponse({
					accountModelRows,
					projectModelRows,
					rates,
					options: { range, thresholdPercent },
				}),
			);
		} catch (error) {
			log.error("Cache insights error:", error);
			return errorResponse(
				InternalServerError("Failed to fetch cache insights data"),
			);
		}
	};
}

/**
 * Hard cap on rows fetched per anomalies request. With wide ranges on
 * high-traffic instances the raw fetch would otherwise be unbounded; beyond
 * the cap only the most recent rows are analyzed and meta.truncated is set.
 */
const MAX_ANOMALY_SCAN_ROWS = 100_000;

/** Raw per-request row shape for the anomalies query. */
interface AnomalyRequestSqlRow {
	id: string;
	timestamp: number;
	account: string | null;
	model: string | null;
	project: string | null;
	input_tokens: number;
	cache_read_input_tokens: number;
	cache_creation_input_tokens: number;
	output_tokens: number;
	cost_usd: number;
}

function toAnomalyRequestRow(row: AnomalyRequestSqlRow): AnomalyRequestRow {
	return {
		id: row.id,
		timestamp: Number(row.timestamp) || 0,
		account: row.account,
		model: row.model,
		project: row.project,
		inputTokens: Number(row.input_tokens) || 0,
		cacheReadInputTokens: Number(row.cache_read_input_tokens) || 0,
		cacheCreationInputTokens: Number(row.cache_creation_input_tokens) || 0,
		outputTokens: Number(row.output_tokens) || 0,
		costUsd: Number(row.cost_usd) || 0,
	};
}

/**
 * Parse a numeric detector-threshold query param: fall back to the default
 * when missing or unparseable, clamp to [min, max], optionally round to an
 * integer (for count-like params).
 */
function parseDetectorParam(
	raw: string | null,
	fallback: number,
	min: number,
	max: number,
	integer = false,
): number {
	const parsed = raw === null ? fallback : Number.parseFloat(raw);
	const value = Number.isFinite(parsed) ? parsed : fallback;
	const clamped = Math.min(max, Math.max(min, value));
	return integer ? Math.round(clamped) : clamped;
}

/**
 * GET /api/insights/anomalies — token anomaly detection.
 *
 * Fetches per-request rows over the requested range/filters in one batch
 * query and runs the pure detectors from services/anomaly-insights:
 * per-account/model baselines, token outliers, output blowups, runaway
 * loops, and model misrouting. Detector thresholds are query params with
 * sane defaults (see AnomalyInsightsOptions).
 */
export function createAnomalyInsightsHandler(context: APIContext) {
	return async (searchParams: URLSearchParams): Promise<Response> => {
		const db = context.dbOps.getAdapter();
		const { startMs, range } = getRangeConfig(
			searchParams.get("range") ?? "24h",
		);
		const { whereClause, params: queryParams } = buildRequestFilters(
			searchParams,
			startMs,
		);

		const options = {
			range,
			zScoreThreshold: parseDetectorParam(
				searchParams.get("zScoreThreshold"),
				DEFAULT_Z_SCORE_THRESHOLD,
				0.5,
				10,
			),
			minBaselineRequests: parseDetectorParam(
				searchParams.get("minBaselineRequests"),
				DEFAULT_MIN_BASELINE_REQUESTS,
				2,
				100_000,
				true,
			),
			loopWindowMinutes: parseDetectorParam(
				searchParams.get("loopWindowMinutes"),
				DEFAULT_LOOP_WINDOW_MINUTES,
				1,
				120,
				true,
			),
			loopMinRequests: parseDetectorParam(
				searchParams.get("loopMinRequests"),
				DEFAULT_LOOP_MIN_REQUESTS,
				2,
				10_000,
				true,
			),
			loopSimilarityTolerance: parseDetectorParam(
				searchParams.get("loopSimilarityTolerance"),
				DEFAULT_LOOP_SIMILARITY_TOLERANCE,
				0,
				5,
			),
			misroutingMaxTotalTokens: parseDetectorParam(
				searchParams.get("misroutingMaxTotalTokens"),
				DEFAULT_MISROUTING_MAX_TOTAL_TOKENS,
				1,
				1_000_000,
				true,
			),
			misroutingMinOutputRateUsd: parseDetectorParam(
				searchParams.get("misroutingMinOutputRateUsd"),
				DEFAULT_MISROUTING_MIN_OUTPUT_RATE_USD,
				0,
				10_000,
			),
			misroutingMinRequests: parseDetectorParam(
				searchParams.get("misroutingMinRequests"),
				DEFAULT_MISROUTING_MIN_REQUESTS,
				1,
				10_000,
				true,
			),
			maxEventsPerDetector: parseDetectorParam(
				searchParams.get("maxEventsPerDetector"),
				DEFAULT_MAX_EVENTS_PER_DETECTOR,
				1,
				500,
				true,
			),
		};

		try {
			// Safety cap on the batch fetch: scan at most the most recent
			// MAX_ANOMALY_SCAN_ROWS rows (fetch one extra to detect truncation).
			const sqlRows = await db.query<AnomalyRequestSqlRow>(
				`
				SELECT
					r.id as id,
					r.timestamp as timestamp,
					a.name as account,
					r.model as model,
					r.project as project,
					COALESCE(r.input_tokens, 0) as input_tokens,
					COALESCE(r.cache_read_input_tokens, 0) as cache_read_input_tokens,
					COALESCE(r.cache_creation_input_tokens, 0) as cache_creation_input_tokens,
					COALESCE(r.output_tokens, 0) as output_tokens,
					COALESCE(r.cost_usd, 0) as cost_usd
				FROM requests r
				LEFT JOIN accounts a ON a.id = r.account_used
				WHERE ${whereClause}
				ORDER BY r.timestamp DESC
				LIMIT ${MAX_ANOMALY_SCAN_ROWS + 1}
			`,
				queryParams,
			);
			const truncated = sqlRows.length > MAX_ANOMALY_SCAN_ROWS;
			const rows = sqlRows
				.slice(0, MAX_ANOMALY_SCAN_ROWS)
				.map(toAnomalyRequestRow)
				.reverse();

			const modelIds = [
				...new Set(
					rows
						.map((row) => row.model)
						.filter((model): model is string => model != null && model !== ""),
				),
			];
			const rateList = await Promise.all(
				modelIds.map((modelId) => getModelRates(modelId)),
			);
			const rates = new Map<string, ModelRates | null>(
				modelIds.map((modelId, index) => [modelId, rateList[index]]),
			);

			return jsonResponse(
				buildAnomalyInsightsResponse({
					rows,
					rates,
					options: { ...options, truncated },
				}),
			);
		} catch (error) {
			log.error("Anomaly insights error:", error);
			return errorResponse(
				InternalServerError("Failed to fetch anomaly insights data"),
			);
		}
	};
}
