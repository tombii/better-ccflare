import { describe, expect, it } from "bun:test";
import {
	buildCostSeries,
	efficiencyCaption,
	formatEfficiencyRatio,
	legacyApiKeyUsageLocation,
	pickDefaultApiKey,
	sortKeysActiveFirst,
} from "../tab-helpers";

describe("pickDefaultApiKey", () => {
	it("prefers the first active key", () => {
		expect(
			pickDefaultApiKey([
				{ id: "a", name: "a", isActive: false },
				{ id: "b", name: "b", isActive: true },
			]),
		).toBe("b");
	});

	it("falls back to the first key when every key is disabled", () => {
		expect(
			pickDefaultApiKey([
				{ id: "a", name: "a", isActive: false },
				{ id: "b", name: "b", isActive: false },
			]),
		).toBe("a");
	});

	it("is undefined with no keys", () => {
		expect(pickDefaultApiKey([])).toBeUndefined();
		expect(pickDefaultApiKey(undefined)).toBeUndefined();
	});
});

describe("sortKeysActiveFirst", () => {
	it("puts active keys first without mutating the input", () => {
		const input = [
			{ id: "a", name: "a", isActive: false },
			{ id: "b", name: "b", isActive: true },
			{ id: "c", name: "c", isActive: true },
		];
		const sorted = sortKeysActiveFirst(input);
		expect(sorted.map((k) => k.id)).toEqual(["b", "c", "a"]);
		expect(input.map((k) => k.id)).toEqual(["a", "b", "c"]);
	});
});

describe("formatEfficiencyRatio", () => {
	it("rounds a large ratio to a whole multiple", () => {
		expect(formatEfficiencyRatio(73.4, "ok")).toBe("73x");
	});

	it("keeps one decimal below 10", () => {
		expect(formatEfficiencyRatio(2.34, "ok")).toBe("2.3x");
	});

	it("is null — 'unavailable' — rather than Infinity", () => {
		expect(formatEfficiencyRatio(null, "unpriced")).toBeNull();
		expect(formatEfficiencyRatio(Number.POSITIVE_INFINITY, "ok")).toBeNull();
		expect(formatEfficiencyRatio(null, "no_plan_traffic")).toBeNull();
	});
});

describe("efficiencyCaption", () => {
	it("names how many accounts are unpriced on a partial ratio", () => {
		expect(efficiencyCaption("partial", 1)).toContain("1 account has");
		expect(efficiencyCaption("partial", 3)).toContain("3 accounts have");
	});

	it("says what to do when nothing is priced", () => {
		expect(efficiencyCaption("unpriced", 2)).toContain("monthly price");
	});
});

describe("buildCostSeries", () => {
	it("returns the stacked max in one pass", () => {
		const { data, maxCost } = buildCostSeries(
			[
				{ ts: 0, requests: 1, apiCostUsd: 1, planValueUsd: 2 },
				{ ts: 3_600_000, requests: 2, apiCostUsd: 5, planValueUsd: 1 },
			],
			3_600_000,
		);
		expect(data).toHaveLength(2);
		expect(maxCost).toBe(6);
		expect(typeof data[0].label).toBe("string");
	});

	it("handles an empty series", () => {
		const { data, maxCost } = buildCostSeries([], 3_600_000);
		expect(data).toEqual([]);
		expect(maxCost).toBe(0);
	});
});

describe("legacy API key links", () => {
	it("redirects stable IDs and arbitrary remaining path segments to the one usage page", () => {
		for (const id of ["own", "team/app", "nested/path/key", "team app"]) {
			const redirect = new URL(
				legacyApiKeyUsageLocation(`/api-keys/${encodeURIComponent(id)}`),
				"https://local",
			);
			expect(redirect.pathname).toBe("/api-key-usage");
			expect(redirect.searchParams.get("key")).toBe(id);
		}
		expect(
			new URL(
				legacyApiKeyUsageLocation("/api-keys/nested/path/key"),
				"https://local",
			).searchParams.get("key"),
		).toBe("nested/path/key");
	});
	it("decodes once so literal escaped slashes stay distinct from actual slashes", () => {
		expect(
			new URL(
				legacyApiKeyUsageLocation("/api-keys/team%252Fapp"),
				"https://local",
			).searchParams.get("key"),
		).toBe("team%2Fapp");
		expect(
			new URL(
				legacyApiKeyUsageLocation("/api-keys/team%2Fapp"),
				"https://local",
			).searchParams.get("key"),
		).toBe("team/app");
	});
	it("falls back safely for an empty or malformed key", () => {
		expect(legacyApiKeyUsageLocation("/api-keys/")).toBe("/api-key-usage");
		expect(legacyApiKeyUsageLocation("/api-keys/%zz")).toBe("/api-key-usage");
	});
});
