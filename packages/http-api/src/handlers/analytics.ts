import type { AnalyticsResponse, APIContext } from "../types";

interface BucketConfig {
	bucketMs: number;
	displayName: string;
}

interface TotalsResult {
	total_requests: number;
	success_rate: number;
	avg_response_time: number;
	total_tokens: number;
	total_cost_usd: number;
}

interface ActiveAccountsResult {
	active_accounts: number;
}

interface TokenBreakdownResult {
	input_tokens: number;
	cache_read_input_tokens: number;
	cache_creation_input_tokens: number;
	output_tokens: number;
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
	return async (range: string): Promise<Response> => {
		const { db } = context;
		const { startMs, bucket } = getRangeConfig(range);

		try {
			// Get totals
			const totalsQuery = db.prepare(`
				SELECT
					COUNT(*) as total_requests,
					SUM(CASE WHEN success = 1 THEN 1 ELSE 0 END) * 100.0 / NULLIF(COUNT(*), 0) as success_rate,
					AVG(response_time_ms) as avg_response_time,
					SUM(total_tokens) as total_tokens,
					SUM(cost_usd) as total_cost_usd
				FROM requests
				WHERE timestamp > ?
			`);
			const totals = totalsQuery.get(startMs) as TotalsResult;

			// Get active accounts count
			const activeAccountsQuery = db.prepare(`
				SELECT COUNT(DISTINCT account_used) as active_accounts
				FROM requests
				WHERE timestamp > ? AND account_used IS NOT NULL
			`);
			const activeAccounts = activeAccountsQuery.get(
				startMs,
			) as ActiveAccountsResult;

			// Get time series data
			const timeSeriesQuery = db.prepare(`
				SELECT
					(timestamp / ?) * ? as ts,
					COUNT(*) as requests,
					SUM(total_tokens) as tokens,
					SUM(cost_usd) as cost_usd,
					SUM(CASE WHEN success = 1 THEN 1 ELSE 0 END) * 100.0 / NULLIF(COUNT(*), 0) as success_rate,
					SUM(CASE WHEN success = 0 THEN 1 ELSE 0 END) * 100.0 / NULLIF(COUNT(*), 0) as error_rate,
					SUM(cache_read_input_tokens) * 100.0 / 
						NULLIF(SUM(input_tokens + cache_read_input_tokens), 0) as cache_hit_rate,
					AVG(response_time_ms) as avg_response_time
				FROM requests
				WHERE timestamp > ?
				GROUP BY ts
				ORDER BY ts
			`);
			const timeSeries = timeSeriesQuery.all(
				bucket.bucketMs,
				bucket.bucketMs,
				startMs,
			) as Array<{
				ts: number;
				requests: number;
				tokens: number;
				cost_usd: number;
				success_rate: number;
				error_rate: number;
				cache_hit_rate: number;
				avg_response_time: number;
			}>;

			// Get token breakdown
			const tokenBreakdownQuery = db.prepare(`
				SELECT
					SUM(input_tokens) as input_tokens,
					SUM(cache_read_input_tokens) as cache_read_input_tokens,
					SUM(cache_creation_input_tokens) as cache_creation_input_tokens,
					SUM(output_tokens) as output_tokens
				FROM requests
				WHERE timestamp > ?
			`);
			const tokenBreakdown = tokenBreakdownQuery.get(
				startMs,
			) as TokenBreakdownResult;

			// Get model distribution
			const modelDistQuery = db.prepare(`
				SELECT
					model,
					COUNT(*) as count
				FROM requests
				WHERE timestamp > ? AND model IS NOT NULL
				GROUP BY model
				ORDER BY count DESC
				LIMIT 10
			`);
			const modelDistribution = modelDistQuery.all(startMs) as Array<{
				model: string;
				count: number;
			}>;

			// Get account performance
			const accountPerfQuery = db.prepare(`
				SELECT
					a.name,
					COUNT(r.id) as requests,
					SUM(CASE WHEN r.success = 1 THEN 1 ELSE 0 END) * 100.0 / NULLIF(COUNT(r.id), 0) as success_rate
				FROM accounts a
				LEFT JOIN requests r ON a.id = r.account_used AND r.timestamp > ?
				GROUP BY a.name
				HAVING requests > 0
				ORDER BY requests DESC
			`);
			const accountPerformance = accountPerfQuery.all(startMs) as Array<{
				name: string;
				requests: number;
				success_rate: number;
			}>;

			// Get cost by endpoint
			const costByEndpointQuery = db.prepare(`
				SELECT
					path,
					SUM(cost_usd) as cost_usd,
					COUNT(*) as requests
				FROM requests
				WHERE timestamp > ? AND cost_usd > 0
				GROUP BY path
				ORDER BY cost_usd DESC
				LIMIT 10
			`);
			const costByEndpoint = costByEndpointQuery.all(startMs) as Array<{
				path: string;
				cost_usd: number;
				requests: number;
			}>;

			const response: AnalyticsResponse = {
				totals: {
					requests: totals.total_requests || 0,
					successRate: totals.success_rate || 0,
					activeAccounts: activeAccounts.active_accounts || 0,
					avgResponseTime: totals.avg_response_time || 0,
					totalTokens: totals.total_tokens || 0,
					totalCostUsd: totals.total_cost_usd || 0,
				},
				timeSeries: timeSeries.map((point) => ({
					ts: point.ts,
					requests: point.requests || 0,
					tokens: point.tokens || 0,
					costUsd: point.cost_usd || 0,
					successRate: point.success_rate || 0,
					errorRate: point.error_rate || 0,
					cacheHitRate: point.cache_hit_rate || 0,
					avgResponseTime: point.avg_response_time || 0,
				})),
				tokenBreakdown: {
					inputTokens: tokenBreakdown?.input_tokens || 0,
					cacheReadInputTokens: tokenBreakdown?.cache_read_input_tokens || 0,
					cacheCreationInputTokens:
						tokenBreakdown?.cache_creation_input_tokens || 0,
					outputTokens: tokenBreakdown?.output_tokens || 0,
				},
				modelDistribution,
				accountPerformance: accountPerformance.map((acc) => ({
					name: acc.name,
					requests: acc.requests,
					successRate: acc.success_rate || 0,
				})),
				costByEndpoint: costByEndpoint.map((endpoint) => ({
					path: endpoint.path,
					costUsd: endpoint.cost_usd || 0,
					requests: endpoint.requests || 0,
				})),
			};

			return new Response(JSON.stringify(response), {
				headers: { "Content-Type": "application/json" },
			});
		} catch (error) {
			console.error("Analytics error:", error);
			return new Response(
				JSON.stringify({ error: "Failed to fetch analytics data" }),
				{
					status: 500,
					headers: { "Content-Type": "application/json" },
				},
			);
		}
	};
}
