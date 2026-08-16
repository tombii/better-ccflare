import { describe, expect, test } from "bun:test";
import type {
	AnomalyInsightsResponse,
	APIContext,
} from "@better-ccflare/types";
import { createAnomalyInsightsHandler, parseDetectorParam } from "../insights";

/**
 * Tests for the anomaly insights handler: query-param parsing/clamping and
 * the row-scan truncation path. The DB adapter is faked (the handler only
 * calls getAdapter().query); rows use a null model so no pricing lookups
 * (network-backed) are triggered.
 */

function sqlRow(i: number, timestamp: number) {
	return {
		id: `req-${i}`,
		timestamp,
		account: "acc",
		model: null,
		project: null,
		input_tokens: 100,
		cache_read_input_tokens: 0,
		cache_creation_input_tokens: 0,
		output_tokens: 0,
		cost_usd: 0,
	};
}

function contextWithRows(rows: unknown[]): APIContext {
	return {
		dbOps: {
			getAdapter: () => ({
				query: async () => rows,
			}),
		},
	} as unknown as APIContext;
}

describe("parseDetectorParam", () => {
	test("falls back to the default when missing or unparseable", () => {
		expect(parseDetectorParam(null, 3, 0.5, 10)).toBe(3);
		expect(parseDetectorParam("abc", 3, 0.5, 10)).toBe(3);
		expect(parseDetectorParam("", 3, 0.5, 10)).toBe(3);
	});

	test("parses valid floats", () => {
		expect(parseDetectorParam("2.5", 3, 0.5, 10)).toBe(2.5);
	});

	test("clamps to the allowed range", () => {
		expect(parseDetectorParam("0.1", 3, 0.5, 10)).toBe(0.5);
		expect(parseDetectorParam("99", 3, 0.5, 10)).toBe(10);
		expect(parseDetectorParam("-5", 3, 0.5, 10)).toBe(0.5);
	});

	test("rounds to an integer when requested, after clamping", () => {
		expect(parseDetectorParam("5.7", 5, 1, 120, true)).toBe(6);
		expect(parseDetectorParam("999", 50, 1, 500, true)).toBe(500);
		expect(parseDetectorParam(null, 50, 1, 500, true)).toBe(50);
	});
});

describe("createAnomalyInsightsHandler", () => {
	test("echoes defaults in meta and reports scanned rows", async () => {
		const handler = createAnomalyInsightsHandler(
			contextWithRows([sqlRow(1, 2_000), sqlRow(2, 1_000)]),
		);
		const response = await handler(new URLSearchParams());
		expect(response.status).toBe(200);
		const body = (await response.json()) as AnomalyInsightsResponse;
		expect(body.meta.range).toBe("24h");
		expect(body.meta.zScoreThreshold).toBe(3.5);
		expect(body.meta.maxEventsPerDetector).toBe(50);
		expect(body.meta.scannedRequests).toBe(2);
		expect(body.meta.truncated).toBe(false);
	});

	test("falls back and clamps invalid query params", async () => {
		const handler = createAnomalyInsightsHandler(contextWithRows([]));
		const response = await handler(
			new URLSearchParams(
				"zScoreThreshold=abc&maxEventsPerDetector=99999&loopWindowMinutes=5.7&minBaselineRequests=-3&range=bogus",
			),
		);
		const body = (await response.json()) as AnomalyInsightsResponse;
		expect(body.meta.zScoreThreshold).toBe(3.5);
		expect(body.meta.maxEventsPerDetector).toBe(500);
		expect(body.meta.loopWindowMinutes).toBe(6);
		expect(body.meta.minBaselineRequests).toBe(2);
		// Unknown ranges normalize to 24h, mirroring the analytics endpoint.
		expect(body.meta.range).toBe("24h");
	});

	test("marks the response truncated when the scan cap is exceeded", async () => {
		// The handler fetches cap + 1 rows to detect truncation; simulate the
		// DB returning exactly that.
		const rows = Array.from({ length: 100_001 }, (_, i) => sqlRow(i, i));
		const handler = createAnomalyInsightsHandler(contextWithRows(rows));
		const response = await handler(new URLSearchParams());
		const body = (await response.json()) as AnomalyInsightsResponse;
		expect(body.meta.truncated).toBe(true);
		expect(body.meta.scannedRequests).toBe(100_000);
	});

	test("meta.baselineWindowMinutes reflects the selected range, not the 24h default (issue #410 review fix)", async () => {
		// Before this fix, baselineWindowMinutes was never set from the
		// handler's `range` query param, so meta always echoed
		// DEFAULT_BASELINE_WINDOW_MINUTES (24h = 1440) regardless of which
		// range the user picked. This endpoint scores the same row set it
		// baselines from (baselineRows === scoringRows === rows), so the
		// effective baseline window IS the selected range.
		const handler = createAnomalyInsightsHandler(contextWithRows([]));

		const response7d = await handler(new URLSearchParams("range=7d"));
		const body7d = (await response7d.json()) as AnomalyInsightsResponse;
		expect(body7d.meta.range).toBe("7d");
		// 7d = 7 * 24 * 60 = 10080 minutes; allow small scheduling slack.
		expect(body7d.meta.baselineWindowMinutes).toBeGreaterThan(10_079);
		expect(body7d.meta.baselineWindowMinutes).toBeLessThanOrEqual(10_081);

		const response30d = await handler(new URLSearchParams("range=30d"));
		const body30d = (await response30d.json()) as AnomalyInsightsResponse;
		expect(body30d.meta.range).toBe("30d");
		// 30d = 30 * 24 * 60 = 43200 minutes.
		expect(body30d.meta.baselineWindowMinutes).toBeGreaterThan(43_199);
		expect(body30d.meta.baselineWindowMinutes).toBeLessThanOrEqual(43_201);

		// Different ranges must not collapse to the same fixed default.
		expect(body7d.meta.baselineWindowMinutes).not.toBe(
			body30d.meta.baselineWindowMinutes,
		);
	});

	test("returns 500 when the query fails", async () => {
		const context = {
			dbOps: {
				getAdapter: () => ({
					query: async () => {
						throw new Error("boom");
					},
				}),
			},
		} as unknown as APIContext;
		const handler = createAnomalyInsightsHandler(context);
		const response = await handler(new URLSearchParams());
		expect(response.status).toBe(500);
	});
});
