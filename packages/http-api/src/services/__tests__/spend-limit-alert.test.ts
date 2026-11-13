import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { EventEmitter } from "node:events";
import type { Config } from "@better-ccflare/config";
import {
	type AlertEvt,
	alertEvents,
	type SpendLimitExceededEvt,
	spendLimitEvents,
} from "@better-ccflare/core";
import { BunSqlAdapter, ensureSchema } from "@better-ccflare/database";
import { AlertService, buildThresholdAlertId } from "../alerts";

const settleEvents = () =>
	new Promise<void>((resolve) => setImmediate(resolve));

describe("API key warn limit dashboard alerts", () => {
	let sqlite: Database;
	let service: AlertService;
	let emitted: AlertEvt[];
	const listener = (event: AlertEvt) => {
		emitted.push(event);
	};
	const base: SpendLimitExceededEvt = {
		apiKeyId: "key-1",
		apiKeyName: "Key one",
		spentUsd: 8,
		limitUsd: 5,
		window: "day",
	};

	beforeEach(() => {
		sqlite = new Database(":memory:");
		ensureSchema(sqlite);
		const config = Object.assign(new EventEmitter(), {
			getAlertDailySpendUsd: () => 0,
			getAlertTokensPerHour: () => 0,
			getAlertRequestTokens: () => 0,
			getAlertAnomalyEnabled: () => false,
			getAlertAnomalyIntervalMinutes: () => 15,
			getAlertAnomalyBaselineWindowMinutes: () => 1440,
			getAlertAnomalyLoopMinRequests: () => 25,
			getAlertCooldownMinutes: () => 60,
			getAlertWebhookUrl: () => "",
		}) as unknown as Config;
		service = new AlertService(new BunSqlAdapter(sqlite), config);
		emitted = [];
		alertEvents.on("event", listener);
		service.start();
	});
	afterEach(() => {
		service.stop();
		alertEvents.off("event", listener);
		sqlite.close();
	});

	it("persists both warn rows on one key and keeps the cooldown for repeated warnings from each row", async () => {
		spendLimitEvents.emit("event", { ...base, limitId: "daily-limit" });
		spendLimitEvents.emit("event", {
			...base,
			limitId: "opus-month-limit",
			window: "month (opus)",
			limitUsd: 7,
		});
		await settleEvents();
		const alerts = await service.listAlerts();
		expect(alerts).toHaveLength(2);
		expect(new Set(alerts.map((alert) => alert.id)).size).toBe(2);
		expect(alerts.some((alert) => alert.message.includes("month (opus)"))).toBe(
			true,
		);
		expect(emitted).toHaveLength(2);
		for (const limitId of ["daily-limit", "opus-month-limit"])
			spendLimitEvents.emit("event", { ...base, limitId });
		await settleEvents();
		expect(await service.listAlerts()).toHaveLength(2);
		expect(emitted).toHaveLength(2);
	});

	it("retains legacy cooldown identities when no row id is supplied", async () => {
		spendLimitEvents.emit("event", base);
		await settleEvents();
		const alerts = await service.listAlerts();
		expect(alerts).toHaveLength(1);
		expect(alerts[0].id).toBe(
			buildThresholdAlertId(
				"api_key_spend_limit",
				base.apiKeyId,
				alerts[0].timestamp,
				60,
			),
		);
		spendLimitEvents.emit("event", base);
		await settleEvents();
		expect(await service.listAlerts()).toHaveLength(1);
		expect(emitted).toHaveLength(1);
	});
});
