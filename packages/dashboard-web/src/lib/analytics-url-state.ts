import { TIME_RANGES, type TimeRange } from "@better-ccflare/ui-constants";
import type { FilterState } from "../components/analytics/AnalyticsFilters";

export type AnalyticsUrlState = {
	viewMode: "normal" | "cumulative";
	timeRange: TimeRange;
	selectedMetric: string;
	modelBreakdown: boolean;
	filters: FilterState;
};

export const DEFAULT_ANALYTICS_STATE: AnalyticsUrlState = {
	viewMode: "normal",
	timeRange: "1h",
	selectedMetric: "requests",
	modelBreakdown: false,
	filters: { accounts: [], models: [], apiKeys: [], status: "all" },
};

const VIEW_VALUES = ["normal", "cumulative"] as const;
const METRIC_VALUES = [
	"requests",
	"tokens",
	"cost",
	"responseTime",
	"tokensPerSecond",
] as const;
const STATUS_VALUES = ["all", "success", "error"] as const;
const RANGE_VALUES = Object.keys(TIME_RANGES) as TimeRange[];

// Query-string keys this feature owns. Used to decide URL-vs-storage hydration.
const PARAM_KEYS = [
	"view",
	"range",
	"metric",
	"breakdown",
	"accounts",
	"models",
	"keys",
	"status",
] as const;

function oneOf<T extends string>(
	value: unknown,
	allowed: readonly T[],
	fallback: T,
): T {
	return typeof value === "string" &&
		(allowed as readonly string[]).includes(value)
		? (value as T)
		: fallback;
}

function asStringArray(value: unknown): string[] {
	return Array.isArray(value)
		? value.filter((item): item is string => typeof item === "string")
		: [];
}

function asRecord(value: unknown): Record<string, unknown> {
	return typeof value === "object" && value !== null
		? (value as Record<string, unknown>)
		: {};
}

/**
 * Coerce arbitrary input (decoded URL params or parsed localStorage) into a
 * valid AnalyticsUrlState. Invalid scalars fall back to their default, and the
 * cumulative view always forces modelBreakdown off (the per-model toggle is
 * hidden in cumulative mode).
 */
export function normalizeState(input: unknown): AnalyticsUrlState {
	const raw = asRecord(input);
	const filters = asRecord(raw.filters);
	const viewMode = oneOf(raw.viewMode, VIEW_VALUES, "normal");
	const breakdown =
		raw.modelBreakdown === true || raw.modelBreakdown === "true";
	return {
		viewMode,
		timeRange: oneOf(raw.timeRange, RANGE_VALUES, "1h"),
		selectedMetric: oneOf(raw.selectedMetric, METRIC_VALUES, "requests"),
		modelBreakdown: viewMode === "cumulative" ? false : breakdown,
		filters: {
			accounts: asStringArray(filters.accounts),
			models: asStringArray(filters.models),
			apiKeys: asStringArray(filters.apiKeys),
			status: oneOf(filters.status, STATUS_VALUES, "all"),
		},
	};
}

/** Serialize state to query params, omitting anything equal to its default. */
export function encodeAnalyticsState(
	state: AnalyticsUrlState,
): URLSearchParams {
	const params = new URLSearchParams();
	if (state.viewMode !== "normal") params.set("view", state.viewMode);
	if (state.timeRange !== "1h") params.set("range", state.timeRange);
	if (state.selectedMetric !== "requests")
		params.set("metric", state.selectedMetric);
	if (state.modelBreakdown && state.viewMode !== "cumulative")
		params.set("breakdown", "true");
	for (const account of state.filters.accounts)
		params.append("accounts", account);
	for (const model of state.filters.models) params.append("models", model);
	for (const key of state.filters.apiKeys) params.append("keys", key);
	if (state.filters.status !== "all")
		params.set("status", state.filters.status);
	return params;
}

/** Parse query params back into a validated, normalized state. */
export function decodeAnalyticsState(
	params: URLSearchParams,
): AnalyticsUrlState {
	return normalizeState({
		viewMode: params.get("view") ?? undefined,
		timeRange: params.get("range") ?? undefined,
		selectedMetric: params.get("metric") ?? undefined,
		modelBreakdown: params.get("breakdown") ?? undefined,
		filters: {
			accounts: params.getAll("accounts"),
			models: params.getAll("models"),
			apiKeys: params.getAll("keys"),
			status: params.get("status") ?? undefined,
		},
	});
}

/** True if the URL carries any param this feature owns. */
export function hasAnalyticsParams(params: URLSearchParams): boolean {
	return PARAM_KEYS.some((key) => params.has(key));
}
