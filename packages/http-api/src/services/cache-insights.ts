import type { ModelRates } from "@better-ccflare/core";
import type {
	CacheInsightsResponse,
	CacheInsightsRow,
} from "@better-ccflare/types";

/**
 * Pure cache-savings math for the cache insights endpoint.
 *
 * No DB access and no pricing-engine imports: model rates ($ per 1M tokens)
 * are injected as plain data. The response shapes live in
 * @better-ccflare/types and are re-exported here for convenience.
 */

export type {
	CacheInsightsMeta,
	CacheInsightsResponse,
	CacheInsightsRow,
	CacheInsightsTotals,
} from "@better-ccflare/types";

/** Token sums for a group of requests. */
export interface TokenSums {
	requests: number;
	uncachedInputTokens: number;
	cacheReadInputTokens: number;
	cacheCreationInputTokens: number;
}

/**
 * Token sums grouped by (dimensionKey, model), e.g. (account, model) or
 * (project, model). A null/empty dimensionKey or model is reported under
 * the key "Unknown".
 */
export interface GroupedTokenRow extends TokenSums {
	dimensionKey: string | null;
	model: string | null;
}

/** Cache cost breakdown in dollars for a single model's token volume. */
export interface CacheCostBreakdown {
	actualCacheCostUsd: number;
	counterfactualCostUsd: number;
	savingsUsd: number;
}

export interface CacheInsightsOptions {
	range: string;
	/** Hit-rate percentage below which a row is flagged. Default 50. */
	thresholdPercent?: number;
	/** Minimum requests before a row can be flagged. Default 10. */
	minRequestsForFlag?: number;
}

export interface BuildCacheInsightsInput {
	/** Token sums grouped by (account, model). Also the source for byModel and totals. */
	accountModelRows: GroupedTokenRow[];
	/** Token sums grouped by (project, model). */
	projectModelRows: GroupedTokenRow[];
	/** Rates per model id ($ per 1M tokens); null for unknown models. */
	rates: Map<string, ModelRates | null>;
	options: CacheInsightsOptions;
}

export const DEFAULT_THRESHOLD_PERCENT = 50;
export const DEFAULT_MIN_REQUESTS_FOR_FLAG = 10;

const UNKNOWN_KEY = "Unknown";
const TOKENS_PER_MILLION = 1_000_000;

/**
 * Cache hit rate (0-100): cache_read * 100 / (uncached + cache_read + cache_creation).
 * Returns 0 when the denominator is 0. Matches the analytics.ts SQL definition.
 */
export function computeCacheHitRate(sums: TokenSums): number {
	const denominator =
		sums.uncachedInputTokens +
		sums.cacheReadInputTokens +
		sums.cacheCreationInputTokens;
	if (denominator === 0) return 0;
	return (sums.cacheReadInputTokens * 100) / denominator;
}

/**
 * Compute cache cost breakdown in dollars for one model's token volume.
 *
 * - actual = cacheRead * r.cacheRead/1M + cacheCreation * r.cacheWrite/1M
 * - counterfactual = (cacheRead + cacheCreation) * r.input/1M
 * - savings = counterfactual - actual (cacheWrite > input, so cache_creation
 *   contributes NEGATIVE savings — intended)
 *
 * Returns null when the rates are unusable: rates are null (unknown model),
 * or the cacheRead/cacheWrite rate is null while the corresponding token
 * volume is > 0. A null rate with zero corresponding tokens is irrelevant.
 */
export function computeCacheCosts(
	sums: TokenSums,
	rates: ModelRates | null | undefined,
): CacheCostBreakdown | null {
	if (!rates) return null;
	if (sums.cacheReadInputTokens > 0 && rates.cacheRead === null) return null;
	if (sums.cacheCreationInputTokens > 0 && rates.cacheWrite === null) {
		return null;
	}

	const actualCacheCostUsd =
		(sums.cacheReadInputTokens * (rates.cacheRead ?? 0)) / TOKENS_PER_MILLION +
		(sums.cacheCreationInputTokens * (rates.cacheWrite ?? 0)) /
			TOKENS_PER_MILLION;
	const counterfactualCostUsd =
		((sums.cacheReadInputTokens + sums.cacheCreationInputTokens) *
			rates.input) /
		TOKENS_PER_MILLION;
	return {
		actualCacheCostUsd,
		counterfactualCostUsd,
		savingsUsd: counterfactualCostUsd - actualCacheCostUsd,
	};
}

function normalizeKey(key: string | null | undefined): string {
	return key == null || key === "" ? UNKNOWN_KEY : key;
}

interface RowAccumulator {
	key: string;
	requests: number;
	uncachedInputTokens: number;
	cacheReadInputTokens: number;
	cacheCreationInputTokens: number;
	actualCacheCostUsd: number;
	counterfactualCostUsd: number;
	pricingKnown: boolean;
}

/**
 * Look up rates for a (possibly null/empty) model id. Unknown-keyed models
 * never have usable rates.
 */
function ratesForModel(
	model: string | null,
	rates: Map<string, ModelRates | null>,
): ModelRates | null {
	const key = normalizeKey(model);
	if (key === UNKNOWN_KEY) return null;
	return rates.get(key) ?? null;
}

/**
 * Aggregate grouped rows into CacheInsightsRows keyed by `keyOf(row)`.
 * A row is pricingKnown only if every constituent model portion had usable
 * rates; otherwise its cost fields are null.
 */
function aggregateRows(
	rows: GroupedTokenRow[],
	keyOf: (row: GroupedTokenRow) => string,
	rates: Map<string, ModelRates | null>,
	thresholdPercent: number,
	minRequestsForFlag: number,
): CacheInsightsRow[] {
	const groups = new Map<string, RowAccumulator>();
	for (const row of rows) {
		const key = keyOf(row);
		let acc = groups.get(key);
		if (!acc) {
			acc = {
				key,
				requests: 0,
				uncachedInputTokens: 0,
				cacheReadInputTokens: 0,
				cacheCreationInputTokens: 0,
				actualCacheCostUsd: 0,
				counterfactualCostUsd: 0,
				pricingKnown: true,
			};
			groups.set(key, acc);
		}
		acc.requests += row.requests;
		acc.uncachedInputTokens += row.uncachedInputTokens;
		acc.cacheReadInputTokens += row.cacheReadInputTokens;
		acc.cacheCreationInputTokens += row.cacheCreationInputTokens;

		const costs = computeCacheCosts(row, ratesForModel(row.model, rates));
		if (costs === null) {
			acc.pricingKnown = false;
		} else {
			acc.actualCacheCostUsd += costs.actualCacheCostUsd;
			acc.counterfactualCostUsd += costs.counterfactualCostUsd;
		}
	}

	const result: CacheInsightsRow[] = [];
	for (const acc of groups.values()) {
		const cacheHitRate = computeCacheHitRate(acc);
		const actualCacheCostUsd = acc.pricingKnown ? acc.actualCacheCostUsd : null;
		const counterfactualCostUsd = acc.pricingKnown
			? acc.counterfactualCostUsd
			: null;
		result.push({
			key: acc.key,
			requests: acc.requests,
			uncachedInputTokens: acc.uncachedInputTokens,
			cacheReadInputTokens: acc.cacheReadInputTokens,
			cacheCreationInputTokens: acc.cacheCreationInputTokens,
			cacheHitRate,
			actualCacheCostUsd,
			counterfactualCostUsd,
			savingsUsd:
				counterfactualCostUsd !== null && actualCacheCostUsd !== null
					? counterfactualCostUsd - actualCacheCostUsd
					: null,
			pricingKnown: acc.pricingKnown,
			flagged:
				cacheHitRate < thresholdPercent && acc.requests >= minRequestsForFlag,
		});
	}
	return sortRows(result);
}

/** Sort by savingsUsd descending with nulls last; tie-break by key ascending. */
function sortRows(rows: CacheInsightsRow[]): CacheInsightsRow[] {
	return rows.sort((a, b) => {
		if (a.savingsUsd === null && b.savingsUsd !== null) return 1;
		if (a.savingsUsd !== null && b.savingsUsd === null) return -1;
		if (
			a.savingsUsd !== null &&
			b.savingsUsd !== null &&
			a.savingsUsd !== b.savingsUsd
		) {
			return b.savingsUsd - a.savingsUsd;
		}
		return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
	});
}

/**
 * Assemble the full cache insights response from grouped token sums and
 * injected model rates.
 *
 * - byAccount / byProject aggregate the respective input rows per dimension key.
 * - byModel is derived by re-aggregating accountModelRows per model.
 * - totals: token sums over ALL account/model rows; cost sums over
 *   pricing-known volume only; unknownPricingModels lists distinct model ids
 *   (sorted) whose rates were unusable for any input row.
 */
export function buildCacheInsightsResponse(
	input: BuildCacheInsightsInput,
): CacheInsightsResponse {
	const thresholdPercent =
		input.options.thresholdPercent ?? DEFAULT_THRESHOLD_PERCENT;
	const minRequestsForFlag =
		input.options.minRequestsForFlag ?? DEFAULT_MIN_REQUESTS_FOR_FLAG;

	const byAccount = aggregateRows(
		input.accountModelRows,
		(row) => normalizeKey(row.dimensionKey),
		input.rates,
		thresholdPercent,
		minRequestsForFlag,
	);
	const byProject = aggregateRows(
		input.projectModelRows,
		(row) => normalizeKey(row.dimensionKey),
		input.rates,
		thresholdPercent,
		minRequestsForFlag,
	);
	const byModel = aggregateRows(
		input.accountModelRows,
		(row) => normalizeKey(row.model),
		input.rates,
		thresholdPercent,
		minRequestsForFlag,
	);

	const totals = {
		requests: 0,
		uncachedInputTokens: 0,
		cacheReadInputTokens: 0,
		cacheCreationInputTokens: 0,
		cacheHitRate: 0,
		actualCacheCostUsd: 0,
		counterfactualCostUsd: 0,
		savingsUsd: 0,
		unknownPricingModels: [] as string[],
	};
	const unknownModels = new Set<string>();
	const collectUnknown = (rows: GroupedTokenRow[]) => {
		for (const row of rows) {
			if (
				computeCacheCosts(row, ratesForModel(row.model, input.rates)) === null
			) {
				unknownModels.add(normalizeKey(row.model));
			}
		}
	};
	collectUnknown(input.accountModelRows);
	collectUnknown(input.projectModelRows);

	for (const row of input.accountModelRows) {
		totals.requests += row.requests;
		totals.uncachedInputTokens += row.uncachedInputTokens;
		totals.cacheReadInputTokens += row.cacheReadInputTokens;
		totals.cacheCreationInputTokens += row.cacheCreationInputTokens;
		const costs = computeCacheCosts(row, ratesForModel(row.model, input.rates));
		if (costs !== null) {
			totals.actualCacheCostUsd += costs.actualCacheCostUsd;
			totals.counterfactualCostUsd += costs.counterfactualCostUsd;
		}
	}
	totals.savingsUsd = totals.counterfactualCostUsd - totals.actualCacheCostUsd;
	totals.cacheHitRate = computeCacheHitRate(totals);
	totals.unknownPricingModels = [...unknownModels].sort();

	return {
		meta: { range: input.options.range, thresholdPercent, minRequestsForFlag },
		totals,
		byModel,
		byAccount,
		byProject,
	};
}
