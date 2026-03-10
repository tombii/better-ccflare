/**
 * Consolidated stats repository to eliminate duplication between cli-commands and http-api
 */

import { NO_ACCOUNT_ID } from "@better-ccflare/types";
import type { BunSqlAdapter } from "../adapters/bun-sql-adapter";

export interface AccountStats {
	name: string;
	requestCount: number;
	successRate: number;
	totalRequests?: number;
}

export interface AggregatedStats {
	totalRequests: number;
	successfulRequests: number;
	avgResponseTime: number;
	totalTokens: number;
	totalCostUsd: number;
	inputTokens: number;
	outputTokens: number;
	cacheReadInputTokens: number;
	cacheCreationInputTokens: number;
	avgTokensPerSecond: number | null;
}

export class StatsRepository {
	constructor(private adapter: BunSqlAdapter) {}

	/**
	 * Get aggregated statistics for requests within a time window.
	 * @param sinceMs - Only include requests after this timestamp (ms since epoch).
	 *   Defaults to 30 days ago to avoid full-table scans on large deployments.
	 */
	async getAggregatedStats(sinceMs?: number): Promise<AggregatedStats> {
		const since = sinceMs ?? Date.now() - 30 * 24 * 60 * 60 * 1000;
		const stats = await this.adapter.get<{
			totalRequests: unknown;
			successfulRequests: unknown;
			avgResponseTime: unknown;
			inputTokens: unknown;
			outputTokens: unknown;
			cacheCreationInputTokens: unknown;
			cacheReadInputTokens: unknown;
			totalCostUsd: unknown;
			avgTokensPerSecond: unknown;
		}>(
			`SELECT
				COUNT(*) as "totalRequests",
				SUM(CASE WHEN success = TRUE THEN 1 ELSE 0 END) as "successfulRequests",
				AVG(response_time_ms) as "avgResponseTime",
				SUM(input_tokens) as "inputTokens",
				SUM(output_tokens) as "outputTokens",
				SUM(cache_creation_input_tokens) as "cacheCreationInputTokens",
				SUM(cache_read_input_tokens) as "cacheReadInputTokens",
				SUM(cost_usd) as "totalCostUsd",
				AVG(output_tokens_per_second) as "avgTokensPerSecond"
			FROM requests
			WHERE timestamp > ?`,
			[since],
		);

		const s = stats ?? {};

		const totalRequests =
			Number((s as { totalRequests: unknown }).totalRequests) || 0;
		const successfulRequests =
			Number((s as { successfulRequests: unknown }).successfulRequests) || 0;
		const inputTokens =
			Number((s as { inputTokens: unknown }).inputTokens) || 0;
		const outputTokens =
			Number((s as { outputTokens: unknown }).outputTokens) || 0;
		const cacheCreationInputTokens =
			Number(
				(s as { cacheCreationInputTokens: unknown }).cacheCreationInputTokens,
			) || 0;
		const cacheReadInputTokens =
			Number((s as { cacheReadInputTokens: unknown }).cacheReadInputTokens) ||
			0;

		return {
			totalRequests,
			successfulRequests,
			avgResponseTime:
				Number((s as { avgResponseTime: unknown }).avgResponseTime) || 0,
			totalTokens:
				inputTokens +
				outputTokens +
				cacheCreationInputTokens +
				cacheReadInputTokens,
			totalCostUsd: Number((s as { totalCostUsd: unknown }).totalCostUsd) || 0,
			inputTokens,
			outputTokens,
			cacheCreationInputTokens,
			cacheReadInputTokens,
			avgTokensPerSecond:
				(s as { avgTokensPerSecond: unknown }).avgTokensPerSecond != null
					? Number((s as { avgTokensPerSecond: unknown }).avgTokensPerSecond)
					: null,
		};
	}

	/**
	 * Get account statistics with success rates
	 * This consolidates the duplicated logic between cli-commands and http-api
	 */
	async getAccountStats(
		limit = 10,
		includeUnauthenticated = true,
	): Promise<AccountStats[]> {
		// Get account request counts
		let accountStats: Array<{
			id: string;
			name: string;
			requestCount: number;
			totalRequests: number;
		}>;

		if (includeUnauthenticated) {
			accountStats = await this.adapter.query<{
				id: string;
				name: string;
				requestCount: number;
				totalRequests: number;
			}>(
				`
				SELECT
					COALESCE(a.id, ?) as id,
					COALESCE(a.name, ?) as name,
					COUNT(r.id) as "requestCount",
					COALESCE(MAX(a.total_requests), 0) as "totalRequests"
				FROM requests r
				LEFT JOIN accounts a ON a.id = r.account_used
				GROUP BY 1, 2
				HAVING COUNT(r.id) > 0
				ORDER BY "requestCount" DESC
				LIMIT ?
			`,
				[NO_ACCOUNT_ID, NO_ACCOUNT_ID, limit],
			);
		} else {
			accountStats = await this.adapter.query<{
				id: string;
				name: string;
				requestCount: number;
				totalRequests: number;
			}>(
				`
				SELECT
					a.id,
					a.name,
					a.request_count as "requestCount",
					a.total_requests as "totalRequests"
				FROM accounts a
				WHERE a.request_count > 0
				ORDER BY a.request_count DESC
				LIMIT ?
			`,
				[limit],
			);
		}

		// Calculate success rate per account using a batch query
		if (accountStats.length === 0) return [];

		const accountIds = accountStats.map((a) => a.id);
		const placeholders = accountIds.map(() => "?").join(",");

		const successRates = await this.adapter.query<{
			accountId: string;
			total: number;
			successful: number;
		}>(
			`SELECT
				account_used as "accountId",
				COUNT(*) as total,
				SUM(CASE WHEN success = TRUE THEN 1 ELSE 0 END) as successful
			FROM requests
			WHERE account_used IN (${placeholders})
			GROUP BY account_used`,
			accountIds,
		);

		// Create a map for O(1) lookup
		const successRateMap = new Map(
			successRates.map((sr) => [
				sr.accountId,
				Number(sr.total) > 0
					? Math.round((Number(sr.successful) / Number(sr.total)) * 100)
					: 0,
			]),
		);

		// Combine the data
		return accountStats.map((acc) => ({
			name: acc.name,
			requestCount: Number(acc.requestCount),
			successRate: successRateMap.get(acc.id) || 0,
			totalRequests: Number(acc.totalRequests),
		}));
	}

	/**
	 * Get count of active accounts
	 */
	async getActiveAccountCount(): Promise<number> {
		const result = await this.adapter.get<{ count: unknown }>(
			"SELECT COUNT(*) as count FROM accounts WHERE request_count > 0",
		);
		return Number(result?.count) || 0;
	}

	/**
	 * Get recent errors (already exists in request.repository, but adding for completeness)
	 */
	async getRecentErrors(limit = 10): Promise<string[]> {
		const errors = await this.adapter.query<{ error_message: string }>(
			`SELECT error_message, MAX(timestamp) as latest
			FROM requests
			WHERE error_message IS NOT NULL
				AND error_message != ''
			GROUP BY error_message
			ORDER BY latest DESC
			LIMIT ?`,
			[limit],
		);

		return errors.map((e) => e.error_message);
	}

	/**
	 * Get top models by usage
	 */
	async getTopModels(
		limit = 5,
	): Promise<Array<{ model: string; count: number; percentage: number }>> {
		const rows = await this.adapter.query<{
			model: string;
			count: unknown;
			percentage: unknown;
		}>(
			`WITH model_counts AS (
				SELECT
					model,
					COUNT(*) as count
				FROM requests
				WHERE model IS NOT NULL
				GROUP BY model
			),
			total AS (
				SELECT COUNT(*) as total FROM requests WHERE model IS NOT NULL
			)
			SELECT
				mc.model,
				mc.count,
				ROUND(CAST(CAST(mc.count AS REAL) / t.total * 100 AS NUMERIC), 2) as percentage
			FROM model_counts mc, total t
			ORDER BY mc.count DESC
			LIMIT ?`,
			[limit],
		);
		return rows.map((r) => ({
			model: r.model,
			count: Number(r.count),
			percentage: Number(r.percentage),
		}));
	}

	/**
	 * Get API key statistics with success rates
	 */
	async getApiKeyStats(): Promise<
		Array<{
			id: string;
			name: string;
			requests: number;
			successRate: number;
		}>
	> {
		// Get API key request counts
		const apiKeyStats = await this.adapter.query<{
			id: string;
			name: string;
			requests: number;
		}>(
			`SELECT
				api_key_id as id,
				api_key_name as name,
				COUNT(*) as requests
			FROM requests
			WHERE api_key_id IS NOT NULL
			GROUP BY api_key_id, api_key_name
			HAVING COUNT(*) > 0
			ORDER BY requests DESC`,
		);

		if (apiKeyStats.length === 0) return [];

		// Calculate success rate per API key
		// Security: apiKeyIds are sourced directly from database query results above,
		// ensuring they are safe strings from the api_key_id column (UUID format).
		// The placeholder construction is safe because we validate the array is non-empty
		// and use parameterized queries for the actual values.
		const apiKeyIds = apiKeyStats
			.map((a) => a.id)
			.filter((id) => {
				// Additional safety: ensure ID is a valid non-empty string
				return typeof id === "string" && id.length > 0 && id.length < 256;
			});

		if (apiKeyIds.length === 0) return [];

		const placeholders = apiKeyIds.map(() => "?").join(",");

		const successRates = await this.adapter.query<{
			apiKeyId: string;
			total: number;
			successful: number;
		}>(
			`SELECT
				api_key_id as "apiKeyId",
				COUNT(*) as total,
				SUM(CASE WHEN success = TRUE THEN 1 ELSE 0 END) as successful
			FROM requests
			WHERE api_key_id IN (${placeholders})
			GROUP BY api_key_id`,
			apiKeyIds,
		);

		// Create a map for O(1) lookup
		const successRateMap = new Map(
			successRates.map((sr) => [
				sr.apiKeyId,
				Number(sr.total) > 0
					? Math.round((Number(sr.successful) / Number(sr.total)) * 100)
					: 0,
			]),
		);

		// Combine the data
		return apiKeyStats.map((key) => ({
			id: key.id,
			name: key.name,
			requests: key.requests,
			successRate: successRateMap.get(key.id) || 0,
		}));
	}
}
