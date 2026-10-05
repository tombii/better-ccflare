import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { Config } from "@better-ccflare/config";
import { setUseExtraUsage } from "@better-ccflare/core";
import {
	BunSqlAdapter,
	ensureSchema,
	runMigrations,
} from "@better-ccflare/database";
import { usageCache } from "@better-ccflare/providers";
import type { AccountResponse } from "@better-ccflare/types";
import { createAccountsListHandler } from "../accounts";

/**
 * GET /api/accounts must show a Codex account the way routing treats it. With
 * "Use Extra Usage" on, a spent weekly window with credits left is served, so
 * the account reads `extra_usage`, not `usage_exhausted`, and is not shown as
 * throttled. The Codex display path normalizes usage before labelling it, and
 * that normalization must keep the credits it was handed — from the cache and
 * from a stored payload alike.
 */

const ACCOUNT_ID = "codex-acct";
const WEEKLY_RESET = () => new Date(Date.now() + 3 * 24 * 3_600_000);

function configWith(weeklyThrottling: boolean): Config {
	return {
		getUsageThrottlingFiveHourEnabled: () => false,
		getUsageThrottlingWeeklyEnabled: () => weeklyThrottling,
	} as unknown as Config;
}

describe("GET /api/accounts — Codex account on extra usage", () => {
	let sqlite: Database;
	let adapter: BunSqlAdapter;

	beforeEach(async () => {
		sqlite = new Database(":memory:");
		ensureSchema(sqlite);
		runMigrations(sqlite);
		adapter = new BunSqlAdapter(sqlite);
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
		setUseExtraUsage(false);
		usageCache.delete(ACCOUNT_ID);
		sqlite.close();
	});

	async function readAccount(config: Config): Promise<AccountResponse> {
		const dbOps = {
			getAdapter: () => adapter,
			getStatsRepository: () => ({
				getSessionStats: async () => new Map(),
			}),
			getLatestUsageSnapshot: async () => null,
		};
		const response = await createAccountsListHandler(dbOps as never, config)();
		const accounts = (await response.json()) as AccountResponse[];
		const account = accounts.find((a) => a.id === ACCOUNT_ID);
		if (!account) throw new Error("account missing from /api/accounts");
		return account;
	}

	function cacheSpentWeeklyWithCredits() {
		usageCache.set(ACCOUNT_ID, {
			seven_day: { utilization: 100, resets_at: WEEKLY_RESET().toISOString() },
			credits: { has_credits: true, unlimited: false, balance: "12" },
		} as never);
	}

	it("labels a cached spent account with credits as usage_exhausted while the switch is off", async () => {
		cacheSpentWeeklyWithCredits();
		const account = await readAccount(configWith(false));
		expect(account.rateLimitStatus).toStartWith("usage_exhausted");
	});

	it("labels the same cached account extra_usage once the switch is on", async () => {
		cacheSpentWeeklyWithCredits();
		setUseExtraUsage(true);
		const account = await readAccount(configWith(false));
		expect(account.rateLimitStatus).toStartWith("extra_usage");
	});

	it("does not show the account as throttled when throttling is on and credits serve it", async () => {
		cacheSpentWeeklyWithCredits();
		setUseExtraUsage(true);
		const account = await readAccount(configWith(true));
		expect(account.usageThrottledUntil).toBeNull();
		expect(account.usageThrottledWindows).toEqual([]);
	});

	it("keeps credits recovered from a stored payload for the label too", async () => {
		const timestamp = Date.now() - 30_000;
		const requestId = `req-${timestamp}`;
		await adapter.run(
			`INSERT INTO requests (id, timestamp, method, path, account_used, status_code)
			 VALUES (?, ?, ?, ?, ?, ?)`,
			[requestId, timestamp, "POST", "/v1/messages", ACCOUNT_ID, 200],
		);
		await adapter.run(
			`INSERT INTO request_payloads (id, json, timestamp) VALUES (?, ?, ?)`,
			[
				requestId,
				JSON.stringify({
					response: {
						status: 200,
						headers: {
							"x-codex-primary-window-minutes": "10080",
							"x-codex-primary-used-percent": "100",
							"x-codex-primary-reset-at": String(
								Math.floor(WEEKLY_RESET().getTime() / 1000),
							),
							"x-codex-credits-has-credits": "true",
							"x-codex-credits-unlimited": "false",
						},
					},
					meta: { timestamp },
				}),
				timestamp,
			],
		);
		setUseExtraUsage(true);

		const account = await readAccount(configWith(false));
		expect(account.rateLimitStatus).toStartWith("extra_usage");
	});
});
