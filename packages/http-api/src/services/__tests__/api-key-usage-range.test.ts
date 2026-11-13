import { describe, expect, it, spyOn } from "bun:test";
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

	it("caps custom ranges at 400 days and accepts the exact boundary", () => {
		const from = "2026-01-01T00:00:00Z";
		const endMs = Date.parse(from) + 400 * 24 * HOUR;
		const params = new URLSearchParams({
			range: "custom",
			from,
			to: new Date(endMs).toISOString(),
		});
		expect(apiKeyUsageRange(params).endMs).toBe(endMs);
		params.set("to", new Date(endMs + 1).toISOString());
		expect(() => apiKeyUsageRange(params)).toThrow("400 days");
	});

	it("rejects custom dates outside the supported years even for short ranges", () => {
		for (const [from, to] of [
			["1999-12-31T23:59:59Z", "2000-01-01T00:00:00Z"],
			["2100-01-01T00:00:00Z", "2100-01-01T00:00:01Z"],
			["+100000-01-01T00:00:00Z", "+100000-01-02T00:00:00Z"],
		]) {
			expect(() =>
				apiKeyUsageRange(new URLSearchParams({ range: "custom", from, to })),
			).toThrow("between 2000-01-01 and 2100-01-01");
		}
	});

	it("prorates partial ends and whole months across DST and month ends", () => {
		for (const [from, to, expected] of [
			// March has 743 hours in Dublin; April has 720 hours.
			["2026-03-31T11:00:00Z", "2026-04-01T11:00:00Z", 12 / 743 + 12 / 720],
			// Partial September, a whole October (745 hours), partial November.
			["2026-09-15T23:00:00Z", "2026-11-16T00:00:00Z", 15 / 30 + 1 + 15 / 30],
			["2024-02-29T00:00:00Z", "2024-03-01T00:00:00Z", 1 / 29],
		] as const) {
			expect(
				calendarMonthFraction(Date.parse(from), Date.parse(to)),
			).toBeCloseTo(expected, 12);
		}
	});

	it("uses bounded calendar work regardless of the number of whole months", () => {
		const format = spyOn(Intl.DateTimeFormat.prototype, "formatToParts");
		try {
			expect(
				calendarMonthFraction(
					Date.parse("2000-01-01T00:00:00Z"),
					Date.parse("2100-01-01T00:00:00Z"),
				),
			).toBeCloseTo(1200, 12);
			expect(format.mock.calls.length).toBeLessThan(50);
		} finally {
			format.mockRestore();
		}
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
