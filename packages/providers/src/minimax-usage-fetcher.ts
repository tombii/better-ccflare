import { Logger } from "@better-ccflare/logger";

const log = new Logger("MinimaxUsageFetcher");

/**
 * MiniMax Token Plan subscription usage endpoint.
 *
 *   GET https://www.minimax.io/v1/token_plan/remains
 *   Authorization: Bearer <API key>
 *
 * The response carries one entry per model class (e.g. "general", "video").
 * Only the `general` entry reflects text-inference quota; `video` is a
 * separate pool that must not be folded into utilization. The endpoint is a
 * pure metadata GET that costs zero quota; the Token Plan subscription key
 * is sufficient (no separate pay-as-you-go key required).
 */
export const MINIMAX_TOKEN_PLAN_REMAINS_ENDPOINT =
	"https://www.minimax.io/v1/token_plan/remains";

/**
 * Timeout for the metadata request and the body read. A stalled MiniMax
 * response previously kept the account's in-flight polling slot occupied
 * forever (PR #346 review finding #2). Mirrors the
 * `fetchXaiUsageData` / `fetchUsageData` convention in this package.
 */
const MINIMAX_USAGE_REQUEST_TIMEOUT_MS = 5000;

/** Model class we surface in ccflare utilization. */
const TEXT_INFERENCE_MODEL_NAME = "general";

/**
 * One row of the `model_remains` array. Field semantics:
 *   - `*_remaining_percent` is REMAINING (0-100), not utilization.
 *   - `*_total_count` / `*_usage_count` are request/credit counts, NOT tokens.
 *   - `start_time` / `end_time` / `weekly_*_time` are epoch milliseconds.
 *   - `remains_time` / `weekly_remains_time` are millisecond durations.
 *   - The status enums are only known for healthy accounts (`1`); tolerate
 *     unknown values and never switch on them.
 */
export interface MinimaxModelRemains {
	model_name: string;
	current_interval_remaining_percent: number;
	current_interval_status: number;
	current_interval_total_count: number;
	current_interval_usage_count: number;
	start_time: number;
	end_time: number;
	remains_time: number;
	current_weekly_remaining_percent: number;
	current_weekly_status: number;
	current_weekly_total_count: number;
	current_weekly_usage_count: number;
	weekly_start_time: number;
	weekly_end_time: number;
	weekly_remains_time: number;
}

interface MinimaxBaseResponse {
	status_code?: number;
	status_msg?: string;
}

interface MinimaxRawResponse {
	base_resp?: MinimaxBaseResponse;
	model_remains?: MinimaxModelRemains[];
}

export interface MinimaxUsageWindow {
	/** Utilization percent (0-100). 0 = fully available, 100 = exhausted. */
	utilization: number;
	/** Remaining percent (0-100) straight from the API. */
	remainingPercent: number;
	/** Reset time as epoch milliseconds. */
	resetAt: number | null;
	/** Window length in ms, derived from end_time - start_time per entry. */
	intervalMs: number | null;
}

export interface MinimaxUsageData {
	/** 5h-style per-model-class window derived from the `general` entry. */
	five_hour: MinimaxUsageWindow | null;
	/** 7d weekly window derived from the same `general` entry. */
	seven_day: MinimaxUsageWindow | null;
}

function isFiniteNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value);
}

function toRemainingPercent(value: unknown): number | null {
	if (!isFiniteNumber(value)) return null;
	if (value < 0) return 0;
	if (value > 100) return 100;
	return value;
}

/**
 * Invert the API's REMAINING percent into ccflare's UTILIZATION percent.
 * `utilization = 100 - remaining_percent`. Forgetting to invert would
 * report healthy accounts as exhausted and vice versa (gotcha #2).
 */
function remainingToUtilization(remainingPercent: number): number {
	const util = 100 - remainingPercent;
	if (util < 0) return 0;
	if (util > 100) return 100;
	return util;
}

function buildWindow(
	raw: MinimaxModelRemains,
	which: "interval" | "weekly",
): MinimaxUsageWindow | null {
	const remainingField =
		which === "interval"
			? "current_interval_remaining_percent"
			: "current_weekly_remaining_percent";
	const startField = which === "interval" ? "start_time" : "weekly_start_time";
	const endField = which === "interval" ? "end_time" : "weekly_end_time";

	const remaining = toRemainingPercent(
		(raw as unknown as Record<string, unknown>)[remainingField],
	);
	if (remaining === null) return null;

	const start = (raw as unknown as Record<string, unknown>)[startField];
	const end = (raw as unknown as Record<string, unknown>)[endField];
	const startMs = isFiniteNumber(start) ? start : null;
	const endMs = isFiniteNumber(end) ? end : null;
	const intervalMs =
		startMs !== null && endMs !== null && endMs >= startMs
			? endMs - startMs
			: null;

	return {
		utilization: remainingToUtilization(remaining),
		remainingPercent: remaining,
		resetAt: endMs,
		intervalMs,
	};
}

/**
 * Pick the row that represents the account's text-inference quota. Per
 * the live probe, `model_remains` is keyed by `model_name` (e.g. "general",
 * "video"); we use `general` and ignore `video` (gotcha #3).
 *
 * If no `general` entry exists we return null instead of substituting
 * another row: `video` (and any other class) is a separate quota pool,
 * and a wrong-substituted reading would surface as the account's text
 * utilization. With the routing side skipping accounts at >=100% util
 * (PR #345), that could silently drop a healthy account. "Unknown"
 * must stay distinct from 0% and from 100%.
 */
function pickTextInferenceRow(
	modelRemains: MinimaxModelRemains[],
): MinimaxModelRemains | null {
	return (
		modelRemains.find(
			(entry) => entry?.model_name === TEXT_INFERENCE_MODEL_NAME,
		) ?? null
	);
}

/**
 * Parse a raw response body. Returns null on any structural problem so the
 * caller treats it as a transient failure (no quota consumed on the API
 * side, so a retry from the poller is safe).
 */
export function parseMinimaxTokenPlanResponse(
	body: unknown,
): MinimaxUsageData | null {
	if (!body || typeof body !== "object") return null;
	const raw = body as MinimaxRawResponse;

	const statusCode = raw.base_resp?.status_code;
	if (typeof statusCode === "number" && statusCode !== 0) {
		log.warn(
			`Minimax usage returned base_resp.status_code=${statusCode}${raw.base_resp?.status_msg ? ` ${raw.base_resp.status_msg}` : ""}`,
		);
		return null;
	}

	if (!Array.isArray(raw.model_remains) || raw.model_remains.length === 0) {
		log.warn("Minimax usage response missing model_remains array");
		return null;
	}

	const row = pickTextInferenceRow(raw.model_remains);
	if (!row) {
		// model_remains is present and non-empty (checked above) but no row
		// matched the `general` filter. The filter is unverified — Minimax
		// publishes no response schema and may not actually emit a row named
		// "general" — so surface the observed model_name values as a WARN so
		// a single real poll reveals the truth. Deliberately do NOT fall back
		// to a first-row read: a wrong-substituted reading would surface as
		// the account's text utilization (PR #346 review fix 4311195e
		// removed that fallback for exactly this reason). Log model names
		// only — never tokens, keys, or full response bodies.
		const observed = raw.model_remains
			.map((entry) => entry?.model_name)
			.filter((name): name is string => typeof name === "string");
		log.warn(
			`Minimax usage response had no 'general' row; observed model_name values: [${observed.join(", ")}]`,
		);
		return null;
	}

	const five_hour = buildWindow(row, "interval");
	const seven_day = buildWindow(row, "weekly");

	if (!five_hour && !seven_day) return null;

	return { five_hour, seven_day };
}

/**
 * Fetch usage data from MiniMax's Token Plan usage endpoint. Failures
 * return null; this is non-blocking and never affects provider operation.
 */
export async function fetchMinimaxUsageData(
	apiKey: string,
): Promise<MinimaxUsageData | null> {
	const key = apiKey?.trim();
	if (!key) return null;

	const controller = new AbortController();
	const timeoutId = setTimeout(
		() => controller.abort(),
		MINIMAX_USAGE_REQUEST_TIMEOUT_MS,
	);
	try {
		const response = await fetch(MINIMAX_TOKEN_PLAN_REMAINS_ENDPOINT, {
			method: "GET",
			headers: {
				Authorization: `Bearer ${key}`,
				Accept: "application/json",
				"Content-Type": "application/json",
			},
			signal: controller.signal,
		});

		if (!response.ok) {
			log.warn(
				`Failed to fetch Minimax usage data: ${response.status} ${response.statusText}`,
				{
					status: response.status,
					statusText: response.statusText,
					url: MINIMAX_TOKEN_PLAN_REMAINS_ENDPOINT,
					timestamp: new Date().toISOString(),
				},
			);
			return null;
		}

		// Body read inherits the same abort signal: a stalled response with
		// headers flushed but no body would otherwise block indefinitely and
		// hold the in-flight polling slot until teardown.
		const body = await response.json();
		return parseMinimaxTokenPlanResponse(body);
	} catch (error) {
		log.warn(
			"Error fetching Minimax usage data:",
			error instanceof Error ? error.message : String(error),
		);
		return null;
	} finally {
		clearTimeout(timeoutId);
	}
}

/**
 * Representative utilization percent (0-100). Uses the higher of the
 * per-model-class 5h-style window and the 7d weekly window — mirrors how
 * the zai fetcher treats its 5h / 7d surfaces.
 */
export function getRepresentativeMinimaxUtilization(
	usage: MinimaxUsageData | null,
): number | null {
	if (!usage) return null;
	const candidates = [usage.five_hour, usage.seven_day]
		.map((w) => w?.utilization)
		.filter((v): v is number => typeof v === "number");
	if (candidates.length === 0) return null;
	return Math.max(...candidates);
}

/**
 * Window label for the most-restrictive window. Maps to the same labels
 * the accounts handler / /health surface use for Claude (so a MiniMax
 * account sitting in the 5h pool shows up next to other 5h-pressure
 * accounts in the UI).
 */
export function getRepresentativeMinimaxWindow(
	usage: MinimaxUsageData | null,
): string | null {
	if (!usage) return null;
	const five = usage.five_hour;
	const seven = usage.seven_day;
	if (five && seven) {
		return five.utilization >= seven.utilization ? "five_hour" : "seven_day";
	}
	if (five) return "five_hour";
	if (seven) return "seven_day";
	return null;
}
