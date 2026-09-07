import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
	fetchZaiUsageData,
	getRepresentativeZaiUtilization,
	getRepresentativeZaiWindow,
} from "../zai-usage-fetcher";

/**
 * Verbatim body from api.z.ai for a `pro` coding plan. The account carries TWO
 * TOKENS_LIMIT entries — a 5-hour one (unit 3, number 5) and a weekly one
 * (unit 6, number 1) — plus the monthly TIME_LIMIT covering the web tools.
 */
const PRO_PLAN_BODY = {
	code: 200,
	msg: "Operation successful",
	success: true,
	data: {
		level: "pro",
		limits: [
			{
				type: "TOKENS_LIMIT",
				unit: 3,
				number: 5,
				percentage: 1,
				nextResetTime: 1788455420775,
			},
			{
				type: "TOKENS_LIMIT",
				unit: 6,
				number: 1,
				percentage: 2,
				nextResetTime: 1789005906998,
			},
			{
				type: "TIME_LIMIT",
				unit: 5,
				number: 1,
				usage: 1000,
				currentValue: 0,
				remaining: 1000,
				percentage: 0,
				nextResetTime: 1790733906999,
			},
		],
	},
};

function stubFetch(body: unknown): void {
	globalThis.fetch = (async () =>
		new Response(JSON.stringify(body), {
			status: 200,
			headers: { "content-type": "application/json" },
		})) as typeof fetch;
}

describe("Zai usage fetcher", () => {
	let originalFetch: typeof fetch;

	beforeEach(() => {
		originalFetch = globalThis.fetch;
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	it("keeps both TOKENS_LIMIT windows instead of letting the last one win", async () => {
		stubFetch(PRO_PLAN_BODY);

		const usage = await fetchZaiUsageData("key");

		// Nearest reset is the real 5-hour window.
		expect(usage?.tokens_limit).toMatchObject({
			percentage: 1,
			resetAt: 1788455420775,
		});
		// The later one is weekly and must survive in its own field.
		expect(usage?.tokens_limit_weekly).toMatchObject({
			percentage: 2,
			resetAt: 1789005906998,
		});
		expect(usage?.time_limit).toMatchObject({
			percentage: 0,
			resetAt: 1790733906999,
		});
	});

	it("ranks the account by its most exhausted token window", async () => {
		stubFetch(PRO_PLAN_BODY);

		const usage = await fetchZaiUsageData("key");

		expect(getRepresentativeZaiUtilization(usage)).toBe(2);
		expect(getRepresentativeZaiWindow(usage)).toBe("seven_day");
	});

	it("reports the 5-hour window when it is the more exhausted one", async () => {
		stubFetch({
			...PRO_PLAN_BODY,
			data: {
				...PRO_PLAN_BODY.data,
				limits: [
					{ ...PRO_PLAN_BODY.data.limits[0], percentage: 80 },
					PRO_PLAN_BODY.data.limits[1],
					PRO_PLAN_BODY.data.limits[2],
				],
			},
		});

		const usage = await fetchZaiUsageData("key");

		expect(getRepresentativeZaiUtilization(usage)).toBe(80);
		expect(getRepresentativeZaiWindow(usage)).toBe("five_hour");
	});

	it("still works for plans that expose a single TOKENS_LIMIT window", async () => {
		stubFetch({
			...PRO_PLAN_BODY,
			data: { ...PRO_PLAN_BODY.data, limits: [PRO_PLAN_BODY.data.limits[0]] },
		});

		const usage = await fetchZaiUsageData("key");

		expect(usage?.tokens_limit?.resetAt).toBe(1788455420775);
		expect(usage?.tokens_limit_weekly).toBeNull();
		expect(getRepresentativeZaiWindow(usage)).toBe("five_hour");
	});
});
