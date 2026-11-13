import { describe, expect, it } from "bun:test";
import { computePlanCost } from "../api-key-usage";
import {
	apiKeyUsageRange,
	calendarMonthFraction,
} from "../api-key-usage-range";

const HOUR = 3_600_000;
const range = (value: string, now: string) =>
	apiKeyUsageRange(new URLSearchParams({ range: value }), Date.parse(now));

describe("API key usage ranges", () => {
	it("offers all rolling ranges with exact elapsed durations", () => {
		for (const [name, hours] of [
			["1h", 1],
			["24h", 24],
			["7d", 168],
			["30d", 720],
		] as const) {
			const bounds = range(name, "2026-11-13T12:30:00Z");
			expect(bounds.endMs - bounds.startMs).toBe(hours * HOUR);
		}
	});

	it("uses Dublin months, including the October DST transition", () => {
		const current = range("this_month", "2026-10-26T12:00:00Z");
		expect(new Date(current.startMs).toISOString()).toBe(
			"2026-09-30T23:00:00.000Z",
		);
		expect(new Date(current.endMs).toISOString()).toBe(
			"2026-10-26T12:00:00.000Z",
		);
		const last = range("last_month", "2026-11-13T12:00:00Z");
		expect(new Date(last.startMs).toISOString()).toBe(
			"2026-09-30T23:00:00.000Z",
		);
		expect(new Date(last.endMs).toISOString()).toBe("2026-11-01T00:00:00.000Z");
		expect(last.endMs - last.startMs).toBe(745 * HOUR);
	});

	it("validates custom from/to dates", () => {
		for (const fields of [
			{},
			{ from: "bad", to: "2026-01-01" },
			{ from: "2026-02-01", to: "2026-01-01" },
		]) {
			expect(() =>
				apiKeyUsageRange(new URLSearchParams({ range: "custom", ...fields })),
			).toThrow();
		}
		const bounds = apiKeyUsageRange(
			new URLSearchParams({
				range: "custom",
				from: "2026-02-01T00:00:00Z",
				to: "2026-03-01T00:00:00Z",
			}),
		);
		expect(bounds.endMs - bounds.startMs).toBe(28 * 24 * HOUR);
	});

	it("prorates complete calendar months at their real lengths", () => {
		for (const [from, to] of [
			["2026-02-01T00:00:00Z", "2026-03-01T00:00:00Z"],
			["2026-09-30T23:00:00Z", "2026-11-01T00:00:00Z"],
		]) {
			expect(
				calendarMonthFraction(Date.parse(from), Date.parse(to)),
			).toBeCloseTo(1, 12);
		}
		const from = Date.parse("2026-02-01T00:00:00Z");
		const to = Date.parse("2026-03-01T00:00:00Z");
		const cost = computePlanCost(
			[
				{
					accountId: "a",
					accountName: "A",
					keyPlanValueUsd: 100,
					accountPlanValueUsd: 400,
					planMonthlyUsd: 200,
				},
			],
			to - from,
			from,
		);
		expect(cost.planCostUsd).toBeCloseTo(50, 10);
	});
});
