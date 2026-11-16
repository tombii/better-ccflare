import { describe, expect, it } from "bun:test";
import {
	computeEfficiency,
	computePlanCost,
	type PlanAccountUsage,
	PRORATION_DAYS,
	prorateMonthlyPrice,
} from "../api-key-usage";

const DAY = 24 * 60 * 60 * 1000;

function account(over: Partial<PlanAccountUsage> = {}): PlanAccountUsage {
	return {
		accountId: "acc-1",
		accountName: "one",
		keyPlanValueUsd: 100,
		accountPlanValueUsd: 100,
		planMonthlyUsd: 200,
		...over,
	};
}

describe("prorateMonthlyPrice", () => {
	it("charges the full month over a 30-day window", () => {
		expect(prorateMonthlyPrice(200, PRORATION_DAYS * DAY)).toBeCloseTo(200, 10);
	});

	it("charges a proportional slice of a shorter window", () => {
		// The three ranges the page offers, against a $300/month plan.
		expect(prorateMonthlyPrice(300, DAY)).toBeCloseTo(10, 10); // 24h
		expect(prorateMonthlyPrice(300, 7 * DAY)).toBeCloseTo(70, 10); // 7d
		expect(prorateMonthlyPrice(300, 30 * DAY)).toBeCloseTo(300, 10); // 30d
	});

	it("scales below a day without rounding to zero", () => {
		expect(prorateMonthlyPrice(300, 60 * 60 * 1000)).toBeCloseTo(10 / 24, 10);
		expect(prorateMonthlyPrice(300, 6 * 60 * 60 * 1000)).toBeCloseTo(
			60 / 24,
			10,
		);
	});
});

describe("computePlanCost", () => {
	it("apportions a single account by share and proration", () => {
		// This key is half the account's plan traffic over a 15-day window of a
		// $200/month plan: 0.5 * (200 * 15/30) = $50.
		const result = computePlanCost(
			[account({ keyPlanValueUsd: 500, accountPlanValueUsd: 1000 })],
			15 * DAY,
		);
		expect(result.planCostUsd).toBeCloseTo(50, 10);
		expect(result.accounts[0].share).toBeCloseTo(0.5, 10);
		expect(result.accounts[0].proratedPriceUsd).toBeCloseTo(100, 10);
		expect(result.accounts[0].contributionUsd).toBeCloseTo(50, 10);
		expect(result.unpricedAccountIds).toEqual([]);
		expect(result.windowDays).toBeCloseTo(15, 10);
		expect(result.pricedPlanValueUsd).toBeCloseTo(500, 10);
	});

	it("sums contributions across multiple accounts", () => {
		const result = computePlanCost(
			[
				account({
					accountId: "a",
					keyPlanValueUsd: 250,
					accountPlanValueUsd: 1000,
					planMonthlyUsd: 200,
				}),
				account({
					accountId: "b",
					keyPlanValueUsd: 900,
					accountPlanValueUsd: 900,
					planMonthlyUsd: 100,
				}),
			],
			30 * DAY,
		);
		// 0.25 * 200 + 1.0 * 100
		expect(result.planCostUsd).toBeCloseTo(150, 10);
		expect(result.pricedPlanValueUsd).toBeCloseTo(1150, 10);
		expect(result.accounts).toHaveLength(2);
	});

	it("reports an account with a NULL price as unpriced, never as free", () => {
		const result = computePlanCost(
			[
				account({ accountId: "priced", planMonthlyUsd: 200 }),
				account({
					accountId: "unpriced",
					planMonthlyUsd: null,
					keyPlanValueUsd: 900,
					accountPlanValueUsd: 900,
				}),
			],
			30 * DAY,
		);
		expect(result.planCostUsd).toBeCloseTo(200, 10);
		expect(result.unpricedAccountIds).toEqual(["unpriced"]);
		const unpriced = result.accounts.find((a) => a.accountId === "unpriced");
		// null, NOT 0: zero would read as "this subscription is free".
		expect(unpriced?.contributionUsd).toBeNull();
		expect(unpriced?.proratedPriceUsd).toBeNull();
		// The unpriced account's plan value is excluded from the ratio numerator.
		expect(result.pricedPlanValueUsd).toBeCloseTo(100, 10);
	});

	it("reports every account as unpriced when none carries a price", () => {
		const result = computePlanCost(
			[
				account({ accountId: "a", planMonthlyUsd: null }),
				account({ accountId: "b", planMonthlyUsd: null }),
			],
			30 * DAY,
		);
		expect(result.planCostUsd).toBe(0);
		expect(result.pricedPlanValueUsd).toBe(0);
		expect(result.unpricedAccountIds).toEqual(["a", "b"]);
	});

	it("returns an empty result for zero plan traffic", () => {
		const result = computePlanCost([], 30 * DAY);
		expect(result.planCostUsd).toBe(0);
		expect(result.accounts).toEqual([]);
		expect(result.unpricedAccountIds).toEqual([]);
	});

	it("guards the share denominator instead of dividing by zero", () => {
		const result = computePlanCost(
			[account({ keyPlanValueUsd: 0, accountPlanValueUsd: 0 })],
			30 * DAY,
		);
		expect(result.accounts[0].share).toBe(0);
		expect(Number.isFinite(result.planCostUsd)).toBe(true);
		expect(result.planCostUsd).toBe(0);
	});

	it("clamps a share above 1", () => {
		// Only reachable if the two queries disagree (a row written between
		// them); billing this key for more than the whole account would be worse.
		const result = computePlanCost(
			[account({ keyPlanValueUsd: 200, accountPlanValueUsd: 100 })],
			30 * DAY,
		);
		expect(result.accounts[0].share).toBe(1);
		expect(result.planCostUsd).toBeCloseTo(200, 10);
	});

	it("treats a negative or non-finite price as unpriced", () => {
		const result = computePlanCost(
			[
				account({ accountId: "neg", planMonthlyUsd: -5 }),
				account({ accountId: "nan", planMonthlyUsd: Number.NaN }),
			],
			30 * DAY,
		);
		expect(result.planCostUsd).toBe(0);
		expect(result.unpricedAccountIds).toEqual(["neg", "nan"]);
	});
});

describe("computeEfficiency", () => {
	it("divides priced plan value by plan cost", () => {
		// $44,000 of API-rate value against $600 of real subscription money.
		const planCost = computePlanCost(
			[
				account({
					keyPlanValueUsd: 44_000,
					accountPlanValueUsd: 44_000,
					planMonthlyUsd: 600,
				}),
			],
			30 * DAY,
		);
		const { efficiencyRatio, efficiencyStatus } = computeEfficiency(planCost);
		expect(efficiencyStatus).toBe("ok");
		expect(efficiencyRatio).toBeCloseTo(44_000 / 600, 6);
	});

	it("is unavailable, not Infinity, when nothing is priced", () => {
		const planCost = computePlanCost(
			[account({ planMonthlyUsd: null })],
			30 * DAY,
		);
		const { efficiencyRatio, efficiencyStatus } = computeEfficiency(planCost);
		expect(efficiencyRatio).toBeNull();
		expect(efficiencyStatus).toBe("unpriced");
	});

	it("is unavailable when a priced plan costs zero", () => {
		// A $0/month plan is a legal price and still leaves no denominator.
		const planCost = computePlanCost(
			[account({ planMonthlyUsd: 0 })],
			30 * DAY,
		);
		const { efficiencyRatio, efficiencyStatus } = computeEfficiency(planCost);
		expect(efficiencyRatio).toBeNull();
		expect(efficiencyStatus).toBe("unpriced");
	});

	it("reports no plan traffic distinctly from unpriced", () => {
		const { efficiencyRatio, efficiencyStatus } = computeEfficiency(
			computePlanCost([], 30 * DAY),
		);
		expect(efficiencyRatio).toBeNull();
		expect(efficiencyStatus).toBe("no_plan_traffic");
	});

	it("covers only the priced accounts when some carry no price", () => {
		const planCost = computePlanCost(
			[
				account({
					accountId: "priced",
					keyPlanValueUsd: 1000,
					accountPlanValueUsd: 1000,
					planMonthlyUsd: 100,
				}),
				account({
					accountId: "unpriced",
					keyPlanValueUsd: 9000,
					accountPlanValueUsd: 9000,
					planMonthlyUsd: null,
				}),
			],
			30 * DAY,
		);
		const { efficiencyRatio, efficiencyStatus } = computeEfficiency(planCost);
		expect(efficiencyStatus).toBe("partial");
		// 1000 / 100 — NOT 10000/100, which would inflate the headline by
		// crediting unpriced traffic against a priced denominator.
		expect(efficiencyRatio).toBeCloseTo(10, 10);
	});
});
