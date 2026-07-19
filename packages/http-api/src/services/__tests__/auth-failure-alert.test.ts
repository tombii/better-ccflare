import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { EventEmitter } from "node:events";
import type { Config } from "@better-ccflare/config";
import { alertEvents, authFailureEvents } from "@better-ccflare/core";
import { BunSqlAdapter, ensureSchema } from "@better-ccflare/database";
import { AlertService } from "../alerts";

async function waitFor(predicate: () => boolean): Promise<void> {
	for (let attempt = 0; attempt < 100; attempt++) {
		if (predicate()) return;
		await Bun.sleep(5);
	}
	throw new Error("Timed out waiting for auth-failure alert processing");
}

function makeConfig(): Config {
	return Object.assign(new EventEmitter(), {
		getAlertDailySpendUsd: () => 0,
		getAlertTokensPerHour: () => 0,
		getAlertRequestTokens: () => 0,
		getAlertAnomalyEnabled: () => false,
		getAlertAnomalyIntervalMinutes: () => 15,
		getAlertCooldownMinutes: () => 60,
		getAlertWebhookUrl: () => "http://127.0.0.1:9999/webhook",
	}) as unknown as Config;
}

describe("AlertService auth_failure events", () => {
	let sqlite: Database;
	let service: AlertService;
	let originalFetch: typeof globalThis.fetch;
	let alertListener: ((event: unknown) => void) | null;

	beforeEach(() => {
		sqlite = new Database(":memory:");
		ensureSchema(sqlite);
		service = new AlertService(new BunSqlAdapter(sqlite), makeConfig());
		originalFetch = globalThis.fetch;
		alertListener = null;
	});

	afterEach(() => {
		service.stop();
		globalThis.fetch = originalFetch;
		if (alertListener) {
			alertEvents.off("event", alertListener);
		}
		sqlite.close();
	});

	it("persists, emits, and delivers one critical webhook per cooldown bucket", async () => {
		const fetchMock = mock(
			async () => new Response(null, { status: 204 }),
		) as unknown as typeof fetch;
		globalThis.fetch = fetchMock;
		const emitted: unknown[] = [];
		alertListener = (event) => emitted.push(event);
		alertEvents.on("event", alertListener);
		service.start();

		const event = {
			accountId: "account-1",
			accountName: "Backup account",
			provider: "anthropic",
			reason: "invalid_grant",
		};
		authFailureEvents.emit("event", event);

		await waitFor(() => fetchMock.mock.calls.length === 1);
		const alerts = await service.listAlerts();
		expect(alerts).toHaveLength(1);
		expect(alerts[0]?.type).toBe("auth_failure");
		expect(alerts[0]?.severity).toBe("critical");
		expect(alerts[0]?.account).toBe("Backup account");
		expect(emitted).toHaveLength(1);

		const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
		const webhook = JSON.parse(String(init.body));
		expect(webhook.alert.type).toBe("auth_failure");

		authFailureEvents.emit("event", event);
		await Bun.sleep(20);

		expect(await service.listAlerts()).toHaveLength(1);
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(emitted).toHaveLength(1);
	});
});
