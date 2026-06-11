import { describe, expect, it } from "bun:test";
import {
	type AnalyticsUrlState,
	DEFAULT_ANALYTICS_STATE,
	decodeAnalyticsState,
	encodeAnalyticsState,
	hasAnalyticsParams,
	normalizeState,
} from "../analytics-url-state";

describe("encodeAnalyticsState", () => {
	it("emits no params for the default state", () => {
		expect(encodeAnalyticsState(DEFAULT_ANALYTICS_STATE).toString()).toBe("");
	});

	it("omits values equal to their default but includes the rest", () => {
		const params = encodeAnalyticsState({
			...DEFAULT_ANALYTICS_STATE,
			viewMode: "cumulative",
			timeRange: "24h",
			selectedMetric: "cost",
		});
		expect(params.get("view")).toBe("cumulative");
		expect(params.get("range")).toBe("24h");
		expect(params.get("metric")).toBe("cost");
		expect(params.has("breakdown")).toBe(false);
		expect(params.has("status")).toBe(false);
	});

	it("encodes filter arrays as repeated params and status when not 'all'", () => {
		const params = encodeAnalyticsState({
			...DEFAULT_ANALYTICS_STATE,
			filters: {
				accounts: ["a", "b"],
				models: ["m1"],
				apiKeys: ["k1"],
				status: "error",
			},
		});
		expect(params.getAll("accounts")).toEqual(["a", "b"]);
		expect(params.getAll("models")).toEqual(["m1"]);
		expect(params.getAll("keys")).toEqual(["k1"]);
		expect(params.get("status")).toBe("error");
	});

	it("never emits breakdown when view is cumulative", () => {
		const params = encodeAnalyticsState({
			...DEFAULT_ANALYTICS_STATE,
			viewMode: "cumulative",
			modelBreakdown: true,
		});
		expect(params.has("breakdown")).toBe(false);
	});
});

describe("decodeAnalyticsState", () => {
	it("returns defaults for empty params", () => {
		expect(decodeAnalyticsState(new URLSearchParams())).toEqual(
			DEFAULT_ANALYTICS_STATE,
		);
	});

	it("round-trips a representative state", () => {
		const state: AnalyticsUrlState = {
			viewMode: "normal",
			timeRange: "7d",
			selectedMetric: "tokensPerSecond",
			modelBreakdown: true,
			filters: {
				accounts: ["acc-1"],
				models: ["z-ai/glm-4.5-air:free"],
				apiKeys: [],
				status: "success",
			},
		};
		expect(decodeAnalyticsState(encodeAnalyticsState(state))).toEqual(state);
	});

	it("falls back to defaults for invalid scalar values", () => {
		const params = new URLSearchParams(
			"view=bogus&range=99y&metric=foo&status=maybe",
		);
		expect(decodeAnalyticsState(params)).toEqual(DEFAULT_ANALYTICS_STATE);
	});

	it("forces modelBreakdown off when view is cumulative", () => {
		const state = decodeAnalyticsState(
			new URLSearchParams("view=cumulative&breakdown=true"),
		);
		expect(state.viewMode).toBe("cumulative");
		expect(state.modelBreakdown).toBe(false);
	});

	it("parses breakdown=true in normal view", () => {
		const state = decodeAnalyticsState(new URLSearchParams("breakdown=true"));
		expect(state.modelBreakdown).toBe(true);
	});
});

describe("normalizeState", () => {
	it("coerces garbage input to the default state", () => {
		expect(normalizeState(null)).toEqual(DEFAULT_ANALYTICS_STATE);
		expect(normalizeState({ viewMode: 123, filters: "nope" })).toEqual(
			DEFAULT_ANALYTICS_STATE,
		);
	});

	it("keeps valid values and drops non-string filter entries", () => {
		expect(
			normalizeState({
				viewMode: "cumulative",
				timeRange: "7d",
				selectedMetric: "cost",
				modelBreakdown: true,
				filters: {
					accounts: ["a", 5, null],
					models: [],
					apiKeys: ["k"],
					status: "error",
				},
			}),
		).toEqual({
			viewMode: "cumulative",
			timeRange: "7d",
			selectedMetric: "cost",
			modelBreakdown: false,
			filters: { accounts: ["a"], models: [], apiKeys: ["k"], status: "error" },
		});
	});
});

describe("hasAnalyticsParams", () => {
	it("is false for empty or unrecognized params", () => {
		expect(hasAnalyticsParams(new URLSearchParams())).toBe(false);
		expect(hasAnalyticsParams(new URLSearchParams("foo=bar"))).toBe(false);
	});

	it("is true when a recognized param is present", () => {
		expect(hasAnalyticsParams(new URLSearchParams("view=cumulative"))).toBe(
			true,
		);
		expect(hasAnalyticsParams(new URLSearchParams("accounts=a"))).toBe(true);
	});
});
