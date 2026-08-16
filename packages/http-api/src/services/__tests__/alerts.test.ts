import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import type { Config } from "@better-ccflare/config";
import { BunSqlAdapter, ensureSchema } from "@better-ccflare/database";
import type {
	AlertEvent,
	AlertsConfigPayload,
	RunawayLoopGroup,
} from "@better-ccflare/types";
import {
	AlertService,
	buildRequestTokenAlert,
	buildRunawayLoopAlertId,
	buildThresholdAlertId,
	shouldFireAlert,
} from "../alerts";

const CONFIG: AlertsConfigPayload = {
	dailySpendUsd: 10,
	tokensPerHour: 100_000,
	requestTokens: 50_000,
	anomalyEnabled: false,
	anomalyIntervalMinutes: 15,
	anomalyBaselineWindowMinutes: 1440,
	loopMinRequests: 10,
	cooldownMinutes: 60,
	webhookUrl: "",
};

const LOOP: RunawayLoopGroup = {
	account: "acct",
	model: "model-a",
	project: "proj-a",
	agentUsed: "agent-a",
	windowStartMs: 0,
	windowEndMs: 1,
	requests: 10,
	requestsPerMinute: 10,
	meanRequestSideTokens: 100,
	requestSideTokenSpread: 0,
};

describe("runaway-loop alert identity", () => {
	test("different projects produce distinct exact IDs for the same account, model, and agent", () => {
		const projectA = buildRunawayLoopAlertId(LOOP, 60);
		const projectB = buildRunawayLoopAlertId(
			{ ...LOOP, project: "proj-b" },
			60,
		);

		expect(projectA).toBe("anomaly_runaway_loop:acct:model-a:proj-a:agent-a:0");
		expect(projectB).toBe("anomaly_runaway_loop:acct:model-a:proj-b:agent-a:0");
		expect(projectA).not.toBe(projectB);
	});

	test("repeated evaluations of one group keep a stable cooldown ID", () => {
		const atBucketStart = buildRunawayLoopAlertId(LOOP, 60);
		const atBucketEnd = buildRunawayLoopAlertId(
			{ ...LOOP, windowEndMs: 3_600_000 - 1 },
			60,
		);

		expect(atBucketStart).toBe(atBucketEnd);
	});
});

describe("alert threshold helpers", () => {
	test("buildThresholdAlertId is stable for the cooldown bucket", () => {
		expect(buildThresholdAlertId("request_tokens", "req-1", 123_456, 60)).toBe(
			buildThresholdAlertId("request_tokens", "req-1", 3_600_000 - 1, 60),
		);
		expect(
			buildThresholdAlertId("request_tokens", "req-1", 3_600_000, 60),
		).not.toBe(
			buildThresholdAlertId("request_tokens", "req-1", 3_600_000 - 1, 60),
		);
	});

	test("shouldFireAlert respects disabled and threshold values", () => {
		expect(shouldFireAlert(0, 50)).toBe(false);
		expect(shouldFireAlert(10, 9)).toBe(false);
		expect(shouldFireAlert(10, 10)).toBe(true);
		expect(shouldFireAlert(10, 11)).toBe(true);
	});

	test("buildRequestTokenAlert returns null below threshold", () => {
		expect(
			buildRequestTokenAlert(
				{
					id: "req-1",
					timestamp: "2026-06-10T10:00:00.000Z",
					method: "POST",
					path: "/v1/messages",
					accountUsed: "acct",
					statusCode: 200,
					success: true,
					errorMessage: null,
					responseTimeMs: 100,
					failoverAttempts: 0,
					totalTokens: 49_999,
				},
				CONFIG,
			),
		).toBeNull();
	});

	test("buildRequestTokenAlert emits a critical alert at threshold", () => {
		const alert = buildRequestTokenAlert(
			{
				id: "req-2",
				timestamp: "2026-06-10T10:00:00.000Z",
				method: "POST",
				path: "/v1/messages",
				accountUsed: "acct",
				statusCode: 200,
				success: true,
				errorMessage: null,
				responseTimeMs: 100,
				failoverAttempts: 0,
				model: "model-a",
				project: "proj",
				totalTokens: 50_000,
			},
			CONFIG,
		) as AlertEvent;

		expect(alert.type).toBe("request_tokens");
		expect(alert.severity).toBe("critical");
		expect(alert.value).toBe(50_000);
		expect(alert.threshold).toBe(50_000);
		expect(alert.requestId).toBe("req-2");
		expect(alert.model).toBe("model-a");
		expect(alert.project).toBe("proj");
		expect(alert.acknowledged).toBe(false);
	});
});

describe("evaluateAnomalies leave-one-out contract (issue #410 regression)", () => {
	function makeAnomalyConfig(
		overrides: Partial<{
			anomalyIntervalMinutes: number;
			anomalyBaselineWindowMinutes: number;
			loopMinRequests: number;
		}> = {},
	): Config {
		return Object.assign(new EventEmitter(), {
			getAlertDailySpendUsd: () => 0,
			getAlertTokensPerHour: () => 0,
			getAlertRequestTokens: () => 0,
			getAlertAnomalyEnabled: () => true,
			getAlertAnomalyIntervalMinutes: () =>
				overrides.anomalyIntervalMinutes ?? 30,
			getAlertAnomalyBaselineWindowMinutes: () =>
				overrides.anomalyBaselineWindowMinutes ?? 60,
			getAlertAnomalyLoopMinRequests: () => overrides.loopMinRequests ?? 10_000,
			getAlertCooldownMinutes: () => 60,
			getAlertWebhookUrl: () => "",
		}) as unknown as Config;
	}

	async function seedRequest(
		adapter: BunSqlAdapter,
		row: {
			id: string;
			timestamp: number;
			inputTokens?: number;
			outputTokens?: number;
			model?: string;
		},
	): Promise<void> {
		await adapter.run(
			`INSERT INTO requests
				(id, timestamp, method, path, account_used, status_code, success,
				 response_time_ms, failover_attempts, model, total_tokens, cost_usd,
				 input_tokens, output_tokens, cache_read_input_tokens,
				 cache_creation_input_tokens)
			 VALUES (?, ?, 'POST', '/v1/messages', NULL, 200, 1, 100, 0, ?, ?, 0, ?, ?, 0, 0)`,
			[
				row.id,
				row.timestamp,
				row.model ?? "claude-opus-4-8",
				(row.inputTokens ?? 0) + (row.outputTokens ?? 0),
				row.inputTokens ?? 0,
				row.outputTokens ?? 0,
			],
		);
	}

	test("scoring rows never double as their own baseline population when all rows fall inside the scoring window", async () => {
		// Regression for issue #410: the old code derived scoringRows as a
		// .filter() of the SAME array used as baselineRows, so every scored
		// row was also a member of its own baseline population. This test
		// seeds 20 rows (>= the default minBaselineRequests of 20) ALL inside
		// the scoring window (timestamp >= scoringSince) and NONE older —
		// i.e. baselineRows must come up EMPTY under the disjoint-partition
		// fix. With an empty baseline, computeBaselines produces no baseline
		// entry at all, so NO outlier alert can fire, no matter how extreme
		// one of the scored values is.
		//
		// Under the OLD buggy code, these same 20 rows would ALSO have been
		// used as baselineRows (since baselineRows was the whole fetched
		// window, unfiltered), which would satisfy minBaselineRequests and
		// let the huge spike row flag itself as an outlier against a
		// baseline that includes itself — exactly the contract violation
		// this PR fixes.
		const sqlite = new Database(":memory:");
		ensureSchema(sqlite);
		const adapter = new BunSqlAdapter(sqlite);
		const config = makeAnomalyConfig({
			anomalyIntervalMinutes: 30,
			anomalyBaselineWindowMinutes: 60,
		});
		const service = new AlertService(adapter, config);

		try {
			const now = Date.now();
			// 19 rows with a normal 3-value spread, all within the last 30
			// minutes (inside the scoring window: timestamp >= now - 30min).
			const spreadValues = [80, 100, 130];
			for (let i = 0; i < 19; i++) {
				await seedRequest(adapter, {
					id: `scoring-normal-${i}`,
					timestamp: now - i * 1000,
					inputTokens: spreadValues[i % spreadValues.length],
				});
			}
			// One huge spike, also inside the scoring window.
			await seedRequest(adapter, {
				id: "scoring-spike",
				timestamp: now - 500,
				inputTokens: 100_000,
			});

			await service.evaluateAnomalies();

			const alerts = await service.listAlerts();
			const outlierAlerts = alerts.filter(
				(a) => a.type === "anomaly_token_outlier",
			);
			// No baseline could be formed (0 rows older than scoringSince), so
			// nothing can be flagged — proves scoringRows is no longer a
			// subset of baselineRows.
			expect(outlierAlerts).toHaveLength(0);
		} finally {
			service.stop();
			sqlite.close();
		}
	});

	test("a spike in the scoring window flags only when a genuinely disjoint OLDER baseline exists, and the flagged id is never one of the baseline ids", async () => {
		const sqlite = new Database(":memory:");
		ensureSchema(sqlite);
		const adapter = new BunSqlAdapter(sqlite);
		const config = makeAnomalyConfig({
			anomalyIntervalMinutes: 5,
			anomalyBaselineWindowMinutes: 60,
		});
		const service = new AlertService(adapter, config);

		try {
			const now = Date.now();
			const scoringSince = now - 5 * 60 * 1000;
			const baselineIds: string[] = [];
			// 21 baseline rows, strictly OLDER than the 5-minute scoring
			// window (between 10 and 55 minutes ago), with a 3-value spread
			// for a non-degenerate MAD.
			const spreadValues = [80, 100, 130];
			for (let i = 0; i < 21; i++) {
				const id = `baseline-${i}`;
				baselineIds.push(id);
				await seedRequest(adapter, {
					id,
					timestamp: scoringSince - (10 + i) * 60 * 1000,
					inputTokens: spreadValues[i % spreadValues.length],
				});
			}
			// One spike inside the scoring window (last 5 minutes).
			await seedRequest(adapter, {
				id: "scoring-spike",
				timestamp: now - 1000,
				inputTokens: 100_000,
			});

			await service.evaluateAnomalies();

			const alerts = await service.listAlerts();
			const outlierAlerts = alerts.filter(
				(a) => a.type === "anomaly_token_outlier",
			);
			expect(outlierAlerts).toHaveLength(1);
			expect(outlierAlerts[0]?.requestId).toBe("scoring-spike");
			// The flagged request id must never be one of the ids that fed the
			// baseline population — the two sets are genuinely disjoint.
			expect(baselineIds).not.toContain(outlierAlerts[0]?.requestId);
		} finally {
			service.stop();
			sqlite.close();
		}
	});

	test("a baseline window SHORTER than the scoring interval still produces a non-empty baseline population (issue #410 follow-up review fix)", async () => {
		// Regression: the query window used to be
		// Math.max(baselineWindowMinutes, intervalMinutes), which collapses to
		// just intervalMinutes whenever baselineWindowMinutes <= intervalMinutes
		// (a valid config combination — nothing prevents
		// anomalyBaselineWindowMinutes from being set lower than
		// anomalyIntervalMinutes). That made the query fetch ONLY the scoring
		// interval's worth of history, so every fetched row had
		// timestamp >= scoringSince, baselineRows came up empty, and no
		// outlier could ever be flagged for this config — a silent
		// false-negative regression.
		//
		// Here baseline=30min, interval=120min (baseline < interval). Rows are
		// seeded both inside the scoring window (last 120 minutes) AND further
		// back, within the 30-minute baseline-before-scoring range (i.e.
		// between 120 and 150 minutes ago). Under the fixed additive query
		// window (baselineWindowMinutes + intervalMinutes = 150 minutes), the
		// older rows are fetched and land in baselineRows; under the old
		// Math.max bug they would never even be queried.
		const sqlite = new Database(":memory:");
		ensureSchema(sqlite);
		const adapter = new BunSqlAdapter(sqlite);
		const config = makeAnomalyConfig({
			anomalyIntervalMinutes: 120,
			anomalyBaselineWindowMinutes: 30,
		});
		const service = new AlertService(adapter, config);

		try {
			const now = Date.now();
			const scoringSince = now - 120 * 60 * 1000;
			const baselineIds: string[] = [];
			// 21 baseline rows strictly OLDER than the 120-minute scoring
			// window, within the 30-minute baseline range before it (i.e.
			// between 121 and 149 minutes ago), 3-value spread for a
			// non-degenerate MAD.
			const spreadValues = [80, 100, 130];
			for (let i = 0; i < 21; i++) {
				const id = `baseline-${i}`;
				baselineIds.push(id);
				await seedRequest(adapter, {
					id,
					timestamp: scoringSince - (1 + i) * 60 * 1000,
					inputTokens: spreadValues[i % spreadValues.length],
				});
			}
			// One spike inside the scoring window.
			await seedRequest(adapter, {
				id: "scoring-spike",
				timestamp: now - 1000,
				inputTokens: 100_000,
			});

			await service.evaluateAnomalies();

			const alerts = await service.listAlerts();
			const outlierAlerts = alerts.filter(
				(a) => a.type === "anomaly_token_outlier",
			);
			// A non-empty, genuinely older baseline population must have been
			// available, so the spike is flagged.
			expect(outlierAlerts).toHaveLength(1);
			expect(outlierAlerts[0]?.requestId).toBe("scoring-spike");
			expect(baselineIds).not.toContain(outlierAlerts[0]?.requestId);
		} finally {
			service.stop();
			sqlite.close();
		}
	});
});
