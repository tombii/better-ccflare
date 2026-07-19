import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { EventEmitter } from "node:events";
import type { Config } from "@better-ccflare/config";
import { alertEvents, authFailureEvents } from "@better-ccflare/core";
import type { BunSqlAdapter as BunSqlAdapterType } from "@better-ccflare/database";
import { BunSqlAdapter, ensureSchema } from "@better-ccflare/database";
import type { RequestResponse } from "@better-ccflare/types";
import { AlertService } from "../alerts";

async function waitFor(predicate: () => boolean): Promise<void> {
	for (let attempt = 0; attempt < 100; attempt++) {
		if (predicate()) return;
		await Bun.sleep(5);
	}
	throw new Error("Timed out waiting for auth-failure alert processing");
}

function makeConfig(
	overrides: Partial<{
		requestTokens: number;
		webhookUrl: string;
	}> = {},
): Config {
	return Object.assign(new EventEmitter(), {
		getAlertDailySpendUsd: () => 0,
		getAlertTokensPerHour: () => 0,
		getAlertRequestTokens: () => overrides.requestTokens ?? 0,
		getAlertAnomalyEnabled: () => false,
		getAlertAnomalyIntervalMinutes: () => 15,
		getAlertCooldownMinutes: () => 60,
		getAlertWebhookUrl: () =>
			overrides.webhookUrl ?? "http://127.0.0.1:9999/webhook",
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

/**
 * Fake adapter that records the SQL sent to `.run()`. Simulates the PostgreSQL
 * dialect (isSQLite === false) so we can assert the dialect-aware conflict
 * clause without a live PG server.
 */
class RecordingPgAdapter implements BunSqlAdapterType {
	readonly isSQLite = false;
	readonly runStatements: string[] = [];

	async get<T>(_sql: string, _params?: unknown[]): Promise<T | null> {
		return null;
	}
	async query<T>(_sql: string, _params?: unknown[]): Promise<T[]> {
		return [];
	}
	async run(sql: string, _params?: unknown[]): Promise<void> {
		this.runStatements.push(sql);
		// Reject if the caller sent SQLite-only syntax — mirrors PG's behavior.
		if (/INSERT OR IGNORE/i.test(sql)) {
			throw new Error('syntax error at or near "OR"');
		}
	}
}

/**
 * Fake adapter that always fails on `.run()`, to verify a persistence failure
 * is swallowed and never rejects the event-handler promise (which would crash
 * the proxy — the original v3.5.40 incident).
 */
class FailingPgAdapter extends RecordingPgAdapter {
	async run(_sql: string, _params?: unknown[]): Promise<void> {
		throw new Error("simulated PG outage");
	}
}

describe("AlertService persistAndEmit (issue #326)", () => {
	let originalFetch: typeof globalThis.fetch;

	beforeEach(() => {
		originalFetch = globalThis.fetch;
		globalThis.fetch = mock(
			async () => new Response(null, { status: 204 }),
		) as unknown as typeof fetch;
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	function makeHighTokenRequest(): RequestResponse {
		return {
			id: "req-1",
			timestamp: new Date().toISOString(),
			method: "POST",
			path: "/v1/messages",
			accountUsed: "account-1",
			statusCode: 200,
			success: true,
			errorMessage: null,
			responseTimeMs: 100,
			failoverAttempts: 0,
			model: "claude-3",
			totalTokens: 1_000_000,
			inputTokens: 1_000_000,
			cacheReadInputTokens: 0,
			cacheCreationInputTokens: 0,
			outputTokens: 0,
			costUsd: 0,
			project: null,
		};
	}

	it("uses PostgreSQL ON CONFLICT syntax instead of INSERT OR IGNORE", async () => {
		const adapter = new RecordingPgAdapter();
		const service = new AlertService(
			adapter as unknown as BunSqlAdapterType,
			makeConfig({ requestTokens: 1 }),
		);
		service.start();
		try {
			await service.evaluateRequest(makeHighTokenRequest());
			const insertStmt = adapter.runStatements.find((s) =>
				/INTO alerts/.test(s),
			);
			expect(insertStmt).toBeDefined();
			expect(insertStmt).toMatch(/ON CONFLICT\s*\(id\)\s*DO NOTHING/i);
			expect(insertStmt).not.toMatch(/INSERT OR IGNORE/i);
		} finally {
			service.stop();
		}
	});

	it("swallows persistence failures instead of crashing the proxy", async () => {
		const adapter = new FailingPgAdapter();
		const service = new AlertService(
			adapter as unknown as BunSqlAdapterType,
			makeConfig({ requestTokens: 1 }),
		);
		service.start();
		try {
			// Must not throw — the listener is invoked from an async event
			// handler whose rejection would crash Bun with exit code 1.
			await expect(
				service.evaluateRequest(makeHighTokenRequest()),
			).resolves.toBeUndefined();
		} finally {
			service.stop();
		}
	});
});
