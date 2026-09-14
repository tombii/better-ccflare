import type {
	ApiKeyUsageEfficiencyStatus,
	ApiKeyUsagePlanAccountShare,
	ApiKeyUsagePlanCost,
} from "@better-ccflare/types";

/**
 * Pure apportionment maths for the per-API-key usage endpoint.
 *
 * No DB access and no pricing-engine imports: every input arrives as plain
 * data, exactly like cache-insights.ts. The response shapes live in
 * @better-ccflare/types and are re-exported here for convenience.
 */

export type {
	ApiKeyUsageEfficiencyStatus,
	ApiKeyUsagePlanAccountShare,
	ApiKeyUsagePlanCost,
} from "@better-ccflare/types";

/**
 * Subscription prices are quoted per month, and a month here is 30 days flat.
 *
 * Not a calendar month on purpose: the windows this endpoint offers are
 * rolling (1h … 30d) and never align to a calendar boundary, so prorating
 * against a length that changes with the date would make the same 24h of
 * traffic cost 3.5% more in February than in January for no reason the
 * operator could act on.
 */
export const PRORATION_DAYS = 30;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** One account's plan traffic, as measured for a single key over a window. */
export interface PlanAccountUsage {
	accountId: string;
	accountName: string | null;
	/** This key's plan-billed cost_usd on this account, at API rates. */
	keyPlanValueUsd: number;
	/** ALL keys' plan-billed cost_usd on this account, at API rates. */
	accountPlanValueUsd: number;
	/** accounts.plan_monthly_usd; null when the operator has not priced it. */
	planMonthlyUsd: number | null;
}

/** Prorate a monthly subscription price down to a window of `windowMs`. */
export function prorateMonthlyPrice(
	planMonthlyUsd: number,
	windowMs: number,
): number {
	return planMonthlyUsd * (windowMs / MS_PER_DAY / PRORATION_DAYS);
}

/**
 * A usable price is a finite, non-negative number.
 *
 * A negative or NaN plan_monthly_usd (hand-edited row, bad import) is treated
 * exactly like NULL — reported as unpriced rather than quietly subtracted
 * from the bill.
 */
function isUsablePrice(value: number | null | undefined): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

/**
 * Apportion real subscription money across one key's plan traffic.
 *
 * For each account this key sent plan traffic to, in the window:
 *
 *   share        = key's plan value on that account / all keys' plan value there
 *   prorated     = account.plan_monthly_usd * windowDays / 30
 *   contribution = share * prorated
 *
 * and the plan cost is the sum of the contributions.
 *
 * Two rules are load-bearing:
 *
 *  - An account with NO price contributes `null`, not 0, and its id lands in
 *    `unpricedAccountIds`. Folding it in as zero would report a subscription
 *    nobody priced as FREE, which is the single most misleading thing this
 *    endpoint could say.
 *  - The denominator is guarded rather than divided blindly. An account whose
 *    total plan value is 0 (or, impossibly, negative) yields share 0, not
 *    Infinity or NaN. This is the JS half of the `NULLIF(…, 0)` the SQL side
 *    uses for the same reason.
 */
export function computePlanCost(
	accounts: PlanAccountUsage[],
	windowMs: number,
): ApiKeyUsagePlanCost {
	const windowDays = windowMs / MS_PER_DAY;
	const shares: ApiKeyUsagePlanAccountShare[] = [];
	const unpricedAccountIds: string[] = [];
	let planCostUsd = 0;
	let pricedPlanValueUsd = 0;

	for (const account of accounts) {
		// Clamped to 1: a key cannot have spent more on an account than every
		// key together did, but a race between the two queries (one written
		// between them) could round the other way, and a share above 1 would
		// bill this key for traffic that is not its own.
		const share =
			account.accountPlanValueUsd > 0
				? Math.min(
						1,
						Math.max(0, account.keyPlanValueUsd / account.accountPlanValueUsd),
					)
				: 0;

		const priced = isUsablePrice(account.planMonthlyUsd);
		const proratedPriceUsd = priced
			? prorateMonthlyPrice(account.planMonthlyUsd as number, windowMs)
			: null;
		const contributionUsd =
			proratedPriceUsd !== null ? share * proratedPriceUsd : null;

		if (contributionUsd !== null) {
			planCostUsd += contributionUsd;
			pricedPlanValueUsd += account.keyPlanValueUsd;
		} else {
			unpricedAccountIds.push(account.accountId);
		}

		shares.push({
			accountId: account.accountId,
			accountName: account.accountName,
			keyPlanValueUsd: account.keyPlanValueUsd,
			accountPlanValueUsd: account.accountPlanValueUsd,
			share,
			planMonthlyUsd: priced ? (account.planMonthlyUsd as number) : null,
			proratedPriceUsd,
			contributionUsd,
		});
	}

	return {
		planCostUsd,
		pricedPlanValueUsd,
		accounts: shares,
		unpricedAccountIds,
		windowDays,
	};
}

/**
 * The headline: how many dollars of API-rate traffic each real subscription
 * dollar bought.
 *
 * Both sides are restricted to PRICED accounts. Dividing the whole plan value
 * by a denominator that excludes the unpriced accounts' cost would inflate the
 * number, and inflating the one figure the page exists to show is worse than
 * showing a smaller, true one plus a note about what is missing.
 *
 * Returns `null` whenever there is no denominator, so the page can say
 * "unavailable" instead of rendering Infinity or NaN.
 */
export function computeEfficiency(planCost: ApiKeyUsagePlanCost): {
	efficiencyRatio: number | null;
	efficiencyStatus: ApiKeyUsageEfficiencyStatus;
} {
	if (planCost.accounts.length === 0) {
		return { efficiencyRatio: null, efficiencyStatus: "no_plan_traffic" };
	}
	if (!(planCost.planCostUsd > 0)) {
		// Plan traffic exists but nothing priced it: every account is unpriced,
		// or every price is 0. Either way there is no denominator.
		return { efficiencyRatio: null, efficiencyStatus: "unpriced" };
	}
	return {
		efficiencyRatio: planCost.pricedPlanValueUsd / planCost.planCostUsd,
		efficiencyStatus: planCost.unpricedAccountIds.length > 0 ? "partial" : "ok",
	};
}
