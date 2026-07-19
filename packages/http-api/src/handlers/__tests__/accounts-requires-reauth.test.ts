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

	it("excludes a flagged-but-otherwise-healthy account from isPrimary (requires_reauth alone blocks routing)", async () => {
		// The first test's flagged account is also paused=1, so its isPrimary=false
		// would hold even if requires_reauth were never threaded into peek(). Here the
		// flagged account is NOT paused and NOT rate-limited, and it has the HIGHER
		// priority (so ORDER BY makes it the first peek candidate) — the only reason
		// it must not be primary is the requires_reauth flag itself.
		const baseTs = Date.now();
		await adapter.run(
			`INSERT INTO accounts (
				id, name, provider, refresh_token, access_token, expires_at,
				created_at, paused, pause_reason, requires_reauth, priority
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			[
				"dead-auth",
				"Dead auth",
				"anthropic",
				"refresh-token",
				"access-token",
				baseTs + 3_600_000,
				baseTs,
				0,
				null,
				1,
				100,
			],
		);
		await adapter.run(
			`INSERT INTO accounts (
				id, name, provider, refresh_token, access_token, expires_at,
				created_at, paused, pause_reason, requires_reauth, priority
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			[
				"healthy",
				"Healthy",
				"anthropic",
				"refresh-token",
				"access-token",
				baseTs + 3_600_000,
				baseTs,
				0,
				null,
				0,
				50,
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
		const dead = accounts.find((a) => a.id === "dead-auth");
		const healthy = accounts.find((a) => a.id === "healthy");

		expect(dead?.requiresReauth).toBe(true);
		expect(dead?.isPrimary).toBe(false);
		// The healthy, lower-priority account must be picked instead, proving the
		// flag (not pause/rate-limit) is what removed the dead account from routing.
		expect(healthy?.isPrimary).toBe(true);
	});
});
