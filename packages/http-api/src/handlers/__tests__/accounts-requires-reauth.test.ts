import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { Config } from "@better-ccflare/config";
import { isAccountAvailable } from "@better-ccflare/core";
import {
	BunSqlAdapter,
	ensureSchema,
	runMigrations,
} from "@better-ccflare/database";
import type { Account, AccountResponse } from "@better-ccflare/types";
import { createAccountsListHandler } from "../accounts";

describe("GET /api/accounts requires_reauth fields", () => {
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
	});

	it("returns ground-truth auth and pause state and does not mark a flagged account primary", async () => {
		await adapter.run(
			`INSERT INTO accounts (
				id, name, provider, refresh_token, access_token, expires_at,
				created_at, paused, pause_reason, requires_reauth
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			[
				"account-1",
				"Account 1",
				"anthropic",
				"refresh-token",
				"access-token",
				Date.now() + 3_600_000,
				Date.now(),
				1,
				"manual",
				1,
			],
		);

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
		const accounts = (await response.json()) as AccountResponse[];

		expect(accounts[0]?.requiresReauth).toBe(true);
		expect(accounts[0]?.pauseReason).toBe("manual");
		expect(accounts[0]?.isPrimary).toBe(false);
	});
});
