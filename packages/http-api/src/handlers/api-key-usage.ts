// packages/http-api/src/handlers/api-key-usage.ts
import { getModelRates } from "@better-ccflare/core";
import {
	errorResponse,
	InternalServerError,
	jsonResponse,
	NotFound,
} from "@better-ccflare/http-common";
import { Logger } from "@better-ccflare/logger";
import {
	type ApiKeyUsageAccountRow,
	type ApiKeyUsageModelRow,
	type ApiKeyUsageResponse,
	type ApiKeyUsageSeriesPoint,
	toApiKeyResponse,
} from "@better-ccflare/types";
import {
	computeEfficiency,
	computePlanCost,
	type PlanAccountUsage,
} from "../services/api-key-usage";
import type { APIContext } from "../types";
import { getRangeConfig } from "../utils/query-filters";
import { withSpendUsage } from "./api-keys";

const log = new Logger("ApiKeyUsageHandler");

/**
 * The plan / api split, spelled the ONLY correct way.
 *
 * `billing_type != 'plan'` is NULL for a NULL row, and a NULL predicate is not
 * true, so a legacy row with no billing_type falls out of BOTH buckets and its
 * cost silently disappears. Every SUM below therefore says
 * `(billing_type != 'plan' OR billing_type IS NULL)` for the API bucket, the
 * same way stats.repository.ts does.
 *
 * The older analytics queries still have the naive form. Repairing those is
 * deliberately out of scope here — writing new code correctly is not the same
 * change as fixing old code, and the two must not be mixed in one commit.
 */
const API_COST_SUM =
	"SUM(CASE WHEN r.billing_type != 'plan' OR r.billing_type IS NULL THEN COALESCE(r.cost_usd, 0) ELSE 0 END)";
const PLAN_VALUE_SUM =
	"SUM(CASE WHEN r.billing_type = 'plan' THEN COALESCE(r.cost_usd, 0) ELSE 0 END)";

/** PostgreSQL hands BIGINT and NUMERIC back as strings; every read goes through this. */
function num(value: unknown): number {
	const parsed = Number(value);
	return Number.isFinite(parsed) ? parsed : 0;
}

interface TotalsSqlRow {
	requests: number | string | null;
	successful: number | string | null;
	input_tokens: number | string | null;
	output_tokens: number | string | null;
	cache_read_input_tokens: number | string | null;
	cache_creation_input_tokens: number | string | null;
	total_tokens: number | string | null;
	plan_value_usd: number | string | null;
	api_cost_usd: number | string | null;
}

interface ModelSqlRow {
	model: string | null;
	requests: number | string | null;
	cost_usd: number | string | null;
	total_tokens: number | string | null;
}

interface AccountSqlRow {
	account_id: string | null;
	account_name: string | null;
	requests: number | string | null;
	cost_usd: number | string | null;
	plan_value_usd: number | string | null;
	plan_monthly_usd: number | string | null;
}

interface AccountPlanTotalSqlRow {
	account_id: string | null;
	plan_value_usd: number | string | null;
}

interface SeriesSqlRow {
	bucket: number | string | null;
	requests: number | string | null;
	api_cost_usd: number | string | null;
	plan_value_usd: number | string | null;
}

/**
 * Bucket widths this endpoint will inline into SQL, keyed by the value
 * getRangeConfig hands back.
 *
 * The bucket size is written into the statement as an integer LITERAL rather
 * than bound, because it is the divisor of the time-bucket expression and that
 * expression appears in both SELECT and GROUP BY. A bind placeholder there is
 * exactly the shape that 500'd /api/stats on PostgreSQL (two `?` renumbered to
 * two different $N, two different parse trees, SQLSTATE 42803) and the static
 * scanner in pg-live-queries.test.ts rejects it outright.
 *
 * Inlining is safe ONLY because the value can never come from the request: it
 * is looked up in this frozen table and re-checked as a positive integer below.
 */
const BUCKET_MS_BY_RANGE: Readonly<Record<string, number>> = Object.freeze({
	"1h": 60_000,
	"6h": 5 * 60_000,
	"24h": 60 * 60_000,
	"7d": 60 * 60_000,
	"30d": 24 * 60 * 60_000,
});

/** Integer division on both dialects: `timestamp` is INTEGER/BIGINT everywhere. */
function bucketExpression(bucketMs: number): string {
	if (!Number.isSafeInteger(bucketMs) || bucketMs <= 0) {
		// Unreachable via the frozen table above; a guard so a future edit
		// cannot smuggle a non-integer into the statement text.
		throw new Error(`Invalid bucket size: ${bucketMs}`);
	}
	return `(r.timestamp / ${bucketMs}) * ${bucketMs}`;
}

/**
 * GET /api/api-keys/:idOrName/usage?range=<1h|6h|24h|7d|30d>
 *
 * Everything the per-key monitoring page shows, for one key over one window.
 *
 * Filters on `api_key_id`, never on `api_key_name`. The two partial indexes
 * (idx_requests_api_key, idx_requests_api_key_timestamp) are on the id column,
 * so filtering by name — which is what the shared buildRequestFilters helper
 * does for the analytics endpoints — cannot use either and degrades to a scan
 * of the whole requests table. That helper's behaviour is deliberately left
 * alone; this endpoint just does not use it.
 *
 * Reading is not admin-gated, matching the sibling GET /api/api-keys.
 */
export function createApiKeyUsageHandler(context: APIContext) {
	return async (
		keyIdOrName: string,
		searchParams: URLSearchParams,
	): Promise<Response> => {
		const dbOps = context.dbOps;
		const db = dbOps.getAdapter();

		// getRangeConfig normalizes an unknown range to 24h and reports the
		// effective value, so the window bounds and the echoed range agree.
		const { startMs, range } = getRangeConfig(
			searchParams.get("range") ?? "24h",
		);
		// Window bounds are computed HERE, in JavaScript, as epoch-ms. No SQL
		// date/time function appears in any statement below: SQLite's
		// strftime/julianday and PostgreSQL's date_trunc/now() share neither
		// spelling nor semantics, and the repo stores every timestamp as a
		// plain integer precisely so neither is ever needed.
		const endMs = Date.now();
		const windowMs = Math.max(0, endMs - startMs);

		try {
			const apiKey =
				(await dbOps.getApiKey(keyIdOrName)) ??
				(await dbOps.getApiKeyByName(keyIdOrName));
			if (!apiKey) {
				return errorResponse(NotFound(`API key '${keyIdOrName}' not found`));
			}

			const keyId = apiKey.id;
			const bucketMs = BUCKET_MS_BY_RANGE[range] ?? 60 * 60_000;

			// -- Totals -----------------------------------------------------
			// Params are spread once per `${…}`-free statement, in textual
			// order: api_key_id then timestamp, matching the WHERE clause.
			const totalsRow = await db.get<TotalsSqlRow>(
				`
				SELECT
					COUNT(*) as requests,
					SUM(CASE WHEN r.success = TRUE THEN 1 ELSE 0 END) as successful,
					SUM(COALESCE(r.input_tokens, 0)) as input_tokens,
					SUM(COALESCE(r.output_tokens, 0)) as output_tokens,
					SUM(COALESCE(r.cache_read_input_tokens, 0)) as cache_read_input_tokens,
					SUM(COALESCE(r.cache_creation_input_tokens, 0)) as cache_creation_input_tokens,
					SUM(COALESCE(r.total_tokens, 0)) as total_tokens,
					${PLAN_VALUE_SUM} as plan_value_usd,
					${API_COST_SUM} as api_cost_usd
				FROM requests r
				WHERE r.api_key_id = ? AND r.timestamp > ?
			`,
				[keyId, startMs],
			);

			const requests = num(totalsRow?.requests);
			const successfulRequests = num(totalsRow?.successful);
			const planValueUsd = num(totalsRow?.plan_value_usd);
			const apiCostUsd = num(totalsRow?.api_cost_usd);

			// -- Per-model --------------------------------------------------
			// GROUP BY holds a column reference, never a placeholder. A NULL
			// model groups into its own row and is reported as `model: null`;
			// one real key on live data has thousands of such requests with no
			// model and no tokens, so this is the ordinary case, not an edge.
			const modelRows = await db.query<ModelSqlRow>(
				`
				SELECT
					r.model as model,
					COUNT(*) as requests,
					SUM(COALESCE(r.cost_usd, 0)) as cost_usd,
					SUM(COALESCE(r.total_tokens, 0)) as total_tokens
				FROM requests r
				WHERE r.api_key_id = ? AND r.timestamp > ?
				GROUP BY r.model
			`,
				[keyId, startMs],
			);

			// -- Per-account, plus this key's plan value on each --------------
			const accountRows = await db.query<AccountSqlRow>(
				`
				SELECT
					r.account_used as account_id,
					a.name as account_name,
					COUNT(*) as requests,
					SUM(COALESCE(r.cost_usd, 0)) as cost_usd,
					${PLAN_VALUE_SUM} as plan_value_usd,
					MAX(a.plan_monthly_usd) as plan_monthly_usd
				FROM requests r
				LEFT JOIN accounts a ON a.id = r.account_used
				WHERE r.api_key_id = ? AND r.timestamp > ?
				GROUP BY r.account_used, a.name
			`,
				[keyId, startMs],
			);

			// -- Apportionment denominator: ALL keys' plan value per account --
			// Only the accounts this key actually sent plan traffic to. An
			// account with no plan traffic from this key cannot receive a
			// contribution, so asking about it would be work for nothing.
			const planAccountIds = accountRows
				.filter((row) => row.account_id != null && num(row.plan_value_usd) > 0)
				.map((row) => row.account_id as string);

			const accountPlanTotals = new Map<string, number>();
			if (planAccountIds.length > 0) {
				// The IN list is built in TypeScript for ARITY ONLY — one `?`
				// per id, never a bound parameter on the left of IN, which
				// PostgreSQL rejects at Parse time with SQLSTATE 42P18.
				const placeholders = planAccountIds.map(() => "?").join(",");
				const totals = await db.query<AccountPlanTotalSqlRow>(
					`
					SELECT
						r.account_used as account_id,
						${PLAN_VALUE_SUM} as plan_value_usd
					FROM requests r
					WHERE r.timestamp > ? AND r.account_used IN (${placeholders})
					GROUP BY r.account_used
				`,
					[startMs, ...planAccountIds],
				);
				for (const row of totals) {
					if (row.account_id != null) {
						accountPlanTotals.set(row.account_id, num(row.plan_value_usd));
					}
				}
			}

			// -- Time series --------------------------------------------------
			// GROUP BY / ORDER BY use the output ordinal, so the bucket
			// expression is written once and PostgreSQL compares one parse
			// tree against itself.
			const bucketExpr = bucketExpression(bucketMs);
			const seriesRows = await db.query<SeriesSqlRow>(
				`
				SELECT
					${bucketExpr} as bucket,
					COUNT(*) as requests,
					${API_COST_SUM} as api_cost_usd,
					${PLAN_VALUE_SUM} as plan_value_usd
				FROM requests r
				WHERE r.api_key_id = ? AND r.timestamp > ?
				GROUP BY 1
				ORDER BY 1
			`,
				[keyId, startMs],
			);

			// -- Apportionment ------------------------------------------------
			const planAccounts: PlanAccountUsage[] = accountRows
				.filter((row) => row.account_id != null && num(row.plan_value_usd) > 0)
				.map((row) => {
					const accountId = row.account_id as string;
					const keyPlanValueUsd = num(row.plan_value_usd);
					// NULLIF(…, 0) has no meaning for a map miss; a missing
					// total falls back to this key's own value, which makes the
					// share exactly 1 — the only defensible reading of "this
					// key is all the plan traffic we can see on that account".
					const accountPlanValueUsd =
						accountPlanTotals.get(accountId) ?? keyPlanValueUsd;
					return {
						accountId,
						accountName: row.account_name,
						keyPlanValueUsd,
						accountPlanValueUsd,
						planMonthlyUsd:
							row.plan_monthly_usd == null ? null : num(row.plan_monthly_usd),
					};
				});

			const planCost = computePlanCost(planAccounts, windowMs);
			const { efficiencyRatio, efficiencyStatus } = computeEfficiency(planCost);

			// -- Unknown pricing disclosure -------------------------------------
			// The NON-throwing getModelRates: it returns null for a model the
			// catalogue has no rates for, where the throwing sibling would
			// either explode or silently price at $0. Models listed here moved
			// real tokens that every cost figure above counts as free.
			const modelIds = [
				...new Set(
					modelRows
						.map((row) => row.model)
						.filter((model): model is string => model != null && model !== ""),
				),
			];
			const rateList = await Promise.all(
				modelIds.map((modelId) => getModelRates(modelId)),
			);
			const unknownPricingModels = modelIds
				.filter((_, index) => rateList[index] == null)
				.sort();

			// -- Live limit state ------------------------------------------------
			// Through the SAME helper the list endpoint uses, reading the SAME
			// in-memory counter the proxy enforces against, so this page and a
			// refusal can never disagree about what a key has spent.
			const [keyResponse] = await withSpendUsage(dbOps, [
				toApiKeyResponse(apiKey),
			]);

			const models: ApiKeyUsageModelRow[] = modelRows
				.map((row) => ({
					model: row.model,
					requests: num(row.requests),
					costUsd: num(row.cost_usd),
					totalTokens: num(row.total_tokens),
				}))
				.sort((a, b) => b.costUsd - a.costUsd || b.requests - a.requests);

			const accounts: ApiKeyUsageAccountRow[] = accountRows
				.map((row) => ({
					accountId: row.account_id,
					accountName: row.account_name,
					requests: num(row.requests),
					costUsd: num(row.cost_usd),
				}))
				.sort((a, b) => b.costUsd - a.costUsd || b.requests - a.requests);

			const series: ApiKeyUsageSeriesPoint[] = seriesRows.map((row) => ({
				ts: num(row.bucket),
				requests: num(row.requests),
				apiCostUsd: num(row.api_cost_usd),
				planValueUsd: num(row.plan_value_usd),
			}));

			const response: ApiKeyUsageResponse = {
				apiKey: {
					id: keyResponse.id,
					name: keyResponse.name,
					isActive: keyResponse.isActive,
					role: keyResponse.role,
				},
				range,
				windowStartMs: startMs,
				windowEndMs: endMs,
				bucketMs,
				requests,
				successfulRequests,
				// NULLIF(…, 0) in JS: a key with no traffic reports 0%, not NaN.
				successRate: requests > 0 ? (successfulRequests * 100) / requests : 0,
				tokens: {
					inputTokens: num(totalsRow?.input_tokens),
					outputTokens: num(totalsRow?.output_tokens),
					cacheReadInputTokens: num(totalsRow?.cache_read_input_tokens),
					cacheCreationInputTokens: num(totalsRow?.cache_creation_input_tokens),
					totalTokens: num(totalsRow?.total_tokens),
				},
				apiCostUsd,
				planValueUsd,
				planCost,
				efficiencyRatio,
				efficiencyStatus,
				models,
				accounts,
				series,
				unknownPricingModels,
				limit: {
					limitUsd: keyResponse.limitUsd,
					limitWindow: keyResponse.limitWindow,
					limitEnforce: keyResponse.limitEnforce,
					spentUsd: keyResponse.spentUsd,
					windowResetsAt: keyResponse.windowResetsAt,
				},
				restrictions: {
					allowedAccounts: keyResponse.allowedAccounts,
					allowedModels: keyResponse.allowedModels,
					allowedProviders: keyResponse.allowedProviders,
				},
			};

			return jsonResponse(response);
		} catch (error) {
			// A NotFound raised above is returned directly, never thrown, so
			// anything reaching here is a genuine failure.
			log.error("API key usage error:", error);
			return errorResponse(
				InternalServerError("Failed to fetch API key usage"),
			);
		}
	};
}
