// packages/types/src/api-key-usage.ts
import type {
	ApiKeyLimitEnforcement,
	ApiKeyLimitStatus,
	ApiKeyLimitWindowMode,
	ApiKeyRestrictions,
	ApiKeyRole,
	ApiKeySpendWindow,
} from "./api-key";

/**
 * Shapes for GET /api/api-keys/:idOrName/usage — the per-key monitoring page.
 *
 * Shared by the handler and the dashboard, the same way UsageHistoryResponse
 * is, so the page can never drift from what the endpoint actually returns.
 *
 * THE COST MODEL, once, here, because every field below only makes sense
 * against it. Every request in this codebase is priced at public
 * pay-per-token rates regardless of how the account is actually billed, and
 * `requests.billing_type` then labels the row 'plan', 'api' or 'overage'. So:
 *
 *  - `apiCostUsd` is real money: rows whose billing_type is NOT 'plan'.
 *  - `planValueUsd` is a COUNTERFACTUAL: what this key's subscription traffic
 *    WOULD have cost at API rates. The dashboard has always called this
 *    quantity "Plan Value" rather than "Plan Cost", and this field keeps that
 *    honesty — it is not money anybody was charged.
 *  - `planCost` is the apportioned share of the real subscription money, from
 *    `accounts.plan_monthly_usd`. That IS money, and it is the only figure
 *    here that is.
 *
 * NULL `billing_type` counts toward `apiCostUsd`, never toward `planValueUsd`
 * and never into neither bucket: `billing_type != 'plan'` is NULL for a NULL
 * row, so the queries behind this spell it `(… != 'plan' OR … IS NULL)`.
 */

/** One account this key sent plan-billed traffic to, and its apportionment. */
export interface ApiKeyUsagePlanAccountShare {
	accountId: string;
	/** NULL when the account row is gone but its requests remain. */
	accountName: string | null;
	/** This key's plan-billed cost_usd on this account, at API rates. */
	keyPlanValueUsd: number;
	/** ALL keys' plan-billed cost_usd on this account, at API rates. */
	accountPlanValueUsd: number;
	/** keyPlanValueUsd / accountPlanValueUsd, clamped to 0–1. */
	share: number;
	/** accounts.plan_monthly_usd. null = the operator has not priced this plan. */
	planMonthlyUsd: number | null;
	/** planMonthlyUsd prorated to the selected window. null when unpriced. */
	proratedPriceUsd: number | null;
	/** share * proratedPriceUsd. null when unpriced — NEVER 0, which would read as free. */
	contributionUsd: number | null;
}

/** The apportioned real cost of this key's plan traffic over the window. */
export interface ApiKeyUsagePlanCost {
	/** Sum of the priced contributions. Accounts with no price add nothing here. */
	planCostUsd: number;
	/**
	 * The share of `planValueUsd` that came from PRICED accounts only.
	 *
	 * This is the numerator of `efficiencyRatio`: dividing the whole plan value
	 * by a denominator that excludes unpriced accounts would overstate the
	 * ratio, so both sides are restricted to the accounts that have a price.
	 */
	pricedPlanValueUsd: number;
	/** Every account with plan traffic in the window, priced and unpriced alike. */
	accounts: ApiKeyUsagePlanAccountShare[];
	/** Account ids carrying plan traffic with no plan_monthly_usd set. */
	unpricedAccountIds: string[];
	/** Elapsed window length in days; prices use each Dublin calendar month's duration. */
	windowDays: number;
}

/**
 * Why the efficiency ratio is what it is.
 *
 *  - `ok`         — every account with plan traffic is priced.
 *  - `partial`    — some are, some are not; the ratio covers the priced ones.
 *  - `unpriced`   — there is plan traffic but no priced account: no denominator.
 *  - `no_plan_traffic` — this key sent no plan-billed requests at all.
 */
export type ApiKeyUsageEfficiencyStatus =
	| "ok"
	| "partial"
	| "unpriced"
	| "no_plan_traffic";

export interface ApiKeyUsageTokenTotals {
	inputTokens: number;
	outputTokens: number;
	cacheReadInputTokens: number;
	cacheCreationInputTokens: number;
	/** requests.total_tokens, which is NOT the sum of the four above. */
	totalTokens: number;
}

export interface ApiKeyUsageModelRow {
	/** null for rows recorded without a model — a real and common case. */
	model: string | null;
	requests: number;
	costUsd: number;
	totalTokens: number;
}

export interface ApiKeyUsageAccountRow {
	failedAttempts?: number;
	/** null for unattributed requests. */
	accountId: string | null;
	accountName: string | null;
	requests: number;
	costUsd: number;
}

/** One time bucket of the chart series. `ts` is the bucket START, ms epoch. */
export interface ApiKeyUsageSeriesPoint {
	ts: number;
	requests: number;
	apiCostUsd: number;
	planValueUsd: number;
}

/** The key's own limit state, echoed so the page needs no second round trip. */
export interface ApiKeyUsageLimitState {
	limitUsd: number | null;
	limitWindow: ApiKeySpendWindow | null;
	limitEnforce: ApiKeyLimitEnforcement | null;
	/** Live spend from the counter the proxy enforces against. Absent = unknown. */
	spentUsd?: number;
	reservedUsd?: number;
	windowResetsAt?: string | null;
}

export interface ApiKeyUsageResponse {
	/** Independent request rows cannot be correlated safely; compatibility counts are attempts. */
	metricUnit?: "attempts";
	failedAttempts?: number;
	/** Failovers reported by successful terminal attempts only; failed ordinal rows are excluded. */
	failoverAttempts?: number;
	/** Successful outcomes explicitly reporting a prior failover. */
	recoveredRequests?: number;
	/** Whether this caller can edit the key's limits, restrictions and routing. */
	canManage: boolean;
	limitWindowMode: ApiKeyLimitWindowMode;
	familyComboOverrides: Record<string, string> | null;
	limits: ApiKeyLimitStatus[];
	apiKey: {
		spendResetAt?: number | null;
		spendResetBy?: string | null;
		id: string;
		name: string;
		isActive: boolean;
		role: ApiKeyRole;
	};
	/** The effective range; unknown inputs normalize to 24h. */
	range: string;
	windowStartMs: number;
	windowEndMs: number;
	/** Series bucket width in ms, so the chart can label its axis. */
	bucketMs: number;

	requests: number;
	successfulRequests: number;
	/** 0–100. 0 when there were no requests at all. */
	successRate: number;
	tokens: ApiKeyUsageTokenTotals;

	/** Real money, at API rates: billing_type is NOT 'plan' (NULL included). */
	apiCostUsd: number;
	/** Counterfactual: what the plan traffic WOULD have cost at API rates. */
	planValueUsd: number;
	/** All traffic priced at pay-per-token rates, the basis for key limits. */
	totalCostUsd: number;
	planCost: ApiKeyUsagePlanCost;

	/**
	 * pricedPlanValueUsd / planCostUsd — how many dollars of API-rate traffic
	 * each real subscription dollar bought. null when there is no denominator;
	 * the page renders that as "unavailable", never as Infinity.
	 */
	efficiencyRatio: number | null;
	efficiencyStatus: ApiKeyUsageEfficiencyStatus;

	models: ApiKeyUsageModelRow[];
	accounts: ApiKeyUsageAccountRow[];
	series: ApiKeyUsageSeriesPoint[];

	/**
	 * Models this key used that the pricing catalogue has no rates for. Their
	 * traffic is silently priced at $0 upstream, so every cost figure above
	 * UNDERSTATES by whatever these models moved. Surfaced the same way
	 * CacheInsightsTotals.unknownPricingModels is.
	 */
	unknownPricingModels: string[];

	limit: ApiKeyUsageLimitState;
	restrictions: ApiKeyRestrictions;
}
