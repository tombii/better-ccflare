/**
 * Consolidated stats repository to eliminate duplication between cli-commands and http-api
 */

import type {
	RateLimitReason,
	RecentErrorGroup,
	SessionStats,
} from "@better-ccflare/types";
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
	 *
	 * @param sinceMs - When given (and includeUnauthenticated is true), only
	 *   requests after this timestamp (ms since epoch) are counted. Omit for the
	 *   lifetime view. Ignored on the includeUnauthenticated=false path, which
	 *   reads a precomputed accounts.request_count counter.
	 */
	async getAccountStats(
		limit = 10,
		includeUnauthenticated = true,
		sinceMs?: number,
	): Promise<AccountStats[]> {
		// Get account request counts
		let accountStats: Array<{
			id: string;
			name: string;
			requestCount: number;
			totalRequests: number;
		}>;

		if (includeUnauthenticated) {
			const windowClause = sinceMs !== undefined ? "WHERE r.timestamp > ?" : "";
			const windowParams = sinceMs !== undefined ? [sinceMs] : [];
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
				${windowClause}
				GROUP BY 1, 2
				HAVING COUNT(r.id) > 0
				ORDER BY "requestCount" DESC
				LIMIT ?
			`,
				[NO_ACCOUNT_ID, NO_ACCOUNT_ID, ...windowParams, limit],
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

		// Legacy rows whose account_used is literally 'no_account' and rows with
		// NULL account_used (current encoding for requests with no attributed
		// account) both land in the NO_ACCOUNT_ID bucket produced by the LEFT
		// JOIN above. The WHERE keeps a bare `account_used IN (...)` so it can use
		// the account_used index (the literal NO_ACCOUNT_ID stays in the IN list
		// for legacy rows), and only adds `OR account_used IS NULL` when the
		// NO_ACCOUNT_ID bucket was actually requested.
		//
		// The SELECT still maps NULL to NO_ACCOUNT_ID via COALESCE, and GROUP BY 1
		// references that output column instead of repeating the expression with
		// another bind parameter. BunSqlAdapter's placeholder renumberer assigns
		// each bare `?` a fresh $N independently, so SELECT / GROUP BY would
		// otherwise render as COALESCE(..., $1) / COALESCE(..., $2).
		// PostgreSQL treats those as distinct expression trees and rejects the
		// query with SQLSTATE 42803 ("column ... must appear in the GROUP BY
		// clause"). SQLite does not enforce that, which is why the SQLite-only
		// test suite passed.
		const includesNoAccount = accountIds.includes(NO_ACCOUNT_ID);
		const accountPredicate = includesNoAccount
			? `(account_used IN (${placeholders}) OR account_used IS NULL)`
			: `account_used IN (${placeholders})`;
		const successWindow = sinceMs !== undefined ? " AND timestamp > ?" : "";
		const successRates = await this.adapter.query<{
			accountId: string;
			total: number;
			successful: number;
		}>(
			`SELECT
				COALESCE(account_used, ?) as "accountId",
				COUNT(*) as total,
				SUM(CASE WHEN success = TRUE THEN 1 ELSE 0 END) as successful
			FROM requests
			WHERE ${accountPredicate}${successWindow}
			GROUP BY 1`,
			[
				NO_ACCOUNT_ID,
				...accountIds,
				...(sinceMs !== undefined ? [sinceMs] : []),
			],
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
	 * Get recent error groups within a time window.
	 *
	 * Groups requests by (error_message, account_used) and returns one entry per
	 * group with metadata sourced from the most recent occurrence plus aggregate
	 * stats and the owning account's current rate-limit state.
	 *
	 * @param sinceMs - Only include requests after this timestamp (ms since epoch).
	 * @param limit - Maximum number of groups to return.
	 *
	 * Implemented as a plain GROUP BY aggregate (count / first / latest
	 * timestamp) joined back to the latest row of each group. Ties on the
	 * latest timestamp within a group resolve to the smallest request id.
	 * The unattributed bucket (NULL and legacy 'no_account') is a single group.
	 */
	async getRecentErrorGroups(
		sinceMs: number,
		limit = 10,
	): Promise<RecentErrorGroup[]> {
		const rows = await this.adapter.query<{
			latest_request_id: unknown;
			latest_timestamp: unknown;
			error_code: unknown;
			account_id: unknown;
			model: unknown;
			status_code: unknown;
			path: unknown;
			failover_attempts: unknown;
			occurrence_count: unknown;
			first_seen: unknown;
			account_name: unknown;
			provider: unknown;
			rate_limited_until: unknown;
			rate_limited_reason: unknown;
			rate_limited_at: unknown;
		}>(
			`WITH grouped AS (
				SELECT g.error_message, g.account_key,
				       COUNT(*)         AS occurrence_count,
				       MIN(g.timestamp) AS first_seen,
				       MAX(g.timestamp) AS latest_timestamp
				FROM (
					SELECT r.error_message, COALESCE(r.account_used, ?) AS account_key, r.timestamp
					FROM requests r
					WHERE r.error_message IS NOT NULL
					  AND r.error_message != ''
					  AND r.timestamp > ?
				) g
				GROUP BY 1, 2
				ORDER BY latest_timestamp DESC
				LIMIT ?
			)
			SELECT
				r.id                   AS latest_request_id,
				r.timestamp            AS latest_timestamp,
				r.error_message        AS error_code,
				r.account_used         AS account_id,
				r.model,
				r.status_code,
				r.path,
				r.failover_attempts,
				grouped.occurrence_count,
				grouped.first_seen,
				a.name                 AS account_name,
				a.provider             AS provider,
				a.rate_limited_until   AS rate_limited_until,
				a.rate_limited_reason  AS rate_limited_reason,
				a.rate_limited_at      AS rate_limited_at
			FROM grouped
			JOIN requests r
			  ON r.error_message = grouped.error_message
			 AND r.timestamp = grouped.latest_timestamp
			 AND COALESCE(r.account_used, ?) = grouped.account_key
			LEFT JOIN accounts a ON a.id = r.account_used
			WHERE NOT EXISTS (
				SELECT 1 FROM requests r2
				WHERE r2.error_message = grouped.error_message
				  AND r2.timestamp = grouped.latest_timestamp
				  AND COALESCE(r2.account_used, ?) = grouped.account_key
				  AND r2.id < r.id
			)
			ORDER BY r.timestamp DESC, r.id`,
			[NO_ACCOUNT_ID, sinceMs, limit, NO_ACCOUNT_ID, NO_ACCOUNT_ID],
		);

		return rows.map((row) => {
			const accountId = row.account_id == null ? null : String(row.account_id);
			const accountName =
				row.account_name == null ? null : String(row.account_name);
			const provider = row.provider == null ? null : String(row.provider);
			const model = row.model == null ? null : String(row.model);
			const path = row.path == null ? null : String(row.path);
			const statusCode =
				row.status_code == null ? null : Number(row.status_code);
			const rateLimitedUntil =
				row.rate_limited_until == null ? null : Number(row.rate_limited_until);
			const rateLimitedAt =
				row.rate_limited_at == null ? null : Number(row.rate_limited_at);
			const rateLimitedReason =
				row.rate_limited_reason == null
					? null
					: (String(row.rate_limited_reason) as RateLimitReason);

			return {
				errorCode: String(row.error_code ?? ""),
				accountId,
				accountName,
				provider,
				occurrenceCount: Number(row.occurrence_count) || 0,
				latestTimestamp: Number(row.latest_timestamp) || 0,
				firstTimestamp: Number(row.first_seen) || 0,
				latestRequestId: String(row.latest_request_id ?? ""),
				model,
				statusCode,
				path,
				failoverAttempts: Number(row.failover_attempts) || 0,
				rateLimitedUntil,
				rateLimitedReason,
				rateLimitedAt,
			};
		});
	}

	/**
	 * Get top models by usage
	 * @param limit - Maximum number of models to return.
	 * @param sinceMs - When given, only requests after this timestamp (ms since
	 *   epoch) are counted; percentages are relative to that window.
	 */
	async getTopModels(
		limit = 5,
		sinceMs?: number,
	): Promise<Array<{ model: string; count: number; percentage: number }>> {
		const windowClause = sinceMs !== undefined ? "AND timestamp > ?" : "";
		const windowParams = sinceMs !== undefined ? [sinceMs] : [];
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
				WHERE model IS NOT NULL ${windowClause}
				GROUP BY model
			),
			total AS (
				SELECT SUM(count) as total FROM model_counts
			)
			SELECT
				mc.model,
				mc.count,
				ROUND(CAST(CAST(mc.count AS REAL) / CAST(t.total AS REAL) * 100 AS NUMERIC), 2) as percentage
			FROM model_counts mc, total t
			ORDER BY mc.count DESC
			LIMIT ?`,
			[...windowParams, limit],
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
		// Single GROUP BY pass: request count and success count together.
		const rawStats = await this.adapter.query<{
			id: string;
			name: string;
			requests: number;
			successful: unknown;
		}>(
			`SELECT
				api_key_id as id,
				api_key_name as name,
				COUNT(*) as requests,
				SUM(CASE WHEN success = TRUE THEN 1 ELSE 0 END) as successful
			FROM requests
			WHERE api_key_id IS NOT NULL
			GROUP BY api_key_id, api_key_name
			HAVING COUNT(*) > 0
			ORDER BY requests DESC`,
		);

		// Safety: only expose valid non-empty string ids
		const apiKeyStats = rawStats.filter(
			(a) => typeof a.id === "string" && a.id.length > 0 && a.id.length < 256,
		);
		if (apiKeyStats.length === 0) return [];

		// The success rate is per key id (across any renamed api_key_name rows),
		// so fold the per-(id, name) groups back together by id.
		const totals = new Map<string, { total: number; successful: number }>();
		for (const row of apiKeyStats) {
			const t = totals.get(row.id) ?? { total: 0, successful: 0 };
			t.total += Number(row.requests) || 0;
			t.successful += Number(row.successful) || 0;
			totals.set(row.id, t);
		}
		const successRateMap = new Map(
			[...totals].map(([id, t]) => [
				id,
				t.total > 0 ? Math.round((t.successful / t.total) * 100) : 0,
			]),
		);

		// Combine the data
		return apiKeyStats.map((key) => ({
			id: key.id,
			name: key.name,
			// Bun.SQL returns COUNT(*) as a JavaScript string on PostgreSQL
			// (BIGINT is stringified, see Bun#22188). The companion
			// successRateMap already coerces with Number(); requests needs the
			// same treatment so `toBe(2)` assertions hold on both dialects.
			requests: Number(key.requests) || 0,
			successRate: successRateMap.get(key.id) || 0,
		}));
	}

	/**
	 * Get aggregated token stats for each account's current session window.
	 * Only accounts with a non-null session_start are included.
	 * Returns a Map keyed by account ID.
	 */
	async getSessionStats(
		accounts: Array<{ id: string; session_start: number | null }>,
	): Promise<Map<string, SessionStats>> {
		const active = accounts.filter((a) => a.session_start !== null) as Array<{
			id: string;
			session_start: number;
		}>;

		if (active.length === 0) return new Map();

		// Build a WHERE clause: (account_used = ? AND timestamp >= ?) OR ...
		const clauses = active
			.map(() => "(account_used = ? AND timestamp >= ?)")
			.join(" OR ");
		const params: (string | number)[] = active.flatMap((a) => [
			a.id,
			a.session_start,
		]);

		const rows = await this.adapter.query<{
			account_used: string;
			requests: unknown;
			input_tokens: unknown;
			cache_creation_input_tokens: unknown;
			cache_read_input_tokens: unknown;
			output_tokens: unknown;
			plan_cost_usd: unknown;
			api_cost_usd: unknown;
		}>(
			`SELECT
				account_used,
				COUNT(*) as requests,
				COALESCE(SUM(input_tokens), 0) as input_tokens,
				COALESCE(SUM(cache_creation_input_tokens), 0) as cache_creation_input_tokens,
				COALESCE(SUM(cache_read_input_tokens), 0) as cache_read_input_tokens,
				COALESCE(SUM(output_tokens), 0) as output_tokens,
				COALESCE(SUM(CASE WHEN billing_type = 'plan' THEN cost_usd ELSE 0 END), 0) as plan_cost_usd,
				COALESCE(SUM(CASE WHEN billing_type != 'plan' OR billing_type IS NULL THEN cost_usd ELSE 0 END), 0) as api_cost_usd
			FROM requests
			WHERE ${clauses}
			GROUP BY account_used`,
			params,
		);

		return new Map(
			rows.map((row) => [
				row.account_used,
				{
					requests: Number(row.requests) || 0,
					inputTokens: Number(row.input_tokens) || 0,
					cacheCreationInputTokens:
						Number(row.cache_creation_input_tokens) || 0,
					cacheReadInputTokens: Number(row.cache_read_input_tokens) || 0,
					outputTokens: Number(row.output_tokens) || 0,
					planCostUsd: Number(row.plan_cost_usd) || 0,
					apiCostUsd: Number(row.api_cost_usd) || 0,
				},
			]),
		);
	}
}
