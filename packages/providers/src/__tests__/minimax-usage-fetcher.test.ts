import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import {
	fetchMinimaxUsageData,
	getRepresentativeMinimaxUtilization,
	getRepresentativeMinimaxWindow,
	MINIMAX_TOKEN_PLAN_REMAINS_ENDPOINT,
	parseMinimaxTokenPlanResponse,
} from "../minimax-usage-fetcher";

const FIVE_HOUR_MS = 5 * 60 * 60 * 1000;
const SEVEN_DAY_MS = 7 * 24 * 60 * 60 * 1000;
const TWENTY_FOUR_HOUR_MS = 24 * 60 * 60 * 1000;

function makeRow(
	overrides: Partial<{
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
	}> = {},
) {
	const intervalStart = 1_700_000_000_000;
	const weeklyStart = 1_700_000_000_000;
	return {
		model_name: "general",
		current_interval_remaining_percent: 75,
		current_interval_status: 1,
		current_interval_total_count: 100,
		current_interval_usage_count: 25,
		start_time: intervalStart,
		end_time: intervalStart + FIVE_HOUR_MS,
		remains_time: FIVE_HOUR_MS,
		current_weekly_remaining_percent: 90,
		current_weekly_status: 1,
		current_weekly_total_count: 1000,
		current_weekly_usage_count: 100,
		weekly_start_time: weeklyStart,
		weekly_end_time: weeklyStart + SEVEN_DAY_MS,
		weekly_remains_time: SEVEN_DAY_MS,
		...overrides,
	};
}

describe("Minimax usage fetcher", () => {
	let originalFetch: typeof fetch;

	beforeEach(() => {
		originalFetch = globalThis.fetch;
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	it("inverts remaining percent into utilization (75 remaining -> 25 utilized)", () => {
		const parsed = parseMinimaxTokenPlanResponse({
			base_resp: { status_code: 0, status_msg: "ok" },
			model_remains: [makeRow()],
		});

		expect(parsed?.five_hour?.utilization).toBe(25);
		expect(parsed?.five_hour?.remainingPercent).toBe(75);
		expect(parsed?.seven_day?.utilization).toBe(10);
		expect(parsed?.seven_day?.remainingPercent).toBe(90);
	});

	it("picks the `general` row, ignoring the `video` row", () => {
		const parsed = parseMinimaxTokenPlanResponse({
			base_resp: { status_code: 0 },
			model_remains: [
				makeRow({
					model_name: "video",
					current_interval_remaining_percent: 5,
					current_weekly_remaining_percent: 5,
				}),
				makeRow({
					model_name: "general",
					current_interval_remaining_percent: 60,
					current_weekly_remaining_percent: 60,
				}),
			],
		});

		expect(parsed?.five_hour?.utilization).toBe(40);
		expect(parsed?.five_hour?.remainingPercent).toBe(60);
		expect(parsed?.seven_day?.utilization).toBe(40);
	});

	it("returns null when no `general` row is present instead of substituting video", () => {
		const parsed = parseMinimaxTokenPlanResponse({
			base_resp: { status_code: 0 },
			model_remains: [
				makeRow({
					model_name: "video",
					current_interval_remaining_percent: 5,
					current_weekly_remaining_percent: 5,
				}),
			],
		});

		// A separate quota pool must not become text utilization. Null keeps
		// "unknown" distinct from both 0% and 100% utilization.
		expect(parsed).toBeNull();
		expect(getRepresentativeMinimaxUtilization(parsed)).toBeNull();
		expect(getRepresentativeMinimaxWindow(parsed)).toBeNull();
	});

	it("derives interval length per-row (general=5h, video=24h — not hardcoded)", () => {
		const generalStart = 1_700_000_000_000;
		const videoStart = 1_700_000_000_000;
		const parsed = parseMinimaxTokenPlanResponse({
			base_resp: { status_code: 0 },
			model_remains: [
				makeRow({
					model_name: "general",
					start_time: generalStart,
					end_time: generalStart + FIVE_HOUR_MS,
				}),
				makeRow({
					model_name: "video",
					current_interval_remaining_percent: 50,
					current_weekly_remaining_percent: 50,
					start_time: videoStart,
					end_time: videoStart + TWENTY_FOUR_HOUR_MS,
					remains_time: TWENTY_FOUR_HOUR_MS,
				}),
			],
		});

		// Even though `video` would appear first, we use the `general` row.
		expect(parsed?.five_hour?.intervalMs).toBe(FIVE_HOUR_MS);
		expect(parsed?.five_hour?.resetAt).toBe(generalStart + FIVE_HOUR_MS);
		expect(parsed?.seven_day?.intervalMs).toBe(SEVEN_DAY_MS);
	});

	it("tolerates an unknown status enum value", () => {
		const parsed = parseMinimaxTokenPlanResponse({
			base_resp: { status_code: 0 },
			model_remains: [
				makeRow({
					current_interval_status: 7,
					current_weekly_status: 7,
					current_interval_remaining_percent: 40,
					current_weekly_remaining_percent: 80,
				}),
			],
		});

		// Still derives exhaustion purely from percentages, ignoring the
		// unrecognised enum value.
		expect(parsed?.five_hour?.utilization).toBe(60);
		expect(parsed?.seven_day?.utilization).toBe(20);
	});

	it("returns null when base_resp.status_code is non-zero", () => {
		expect(
			parseMinimaxTokenPlanResponse({
				base_resp: { status_code: 1001, status_msg: "quota exceeded" },
				model_remains: [makeRow()],
			}),
		).toBeNull();
	});

	it("clamps out-of-range remaining percent before inverting", () => {
		const parsed = parseMinimaxTokenPlanResponse({
			base_resp: { status_code: 0 },
			model_remains: [
				makeRow({
					current_interval_remaining_percent: 250, // bogus
					current_weekly_remaining_percent: -10, // bogus
				}),
			],
		});

		expect(parsed?.five_hour?.remainingPercent).toBe(100);
		expect(parsed?.five_hour?.utilization).toBe(0);
		expect(parsed?.seven_day?.remainingPercent).toBe(0);
		expect(parsed?.seven_day?.utilization).toBe(100);
	});

	it("hits the documented Token Plan remains endpoint with a Bearer header", async () => {
		const body = {
			base_resp: { status_code: 0 },
			model_remains: [makeRow()],
		};
		const fetchMock = mock(
			async (input: RequestInfo | URL, init?: RequestInit) => {
				expect(String(input)).toBe(MINIMAX_TOKEN_PLAN_REMAINS_ENDPOINT);
				expect(init?.method).toBe("GET");
				expect((init?.headers as Record<string, string>).Authorization).toBe(
					"Bearer test-key",
				);
				return new Response(JSON.stringify(body), { status: 200 });
			},
		);
		globalThis.fetch = fetchMock as unknown as typeof fetch;

		const usage = await fetchMinimaxUsageData(" test-key ");

		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(usage?.five_hour?.utilization).toBe(25);
	});

	it("returns null on non-2xx HTTP responses", async () => {
		const fetchMock = mock(async () => new Response("nope", { status: 500 }));
		globalThis.fetch = fetchMock as unknown as typeof fetch;

		expect(await fetchMinimaxUsageData("k")).toBeNull();
	});

	it("aborts the request via AbortController so a stalled response cannot hold the polling slot", async () => {
		let observedSignal: AbortSignal | undefined;
		const fetchMock = mock(
			async (_input: RequestInfo | URL, init?: RequestInit) => {
				observedSignal = init?.signal ?? undefined;
				throw new DOMException("aborted", "AbortError");
			},
		);
		globalThis.fetch = fetchMock as unknown as typeof fetch;

		const result = await fetchMinimaxUsageData("k");

		expect(observedSignal).toBeInstanceOf(AbortSignal);
		expect(result).toBeNull();
	});

	it("returns null on a network failure", async () => {
		const fetchMock = mock(async () => {
			throw new Error("ECONNRESET");
		});
		globalThis.fetch = fetchMock as unknown as typeof fetch;

		expect(await fetchMinimaxUsageData("k")).toBeNull();
	});

	it("representative utilization picks the more-restrictive window", () => {
		const parsed = parseMinimaxTokenPlanResponse({
			base_resp: { status_code: 0 },
			model_remains: [
				makeRow({
					current_interval_remaining_percent: 50, // -> 50% util
					current_weekly_remaining_percent: 80, // -> 20% util
				}),
			],
		})!;

		expect(getRepresentativeMinimaxUtilization(parsed)).toBe(50);
		expect(getRepresentativeMinimaxWindow(parsed)).toBe("five_hour");
	});

	it("falls back to seven_day when only the weekly window is present", () => {
		const weeklyStart = 1_700_000_000_000;
		// Make the interval window totally absent (NaN); the parser should
		// still surface the weekly window as a representative reading.
		const parsed = parseMinimaxTokenPlanResponse({
			base_resp: { status_code: 0 },
			model_remains: [
				makeRow({
					current_interval_remaining_percent: Number.NaN,
					current_interval_total_count: Number.NaN,
					current_interval_usage_count: Number.NaN,
					start_time: Number.NaN,
					end_time: Number.NaN,
					remains_time: Number.NaN,
					weekly_start_time: weeklyStart,
					weekly_end_time: weeklyStart + SEVEN_DAY_MS,
					current_weekly_remaining_percent: 25, // -> 75% util
				}),
			],
		});

		expect(parsed?.five_hour).toBeNull();
		expect(parsed?.seven_day?.utilization).toBe(75);
		expect(getRepresentativeMinimaxUtilization(parsed)).toBe(75);
		expect(getRepresentativeMinimaxWindow(parsed)).toBe("seven_day");
	});
});
