import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { Config } from "@better-ccflare/config";
import { isAccountAvailable } from "@better-ccflare/core";
import {
	BunSqlAdapter,
	ensureSchema,
	runMigrations,
} from "@better-ccflare/database";
import { usageCache } from "@better-ccflare/providers";
import type { Account, AccountResponse } from "@better-ccflare/types";
import { createAccountsListHandler } from "../accounts";

/**
 * The proxy drops usage-capped accounts before strategy.select() runs
 * (getOrderedAccounts in proxy/src/handlers/account-selector.ts), so a capped
 * account gets no traffic until its window resets. isPrimary comes from
 * strategy.peek(), so peek() must not see those accounts either. Otherwise a
 * capped top account keeps isPrimary (and the dashboard "next" badge) while
 * every request goes to the next routable account.
 */
describe("GET /api/accounts isPrimary skips usage-capped accounts", () => {
	let sqlite: Database;
	let adapter: BunSqlAdapter;

	beforeEach(() => {
		sqlite = new Database(":memory:");
		ensureSchema(sqlite);
		runMigrations(sqlite);
		adapter = new BunSqlAdapter(sqlite);
	});

	afterEach(() => {
		sqlite.close();
		usageCache.delete("capped");
		usageCache.delete("routable");
	});

	async function insertAccount(id: string, priority: number): Promise<void> {
		const now = Date.now();
		await adapter.run(
			`INSERT INTO accounts (
				id, name, provider, refresh_token, access_token, expires_at,
				created_at, paused, priority
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			[
				id,
				id,
				"anthropic",
				"refresh-token",
				"access-token",
				now + 3_600_000,
				now,
				0,
				priority,
			],
		);
	}

	function weeklyUsage(utilization: number, resetInMs: number) {
		return {
			five_hour: { utilization: 0, resets_at: null },
			seven_day: {
				utilization,
				resets_at: new Date(Date.now() + resetInMs).toISOString(),
			},
		};
	}

	async function listAccounts(): Promise<AccountResponse[]> {
		const dbOps = {
			getAdapter: () => adapter,
			getStatsRepository: () => ({
				getSessionStats: async () => new Map(),
			}),
		};
		const config = {
			getUsageThrottlingFiveHourEnabled: () => false,
			getUsageThrottlingWeeklyEnabled: () => false,
		} as unknown as Config;
		// Like the real strategies, this peek() knows nothing about usage: it
		// returns the first available account in the order it is given.
		const strategy = {
			peek: (accounts: Account[]) =>
				accounts.find((account) => isAccountAvailable(account))?.id ?? null,
		};
		const handler = createAccountsListHandler(
			dbOps as never,
			config,
			() => strategy as never,
		);
		const response = await handler();
		return (await response.json()) as AccountResponse[];
	}

	it("marks the next routable account primary when the first candidate is usage-capped", async () => {
		// The handler's query orders by priority DESC, so "capped" is the first
		// candidate peek() sees. It is not paused, re-auth flagged or rate
		// limited: only its 100% weekly window keeps the router away from it.
		await insertAccount("capped", 100);
		await insertAccount("routable", 50);
		usageCache.set("capped", weeklyUsage(100, 3_600_000));
		usageCache.set("routable", weeklyUsage(20, 3_600_000));

		const accounts = await listAccounts();
		const capped = accounts.find((a) => a.id === "capped");
		const routable = accounts.find((a) => a.id === "routable");

		// The same row already reports the cap, so isPrimary must agree with it.
		expect(capped?.rateLimitStatus.startsWith("usage_exhausted")).toBe(true);
		expect(capped?.isPrimary).toBe(false);
		expect(routable?.isPrimary).toBe(true);
	});

	it("keeps an account primary when its 100% snapshot predates the window reset", async () => {
		// A known reset in the past means the snapshot is stale. The router does
		// not treat that as exhausted (isUsageExhausted), so neither may peek().
		await insertAccount("capped", 100);
		await insertAccount("routable", 50);
		usageCache.set("capped", weeklyUsage(100, -60_000));
		usageCache.set("routable", weeklyUsage(20, 3_600_000));

		const accounts = await listAccounts();

		expect(accounts.find((a) => a.id === "capped")?.isPrimary).toBe(true);
		expect(accounts.find((a) => a.id === "routable")?.isPrimary).toBe(false);
	});
});
