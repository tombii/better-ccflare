import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { Config } from "@better-ccflare/config";
import {
	BunSqlAdapter,
	ensureSchema,
	runMigrations,
} from "@better-ccflare/database";
import { usageCache } from "@better-ccflare/providers";
import type { AccountResponse } from "@better-ccflare/types";
import { createAccountsListHandler } from "../accounts";

/**
 * Codex has no usage-polling endpoint, so its weekly percentage only ever
 * arrives on a real response. These tests cover the two halves of the fix:
 * the durable `usage_snapshots` fallback that survives a restart, and the
 * refusal to invent 0% for a window nobody reported.
 */

const ACCOUNT_ID = "codex-acct";
const CONFIG = {
	getUsageThrottlingFiveHourEnabled: () => false,
	getUsageThrottlingWeeklyEnabled: () => false,
} as unknown as Config;

describe("GET /api/accounts — Codex weekly usage recovery", () => {
	let sqlite: Database;
	let adapter: BunSqlAdapter;

	beforeEach(async () => {
		sqlite = new Database(":memory:");
		ensureSchema(sqlite);
		runMigrations(sqlite);
		adapter = new BunSqlAdapter(sqlite);
		// The cache is module-level and shared across tests in the process.
		usageCache.delete(ACCOUNT_ID);
		await adapter.run(
			`INSERT INTO accounts (
				id, name, provider, refresh_token, access_token, expires_at, created_at
			) VALUES (?, ?, ?, ?, ?, ?, ?)`,
			[
				ACCOUNT_ID,
				"Codex 1",
				"codex",
				"refresh-token",
				"access-token",
				Date.now() + 3_600_000,
				Date.now(),
			],
		);
	});

	afterEach(() => {
		usageCache.delete(ACCOUNT_ID);
		sqlite.close();
	});

	function makeHandler(
		latestSnapshot: {
			accountId: string;
			timestamp: number;
			windowKey: string;
			utilization: number;
			resetsAt: number | null;
		} | null,
	) {
		const dbOps = {
			getAdapter: () => adapter,
			getStatsRepository: () => ({
				getSessionStats: async () => new Map(),
			}),
			getLatestUsageSnapshot: async (accountId: string, windowKey: string) =>
				latestSnapshot &&
				latestSnapshot.accountId === accountId &&
				latestSnapshot.windowKey === windowKey
					? latestSnapshot
					: null,
		};
		return createAccountsListHandler(dbOps as never, CONFIG);
	}

	async function readAccount(
		handler: () => Promise<Response>,
	): Promise<AccountResponse | undefined> {
		const response = await handler();
		const accounts = (await response.json()) as AccountResponse[];
		return accounts.find((a) => a.id === ACCOUNT_ID);
	}

	it("falls back to the persisted weekly snapshot when cache and payloads are empty", async () => {
		const account = await readAccount(
			makeHandler({
				accountId: ACCOUNT_ID,
				timestamp: Date.now() - 60_000,
				windowKey: "seven_day",
				utilization: 63,
				resetsAt: Date.now() + 3 * 24 * 60 * 60 * 1000,
			}),
		);

		const usage = account?.usageData as {
			five_hour: { utilization: number | null };
			seven_day: { utilization: number | null };
		} | null;
		expect(usage?.seven_day.utilization).toBe(63);
		// The 5-hour window was never reported: unknown, not zero.
		expect(usage?.five_hour.utilization).toBeNull();
		expect(account?.usageUtilization).toBe(63);
	});

	it("keeps a weekly snapshot whose reset was not stored", async () => {
		// A snapshot with resetsAt null is still a real percentage — the gate must
		// not require a reset to accept it.
		const account = await readAccount(
			makeHandler({
				accountId: ACCOUNT_ID,
				timestamp: Date.now() - 60_000,
				windowKey: "seven_day",
				utilization: 47,
				resetsAt: null,
			}),
		);

		const usage = account?.usageData as {
			seven_day: { utilization: number | null; resets_at: string | null };
		} | null;
		expect(usage?.seven_day.utilization).toBe(47);
		expect(usage?.seven_day.resets_at).toBeNull();
	});

	it("reports no usage data at all rather than a fake 0% when nothing was ever recorded", async () => {
		const account = await readAccount(makeHandler(null));
		expect(account?.usageData).toBeNull();
		expect(account?.usageUtilization).toBeNull();
	});

	it("marks a window absent from the cache as unknown, not 0%", async () => {
		usageCache.set(ACCOUNT_ID, {
			five_hour: {
				utilization: 20,
				resets_at: new Date(Date.now() + 3_600_000).toISOString(),
			},
		} as never);

		const account = await readAccount(makeHandler(null));
		const usage = account?.usageData as {
			five_hour: { utilization: number | null };
			seven_day: { utilization: number | null };
		} | null;
		expect(usage?.five_hour.utilization).toBe(20);
		expect(usage?.seven_day.utilization).toBeNull();
	});

	it("treats an expired window as unknown instead of carrying its stale number", async () => {
		usageCache.set(ACCOUNT_ID, {
			five_hour: {
				utilization: 88,
				resets_at: new Date(Date.now() - 3_600_000).toISOString(),
			},
			seven_day: {
				utilization: 51,
				resets_at: new Date(Date.now() + 86_400_000).toISOString(),
			},
		} as never);

		const account = await readAccount(makeHandler(null));
		const usage = account?.usageData as {
			five_hour: { utilization: number | null };
			seven_day: { utilization: number | null };
		} | null;
		expect(usage?.five_hour.utilization).toBeNull();
		expect(usage?.seven_day.utilization).toBe(51);
	});

	/** Epoch SECONDS, as the `x-codex-*-reset-at` headers carry them. */
	const futureResetSeconds = () => Math.floor((Date.now() + 3_600_000) / 1000);

	/**
	 * Store a request + its payload so the handler's stored-payload recovery
	 * step (the one between the in-memory cache and the usage_snapshots
	 * fallback) has something to reparse.
	 */
	async function storePayload(
		headers: Record<string, string>,
		status: number,
	): Promise<void> {
		const timestamp = Date.now() - 30_000;
		const requestId = `req-${status}-${timestamp}`;
		await adapter.run(
			`INSERT INTO requests (id, timestamp, method, path, account_used, status_code)
			 VALUES (?, ?, ?, ?, ?, ?)`,
			[requestId, timestamp, "POST", "/v1/messages", ACCOUNT_ID, status],
		);
		await adapter.run(
			`INSERT INTO request_payloads (id, json, timestamp) VALUES (?, ?, ?)`,
			[
				requestId,
				JSON.stringify({
					response: { status, headers },
					meta: { timestamp },
				}),
				timestamp,
			],
		);
	}

	it("does not recover a 0% five-hour window from a stored 200 payload that carries only a reset", async () => {
		// A reset time says when the window rolls over, never how much was used.
		await storePayload(
			{
				"x-codex-primary-window-minutes": "300",
				"x-codex-primary-reset-at": String(futureResetSeconds()),
			},
			200,
		);

		const account = await readAccount(makeHandler(null));
		const usage = account?.usageData as {
			five_hour?: { utilization: number | null };
		} | null;
		expect(usage?.five_hour?.utilization ?? null).toBeNull();
		expect(account?.usageUtilization).toBeNull();
	});

	it("keeps the reported weekly percentage while leaving the reset-only five-hour window unknown", async () => {
		await storePayload(
			{
				"x-codex-primary-window-minutes": "300",
				"x-codex-primary-reset-at": String(futureResetSeconds()),
				"x-codex-secondary-window-minutes": String(7 * 24 * 60),
				"x-codex-secondary-used-percent": "42",
				"x-codex-secondary-reset-at": String(
					Math.floor((Date.now() + 3 * 24 * 60 * 60 * 1000) / 1000),
				),
			},
			200,
		);

		const account = await readAccount(makeHandler(null));
		const usage = account?.usageData as {
			five_hour: { utilization: number | null };
			seven_day: { utilization: number | null };
		} | null;
		expect(usage?.seven_day.utilization).toBe(42);
		expect(usage?.five_hour.utilization).toBeNull();
	});

	it("still recovers 100% from a stored 429 payload that carries only a reset", async () => {
		// A 429 with reset-only headers is a real "exhausted" signal.
		await storePayload(
			{
				"x-codex-primary-window-minutes": "300",
				"x-codex-primary-reset-at": String(futureResetSeconds()),
			},
			429,
		);

		const account = await readAccount(makeHandler(null));
		const usage = account?.usageData as {
			five_hour: { utilization: number | null };
		} | null;
		expect(usage?.five_hour.utilization).toBe(100);
	});
});
