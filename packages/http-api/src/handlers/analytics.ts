import {
	errorResponse,
	InternalServerError,
	jsonResponse,
} from "@better-ccflare/http-common";
import { Logger } from "@better-ccflare/logger";
import { NO_ACCOUNT_ID } from "@better-ccflare/types";
import type { AnalyticsResponse, APIContext } from "../types";

const log = new Logger("AnalyticsHandler");

interface BucketConfig {
	bucketMs: number;
	displayName: string;
}

function getRangeConfig(range: string): {
	startMs: number;
	bucket: BucketConfig;
} {
	const now = Date.now();
	const hour = 60 * 60 * 1000;
	const day = 24 * hour;

	switch (range) {
		case "1h":
			return {
				startMs: now - hour,
				bucket: { bucketMs: 60 * 1000, displayName: "1m" },
			};
		case "6h":
			return {
				startMs: now - 6 * hour,
				bucket: { bucketMs: 5 * 60 * 1000, displayName: "5m" },
			};
		case "24h":
			return {
				startMs: now - day,
				bucket: { bucketMs: hour, displayName: "1h" },
			};
		case "7d":
			return {
				startMs: now - 7 * day,
				bucket: { bucketMs: hour, displayName: "1h" },
			};
		case "30d":
			return {
				startMs: now - 30 * day,
				bucket: { bucketMs: day, displayName: "1d" },
			};
		default:
			return {
				startMs: now - day,
				bucket: { bucketMs: hour, displayName: "1h" },
			};
	}
}

export function createAnalyticsHandler(context: APIContext) {
	return async (params: URLSearchParams): Promise<Response> => {
		const db = context.dbOps.getAdapter();
		const range = params.get("range") ?? "24h";
		const { startMs, bucket } = getRangeConfig(range);
		const mode = params.get("mode") ?? "normal";
		const isCumulative = mode === "cumulative";

		// Extract filters
		const accountsFilter =
			params.get("accounts")?.split(",").filter(Boolean) || [];
		const modelsFilter = params.get("models")?.split(",").filter(Boolean) || [];
		const apiKeysFilter =
			params.get("apiKeys")?.split(",").filter(Boolean) || [];
		const statusFilter = params.get("status") || "all";

		// Build filter conditions
		const conditions: string[] = ["timestamp > ?"];
		const queryParams: (string | number)[] = [startMs];

		if (accountsFilter.length > 0) {
			// Handle account filter - map account names to IDs via join
			const placeholders = accountsFilter.map(() => "?").join(",");
			conditions.push(`(
				r.account_used IN (SELECT id FROM accounts WHERE name IN (${placeholders}))
				OR (r.account_used = ? AND ? IN (${placeholders}))
			)`);
			queryParams.push(
				...accountsFilter,
				NO_ACCOUNT_ID,
				NO_ACCOUNT_ID,
				...accountsFilter,
			);
		}

		if (modelsFilter.length > 0) {
			const placeholders = modelsFilter.map(() => "?").join(",");
			conditions.push(`model IN (${placeholders})`);
			queryParams.push(...modelsFilter);
		}

		if (apiKeysFilter.length > 0) {
			const placeholders = apiKeysFilter.map(() => "?").join(",");
			conditions.push(`api_key_name IN (${placeholders})`);
			queryParams.push(...apiKeysFilter);
		}

		if (statusFilter === "success") {
			conditions.push("success = TRUE");
		} else if (statusFilter === "error") {
			conditions.push("success = FALSE");
		}

		const whereClause = conditions.join(" AND ");

		try {
			// Check if we need per-model time series
			const includeModelBreakdown = params.get("modelBreakdown") === "true";

			// Consolidated query to get all analytics data in a single roundtrip
			const consolidatedResult = await db.get<{
				total_requests: number;
				success_rate: number;
				avg_response_time: number;
				total_tokens: number;
				total_cost_usd: number;
				avg_tokens_per_second: number;
				active_accounts: number;
				input_tokens: number;
				cache_read_input_tokens: number;
				cache_creation_input_tokens: number;
				output_tokens: number;
			}>(
				`
				WITH filtered_requests AS (
					SELECT * FROM requests r
					WHERE ${whereClause}
				)
				SELECT
					(SELECT COUNT(*) FROM filtered_requests) as total_requests,
					(SELECT SUM(CASE WHEN success = TRUE THEN 1 ELSE 0 END) * 100.0 / NULLIF(COUNT(*), 0) FROM filtered_requests) as success_rate,
					(SELECT AVG(response_time_ms) FROM filtered_requests) as avg_response_time,
					(SELECT SUM(COALESCE(total_tokens, 0)) FROM filtered_requests) as total_tokens,
					(SELECT SUM(COALESCE(cost_usd, 0)) FROM filtered_requests) as total_cost_usd,
					(SELECT AVG(output_tokens_per_second) FROM filtered_requests) as avg_tokens_per_second,
					(SELECT COUNT(DISTINCT COALESCE(account_used, ?)) FROM filtered_requests) as active_accounts,
					(SELECT SUM(COALESCE(input_tokens, 0)) FROM filtered_requests) as input_tokens,
					(SELECT SUM(COALESCE(cache_read_input_tokens, 0)) FROM filtered_requests) as cache_read_input_tokens,
					(SELECT SUM(COALESCE(cache_creation_input_tokens, 0)) FROM filtered_requests) as cache_creation_input_tokens,
					(SELECT SUM(COALESCE(output_tokens, 0)) FROM filtered_requests) as output_tokens
			`,
				[...queryParams, NO_ACCOUNT_ID],
			);

			// Get time series data
			const timeSeries = await db.query<{
				ts: number;
				model?: string;
				requests: number;
				tokens: number;
				cost_usd: number;
				success_rate: number;
				error_rate: number;
				cache_hit_rate: number;
				avg_response_time: number;
				avg_tokens_per_second: number | null;
			}>(
				`
				SELECT
					(timestamp / ?) * ? as ts,
					${includeModelBreakdown ? "model," : ""}
					COUNT(*) as requests,
					SUM(COALESCE(total_tokens, 0)) as tokens,
					SUM(COALESCE(cost_usd, 0)) as cost_usd,
					SUM(CASE WHEN success = TRUE THEN 1 ELSE 0 END) * 100.0 / NULLIF(COUNT(*), 0) as success_rate,
					SUM(CASE WHEN success = FALSE THEN 1 ELSE 0 END) * 100.0 / NULLIF(COUNT(*), 0) as error_rate,
					SUM(COALESCE(cache_read_input_tokens, 0)) * 100.0 /
						NULLIF(SUM(COALESCE(input_tokens, 0) + COALESCE(cache_read_input_tokens, 0) + COALESCE(cache_creation_input_tokens, 0)), 0) as cache_hit_rate,
					AVG(response_time_ms) as avg_response_time,
					AVG(output_tokens_per_second) as avg_tokens_per_second
				FROM requests r
				WHERE ${whereClause} ${includeModelBreakdown ? "AND model IS NOT NULL" : ""}
				GROUP BY ts${includeModelBreakdown ? ", model" : ""}
				ORDER BY ts${includeModelBreakdown ? ", model" : ""}
			`,
				[bucket.bucketMs, bucket.bucketMs, ...queryParams],
			);

			// Get additional data (model distribution, account performance, cost by model, api key performance, account model usage)
			const additionalData = await db.query<{
				data_type: string;
				name: string;
				secondary_name: string | null;
				count: number | null;
				requests: number | null;
				success_rate: number | null;
				cost_usd: number | null;
				total_tokens: number | null;
			}>(
				`
				SELECT * FROM (
					SELECT
						'model_distribution' as data_type,
						model as name,
						CAST(NULL AS TEXT) as secondary_name,
						COUNT(*) as count,
						CAST(NULL AS BIGINT) as requests,
						CAST(NULL AS DOUBLE PRECISION) as success_rate,
						CAST(NULL AS DOUBLE PRECISION) as cost_usd,
						CAST(NULL AS BIGINT) as total_tokens
					FROM requests r
					WHERE ${whereClause} AND model IS NOT NULL
					GROUP BY model
					ORDER BY count DESC
					LIMIT 10
				) q1

				UNION ALL

				SELECT * FROM (
					SELECT
						'account_performance' as data_type,
						COALESCE(a.name, ?) as name,
						CAST(NULL AS TEXT) as secondary_name,
						CAST(NULL AS BIGINT) as count,
						COUNT(r.id) as requests,
						SUM(CASE WHEN r.success = TRUE THEN 1 ELSE 0 END) * 100.0 / NULLIF(COUNT(r.id), 0) as success_rate,
						CAST(NULL AS DOUBLE PRECISION) as cost_usd,
						CAST(NULL AS BIGINT) as total_tokens
					FROM requests r
					LEFT JOIN accounts a ON a.id = r.account_used
					WHERE ${whereClause}
					GROUP BY name
					HAVING COUNT(r.id) > 0
					ORDER BY requests DESC
					LIMIT 10
				) q2

				UNION ALL

				SELECT * FROM (
					SELECT
						'cost_by_model' as data_type,
						model as name,
						CAST(NULL AS TEXT) as secondary_name,
						CAST(NULL AS BIGINT) as count,
						COUNT(*) as requests,
						CAST(NULL AS DOUBLE PRECISION) as success_rate,
						SUM(COALESCE(cost_usd, 0)) as cost_usd,
						SUM(COALESCE(total_tokens, 0)) as total_tokens
					FROM requests r
					WHERE ${whereClause} AND COALESCE(cost_usd, 0) > 0 AND model IS NOT NULL
					GROUP BY model
					ORDER BY cost_usd DESC
					LIMIT 10
				) q3

				UNION ALL

				SELECT * FROM (
					SELECT
						'api_key_performance' as data_type,
						api_key_name as name,
						CAST(NULL AS TEXT) as secondary_name,
						CAST(NULL AS BIGINT) as count,
						COUNT(*) as requests,
						SUM(CASE WHEN success = TRUE THEN 1 ELSE 0 END) * 100.0 / NULLIF(COUNT(*), 0) as success_rate,
						CAST(NULL AS DOUBLE PRECISION) as cost_usd,
						CAST(NULL AS BIGINT) as total_tokens
					FROM requests r
					WHERE ${whereClause} AND api_key_id IS NOT NULL
					GROUP BY api_key_id, api_key_name
					HAVING COUNT(*) > 0
					ORDER BY requests DESC
					LIMIT 10
				) q4

				UNION ALL

				SELECT * FROM (
					SELECT
						'account_model_usage' as data_type,
						COALESCE(a.name, 'Unknown') as name,
						r.model as secondary_name,
						COUNT(*) as count,
						CAST(NULL AS BIGINT) as requests,
						CAST(NULL AS DOUBLE PRECISION) as success_rate,
						CAST(NULL AS DOUBLE PRECISION) as cost_usd,
						CAST(NULL AS BIGINT) as total_tokens
					FROM requests r
					LEFT JOIN accounts a ON a.id = r.account_used
					WHERE ${whereClause} AND r.model IS NOT NULL
					GROUP BY COALESCE(a.name, 'Unknown'), r.model
					HAVING COUNT(*) > 0
					ORDER BY count DESC
					LIMIT 50
				) q5
			`,
				[
					...queryParams,
					NO_ACCOUNT_ID,
					...queryParams,
					...queryParams,
					...queryParams,
					...queryParams,
				],
			);

			// Parse the combined results
			const modelDistribution = additionalData
				.filter((row) => row.data_type === "model_distribution")
				.map((row) => ({
					model: row.name,
					count: Number(row.count) || 0,
				}));

			const accountPerformance = additionalData
				.filter((row) => row.data_type === "account_performance")
				.map((row) => ({
					name: row.name,
					requests: Number(row.requests) || 0,
					successRate: Number(row.success_rate) || 0,
				}));

			const costByModel = additionalData
				.filter((row) => row.data_type === "cost_by_model")
				.map((row) => ({
					model: row.name,
					costUsd: Number(row.cost_usd) || 0,
					requests: Number(row.requests) || 0,
					totalTokens: Number(row.total_tokens) || 0,
				}));

			const apiKeyPerformance = additionalData
				.filter((row) => row.data_type === "api_key_performance")
				.map((row) => ({
					id: row.name, // API key name used as id for now
					name: row.name,
					requests: Number(row.requests) || 0,
					successRate: Number(row.success_rate) || 0,
				}));

			const accountModelUsage = additionalData
				.filter((row) => row.data_type === "account_model_usage")
				.map((row) => ({
					account: row.name,
					model: row.secondary_name ?? "Unknown",
					count: Number(row.count) || 0,
				}));

			// Get model performance metrics
			const modelPerfData = await db.query<{
				model: string;
				avg_response_time: number;
				max_response_time: number;
				total_requests: number;
				error_count: number;
				error_rate: number;
				avg_tokens_per_second: number | null;
				p95_response_time: number | null;
				min_tokens_per_second: number | null;
				max_tokens_per_second: number | null;
			}>(
				`
				WITH filtered AS (
					SELECT
						model,
						response_time_ms,
						output_tokens_per_second,
						success
					FROM requests r
					WHERE ${whereClause}
						AND model IS NOT NULL
						AND response_time_ms IS NOT NULL
				),
				ranked AS (
					SELECT
						model,
						response_time_ms,
						output_tokens_per_second,
						success,
						PERCENT_RANK() OVER (
							PARTITION BY model
							ORDER BY response_time_ms
						) AS pr
					FROM filtered
				)
				SELECT
					model,
					AVG(response_time_ms) as avg_response_time,
					MAX(response_time_ms) as max_response_time,
					COUNT(*) as total_requests,
					SUM(CASE WHEN success = FALSE THEN 1 ELSE 0 END) as error_count,
					SUM(CASE WHEN success = FALSE THEN 1 ELSE 0 END) * 100.0 / NULLIF(COUNT(*), 0) as error_rate,
					AVG(output_tokens_per_second) as avg_tokens_per_second,
					MIN(CASE WHEN pr >= 0.95 THEN response_time_ms END) as p95_response_time,
					MIN(CASE WHEN output_tokens_per_second > 0 THEN output_tokens_per_second ELSE NULL END) as min_tokens_per_second,
					MAX(CASE WHEN output_tokens_per_second > 0 THEN output_tokens_per_second ELSE NULL END) as max_tokens_per_second
				FROM ranked
				GROUP BY model
				ORDER BY total_requests DESC
				LIMIT 10
			`,
				queryParams,
			);

			const modelPerformance = modelPerfData.map((modelData) => ({
				model: modelData.model,
				avgResponseTime: Number(modelData.avg_response_time) || 0,
				p95ResponseTime:
					Number(modelData.p95_response_time) ||
					Number(modelData.max_response_time) ||
					Number(modelData.avg_response_time) ||
					0,
				errorRate: Number(modelData.error_rate) || 0,
				avgTokensPerSecond:
					modelData.avg_tokens_per_second != null
						? Number(modelData.avg_tokens_per_second)
						: null,
				minTokensPerSecond:
					modelData.min_tokens_per_second != null
						? Number(modelData.min_tokens_per_second)
						: null,
				maxTokensPerSecond:
					modelData.max_tokens_per_second != null
						? Number(modelData.max_tokens_per_second)
						: null,
			}));

			// Transform timeSeries data
			let transformedTimeSeries = timeSeries.map((point) => ({
				ts: Number(point.ts),
				...(point.model && { model: point.model }),
				requests: Number(point.requests) || 0,
				tokens: Number(point.tokens) || 0,
				costUsd: Number(point.cost_usd) || 0,
				successRate: Number(point.success_rate) || 0,
				errorRate: Number(point.error_rate) || 0,
				cacheHitRate: Number(point.cache_hit_rate) || 0,
				avgResponseTime: Number(point.avg_response_time) || 0,
				avgTokensPerSecond:
					point.avg_tokens_per_second != null
						? Number(point.avg_tokens_per_second)
						: null,
			}));

			// Apply cumulative transformation if requested
			if (isCumulative && !includeModelBreakdown) {
				let runningRequests = 0;
				let runningTokens = 0;
				let runningCostUsd = 0;

				transformedTimeSeries = transformedTimeSeries.map((point) => {
					runningRequests += point.requests;
					runningTokens += point.tokens;
					runningCostUsd += point.costUsd;

					return {
						...point,
						requests: runningRequests,
						tokens: runningTokens,
						costUsd: runningCostUsd,
						// Keep rates as-is (not cumulative)
					};
				});
			} else if (isCumulative && includeModelBreakdown) {
				// For per-model cumulative, track running totals per model
				const runningTotals: Record<
					string,
					{ requests: number; tokens: number; costUsd: number }
				> = {};

				transformedTimeSeries = transformedTimeSeries.map((point) => {
					if (point.model) {
						if (!runningTotals[point.model]) {
							runningTotals[point.model] = {
								requests: 0,
								tokens: 0,
								costUsd: 0,
							};
						}
						runningTotals[point.model].requests += point.requests;
						runningTotals[point.model].tokens += point.tokens;
						runningTotals[point.model].costUsd += point.costUsd;

						return {
							...point,
							requests: runningTotals[point.model].requests,
							tokens: runningTotals[point.model].tokens,
							costUsd: runningTotals[point.model].costUsd,
						};
					}
					return point;
				});
			}

			const response: AnalyticsResponse = {
				meta: {
					range,
					bucket: bucket.displayName,
					cumulative: isCumulative,
				},
				totals: {
					requests: Number(consolidatedResult?.total_requests) || 0,
					successRate: Number(consolidatedResult?.success_rate) || 0,
					activeAccounts: Number(consolidatedResult?.active_accounts) || 0,
					avgResponseTime: Number(consolidatedResult?.avg_response_time) || 0,
					totalTokens: Number(consolidatedResult?.total_tokens) || 0,
					totalCostUsd: Number(consolidatedResult?.total_cost_usd) || 0,
					avgTokensPerSecond:
						consolidatedResult?.avg_tokens_per_second != null
							? Number(consolidatedResult.avg_tokens_per_second)
							: null,
				},
				timeSeries: transformedTimeSeries,
				tokenBreakdown: {
					inputTokens: Number(consolidatedResult?.input_tokens) || 0,
					cacheReadInputTokens:
						Number(consolidatedResult?.cache_read_input_tokens) || 0,
					cacheCreationInputTokens:
						Number(consolidatedResult?.cache_creation_input_tokens) || 0,
					outputTokens: Number(consolidatedResult?.output_tokens) || 0,
				},
				modelDistribution,
				accountPerformance,
				apiKeyPerformance,
				costByModel,
				accountModelUsage,
				modelPerformance,
			};

			return jsonResponse(response);
		} catch (error) {
			log.error("Analytics error:", error);
			return errorResponse(
				InternalServerError("Failed to fetch analytics data"),
			);
		}
	};
}
