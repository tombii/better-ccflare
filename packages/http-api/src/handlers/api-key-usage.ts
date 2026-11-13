// packages/http-api/src/handlers/api-key-usage.ts
import { getModelRates } from "@better-ccflare/core";
import {
	errorResponse,
	Forbidden,
	HttpError,
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
import { apiKeyUsageRange } from "../services/api-key-usage-range";
import type { AuthenticationResult } from "../services/auth-service";
import type { APIContext } from "../types";
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
	plan_requests: number | string | null;
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

/** Integer division on both dialects: `timestamp` is INTEGER/BIGINT everywhere. */
function bucketExpression(bucketMs: number): string {
	if (!Number.isSafeInteger(bucketMs) || bucketMs <= 0) {
		// Only fixed server-selected widths are used; guard so a future edit
		// cannot smuggle a non-integer into the statement text.
		throw new Error(`Invalid bucket size: ${bucketMs}`);
	}
	return `(r.timestamp / ${bucketMs}) * ${bucketMs}`;
}

/**
 * GET /api/api-keys/:idOrName/usage?range=<1h|24h|7d|30d|this_month|last_month|custom>
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
 * Admins may read every key; other keys may read only their own usage.
 */
export function createApiKeyUsageHandler(context: APIContext) {
	return async (
		keyIdOrName: string,
		searchParams: URLSearchParams,
		caller?: AuthenticationResult,
	): Promise<Response> => {
		const dbOps = context.dbOps;
		const db = dbOps.getAdapter();

		try {
			const { startMs, endMs, range, bucketMs } =
				apiKeyUsageRange(searchParams);
			const windowMs = endMs - startMs;
			const apiKey =
				(await dbOps.getApiKey(keyIdOrName)) ??
				(await dbOps.getApiKeyByName(keyIdOrName));
			if (!apiKey) {
				return errorResponse(NotFound(`API key '${keyIdOrName}' not found`));
			}

			if (
				caller?.apiKeyId &&
				caller.role !== "admin" &&
				caller.apiKeyId !== apiKey.id
			) {
				return errorResponse(
					Forbidden("API keys may only read their own usage"),
				);
			}
			const keyId = apiKey.id;

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
				WHERE r.api_key_id = ? AND r.timestamp >= ? AND r.timestamp < ?
			`,
				[keyId, startMs, endMs],
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
				WHERE r.api_key_id = ? AND r.timestamp >= ? AND r.timestamp < ?
				GROUP BY r.model
			`,
				[keyId, startMs, endMs],
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
					SUM(CASE WHEN r.billing_type = 'plan' THEN 1 ELSE 0 END) as plan_requests,
					MAX(a.plan_monthly_usd) as plan_monthly_usd
				FROM requests r
				LEFT JOIN accounts a ON a.id = r.account_used
				WHERE r.api_key_id = ? AND r.timestamp >= ? AND r.timestamp < ?
				GROUP BY r.account_used, a.name
			`,
				[keyId, startMs, endMs],
			);

			// -- Apportionment denominator: ALL keys' plan value per account --
			// Only the accounts this key actually sent plan traffic to. An
			// account with no plan traffic from this key cannot receive a
			// contribution, so asking about it would be work for nothing.
			const planAccountIds = accountRows
				.filter((row) => row.account_id != null && num(row.plan_requests) > 0)
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
					WHERE r.timestamp >= ? AND r.timestamp < ? AND r.account_used IN (${placeholders})
					GROUP BY r.account_used
				`,
					[startMs, endMs, ...planAccountIds],
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
				WHERE r.api_key_id = ? AND r.timestamp >= ? AND r.timestamp < ?
				GROUP BY 1
				ORDER BY 1
			`,
				[keyId, startMs, endMs],
			);

			// -- Apportionment ------------------------------------------------
			const planAccounts: PlanAccountUsage[] = accountRows
				.filter((row) => row.account_id != null && num(row.plan_requests) > 0)
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

			const planCost = computePlanCost(planAccounts, windowMs, startMs);
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
				canManage: !caller?.apiKeyId || caller.role === "admin",
				limitWindowMode: keyResponse.limitWindowMode ?? "calendar",
				familyComboOverrides: keyResponse.familyComboOverrides ?? null,
				limits: keyResponse.limits ?? [],
				totalCostUsd: apiCostUsd + planValueUsd,
				apiKey: {
					spendResetAt: keyResponse.spendResetAt ?? null,
					spendResetBy: keyResponse.spendResetBy ?? null,
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

			if (!response.canManage) {
				// Account labels are local to this response. Plan apportionment
				// inputs (including share) reveal other keys' totals, so retain
				// only this key's aggregate plan-cost contribution.
				const labels = new Map<string, string>();
				const label = (id: string) => {
					if (!labels.has(id)) labels.set(id, `Account ${labels.size + 1}`);
					return labels.get(id) as string;
				};
				response.accounts = response.accounts.map((account) => ({
					...account,
					accountId:
						account.accountId == null ? null : label(account.accountId),
					accountName:
						account.accountId == null
							? "Unattributed"
							: label(account.accountId),
				}));
				response.restrictions.allowedAccounts =
					response.restrictions.allowedAccounts?.map(label) ?? null;
				response.planCost = {
					...response.planCost,
					accounts: [],
					unpricedAccountIds: [],
				};
			}
			return jsonResponse(response);
		} catch (error) {
			if (error instanceof HttpError) return errorResponse(error);
			// A NotFound raised above is returned directly, never thrown, so
			// anything reaching here is a genuine failure.
			log.error("API key usage error:", error);
			return errorResponse(
				InternalServerError("Failed to fetch API key usage"),
			);
		}
	};
}
