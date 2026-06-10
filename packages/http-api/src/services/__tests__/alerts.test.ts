import { describe, expect, test } from "bun:test";
import type { AlertEvent, AlertsConfigPayload } from "@better-ccflare/types";
import {
	buildRequestTokenAlert,
	buildThresholdAlertId,
	shouldFireAlert,
} from "../alerts";

const CONFIG: AlertsConfigPayload = {
	dailySpendUsd: 10,
	tokensPerHour: 100_000,
	requestTokens: 50_000,
	anomalyEnabled: false,
	anomalyIntervalMinutes: 15,
	cooldownMinutes: 60,
	webhookUrl: "",
};

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
