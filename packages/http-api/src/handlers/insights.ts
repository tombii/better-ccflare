import { getModelRates, type ModelRates } from "@better-ccflare/core";
import {
	errorResponse,
	InternalServerError,
	jsonResponse,
} from "@better-ccflare/http-common";
import { Logger } from "@better-ccflare/logger";
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
