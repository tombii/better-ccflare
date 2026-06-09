import { describe, expect, it } from "bun:test";
// Side-effect import: load @better-ccflare/core before @better-ccflare/types.
// types/agent.ts runtime-imports core while core/strategy.ts imports types, a
// pre-existing cycle that crashes when types is the first module evaluated.
import "@better-ccflare/core";
import { NO_ACCOUNT_ID } from "@better-ccflare/types";
import { buildRequestFilters, getRangeConfig } from "../query-filters";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

/**
 * getRangeConfig uses Date.now() internally, so startMs is asserted as a
 * window: [before - offset, after - offset].
 */
function expectStartMsOffset(
	range: string,
	offsetMs: number,
	expectedBucket: { bucketMs: number; displayName: string },
	expectedRange: string = range,
) {
	const before = Date.now();
	const { startMs, bucket, range: effectiveRange } = getRangeConfig(range);
	const after = Date.now();

	expect(startMs).toBeGreaterThanOrEqual(before - offsetMs);
	expect(startMs).toBeLessThanOrEqual(after - offsetMs);
	expect(bucket).toEqual(expectedBucket);
	expect(effectiveRange).toBe(expectedRange);
}

describe("getRangeConfig", () => {
	it("maps 1h to a 1-hour window with 1m buckets", () => {
		expectStartMsOffset("1h", HOUR, { bucketMs: 60 * 1000, displayName: "1m" });
	});

	it("maps 6h to a 6-hour window with 5m buckets", () => {
		expectStartMsOffset("6h", 6 * HOUR, {
			bucketMs: 5 * 60 * 1000,
			displayName: "5m",
		});
	});

	it("maps 24h to a 1-day window with 1h buckets", () => {
		expectStartMsOffset("24h", DAY, { bucketMs: HOUR, displayName: "1h" });
	});

	it("maps 7d to a 7-day window with 1h buckets", () => {
		expectStartMsOffset("7d", 7 * DAY, { bucketMs: HOUR, displayName: "1h" });
	});

	it("maps 30d to a 30-day window with 1d buckets", () => {
		expectStartMsOffset("30d", 30 * DAY, { bucketMs: DAY, displayName: "1d" });
	});

	it("falls back to the 24h window for unknown ranges", () => {
		expectStartMsOffset(
			"bogus",
			DAY,
			{ bucketMs: HOUR, displayName: "1h" },
			"24h",
		);
	});
});

describe("buildRequestFilters", () => {
	const START_MS = 1_700_000_000_000;

	it("returns only the timestamp condition when no filters are present", () => {
		const { whereClause, params } = buildRequestFilters(
			new URLSearchParams(),
			START_MS,
		);
		expect(whereClause).toBe("timestamp > ?");
		expect(params).toEqual([START_MS]);
	});

	it("builds the accounts condition with name subquery and NO_ACCOUNT_ID escape hatch", () => {
		const { whereClause, params } = buildRequestFilters(
			new URLSearchParams("accounts=acct-1,acct-2"),
			START_MS,
		);

		expect(whereClause).toContain("timestamp > ?");
		expect(whereClause).toContain(
			"r.account_used IN (SELECT id FROM accounts WHERE name IN (?,?))",
		);
		expect(whereClause).toContain("OR (r.account_used = ? AND ? IN (?,?))");
		expect(params).toEqual([
			START_MS,
			"acct-1",
			"acct-2",
			NO_ACCOUNT_ID,
			NO_ACCOUNT_ID,
			"acct-1",
			"acct-2",
		]);
	});

	it("builds the models condition", () => {
		const { whereClause, params } = buildRequestFilters(
			new URLSearchParams("models=model-a,model-b"),
			START_MS,
		);
		expect(whereClause).toContain("model IN (?,?)");
		expect(params).toEqual([START_MS, "model-a", "model-b"]);
	});

	it("builds the apiKeys condition", () => {
		const { whereClause, params } = buildRequestFilters(
			new URLSearchParams("apiKeys=key-1"),
			START_MS,
		);
		expect(whereClause).toContain("api_key_name IN (?)");
		expect(params).toEqual([START_MS, "key-1"]);
	});

	it("builds the status condition for success", () => {
		const { whereClause, params } = buildRequestFilters(
			new URLSearchParams("status=success"),
			START_MS,
		);
		expect(whereClause).toContain("success = TRUE");
		expect(params).toEqual([START_MS]);
	});

	it("builds the status condition for error", () => {
		const { whereClause, params } = buildRequestFilters(
			new URLSearchParams("status=error"),
			START_MS,
		);
		expect(whereClause).toContain("success = FALSE");
		expect(params).toEqual([START_MS]);
	});

	it("adds no status condition for status=all", () => {
		const { whereClause } = buildRequestFilters(
			new URLSearchParams("status=all"),
			START_MS,
		);
		expect(whereClause).not.toContain("success =");
	});

	it("ignores empty filter values", () => {
		const { whereClause, params } = buildRequestFilters(
			new URLSearchParams("accounts=&models=&apiKeys="),
			START_MS,
		);
		expect(whereClause).toBe("timestamp > ?");
		expect(params).toEqual([START_MS]);
	});

	it("drops empty segments inside comma lists", () => {
		const { whereClause, params } = buildRequestFilters(
			new URLSearchParams("models=model-a,,model-b,"),
			START_MS,
		);
		expect(whereClause).toContain("model IN (?,?)");
		expect(params).toEqual([START_MS, "model-a", "model-b"]);
	});

	it("combines all filters with AND in timestamp/accounts/models/apiKeys/status order", () => {
		const { whereClause, params } = buildRequestFilters(
			new URLSearchParams(
				"accounts=acct-1&models=model-a&apiKeys=key-1&status=error",
			),
			START_MS,
		);

		const tsIdx = whereClause.indexOf("timestamp > ?");
		const acctIdx = whereClause.indexOf("r.account_used IN");
		const modelIdx = whereClause.indexOf("model IN");
		const keyIdx = whereClause.indexOf("api_key_name IN");
		const statusIdx = whereClause.indexOf("success = FALSE");

		expect(tsIdx).toBeGreaterThanOrEqual(0);
		expect(acctIdx).toBeGreaterThan(tsIdx);
		expect(modelIdx).toBeGreaterThan(acctIdx);
		expect(keyIdx).toBeGreaterThan(modelIdx);
		expect(statusIdx).toBeGreaterThan(keyIdx);

		expect(params).toEqual([
			START_MS,
			"acct-1",
			NO_ACCOUNT_ID,
			NO_ACCOUNT_ID,
			"acct-1",
			"model-a",
			"key-1",
		]);
	});
});
