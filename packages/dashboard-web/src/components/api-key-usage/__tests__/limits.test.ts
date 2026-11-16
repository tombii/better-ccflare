import { describe, expect, it } from "bun:test";
import { serializeLimits } from "../../api-keys/limits";
import { apiKeyPageTarget, buildCostSeries } from "../tab-helpers";

const wholeKey = {
	id: "one",
	scopeModel: "",
	window: "day" as const,
	usd: "5.50",
	enforce: "block" as const,
};

describe("per-key limits form", () => {
	it("retains all scopes and windows with the key's chosen mode", () => {
		expect(
			serializeLimits("calendar", [
				wholeKey,
				{
					...wholeKey,
					id: "two",
					scopeModel: "opus",
					window: "hour",
					enforce: "warn",
				},
			]),
		).toEqual({
			mode: "calendar",
			limits: [
				{ scopeModel: null, window: "day", limitUsd: 5.5, enforce: "block" },
				{ scopeModel: "opus", window: "hour", limitUsd: 5.5, enforce: "warn" },
			],
		});
		expect(serializeLimits("rolling", []).limits).toEqual([]);
	});
	it("rejects duplicate whole-key rows and invalid dollar amounts before save", () => {
		expect(() =>
			serializeLimits("calendar", [
				wholeKey,
				{ ...wholeKey, id: "two", scopeModel: " " },
			]),
		).toThrow("one limit");
		for (const usd of ["", "0", "-1", "Infinity", "nonsense"])
			expect(() => serializeLimits("rolling", [{ ...wholeKey, usd }])).toThrow(
				"greater than zero",
			);
	});
});

describe("key page links", () => {
	it("uses the same decoded name for direct links and query links", () => {
		expect(apiKeyPageTarget("/api-keys/team%20a%2Fops")).toBe("team a/ops");
		expect(apiKeyPageTarget("/api-key-usage", "?key=team+a%2Fops")).toBe(
			"team a/ops",
		);
		expect(apiKeyPageTarget("/api-keys/%invalid")).toBeNull();
		expect(apiKeyPageTarget("/api-keys")).toBeNull();
	});
	it("plots plan traffic as part of total spend", () => {
		const series = buildCostSeries(
			[{ ts: 0, requests: 1, apiCostUsd: 1, planValueUsd: 9 }],
			3600000,
		);
		expect(series.data[0].totalCostUsd).toBe(10);
	});
});
