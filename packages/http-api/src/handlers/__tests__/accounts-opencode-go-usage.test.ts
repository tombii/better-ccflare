import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { Config } from "@better-ccflare/config";
import {
	BunSqlAdapter,
	ensureSchema,
	RequestRepository,
	runMigrations,
} from "@better-ccflare/database";
import { usageCache } from "@better-ccflare/providers";
import type { AccountResponse } from "@better-ccflare/types";
import { createAccountsListHandler } from "../accounts";

/**
 * GET /api/accounts must surface OpenCode Go usage: the representative window
 * (the most exhausted of 5h / weekly / monthly) and the full payload for the
 * dashboard.
 */

const ACCOUNT_ID = "opencode-go-acct";

function config(): Config {
	return {
		getUsageThrottlingFiveHourEnabled: () => false,
		getUsageThrottlingWeeklyEnabled: () => false,
	} as unknown as Config;
}

describe("GET /api/accounts — OpenCode Go usage display", () => {
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
				"OpenCode Go 1",
				"opencode-go",
				"oc-key",
				"oc-key",
				Date.now() + 3_600_000,
				Date.now(),
			],
		);
	});

	afterEach(() => {
		usageCache.delete(ACCOUNT_ID);
		sqlite.close();
	});

	async function readAccount(): Promise<AccountResponse> {
		const dbOps = {
			getAdapter: () => adapter,
			getRequestPayload: (id: string) =>
				new RequestRepository(adapter).getPayload(id),
			getStatsRepository: () => ({
				getSessionStats: async () => new Map(),
			}),
			getLatestUsageSnapshot: async () => null,
		};
		const response = await createAccountsListHandler(
			dbOps as never,
			config(),
		)();
		const accounts = (await response.json()) as AccountResponse[];
		const account = accounts.find((a) => a.id === ACCOUNT_ID);
		if (!account) throw new Error("account missing from /api/accounts");
		return account;
	}

	it("reports the most exhausted window and the full payload", async () => {
		usageCache.set(ACCOUNT_ID, {
			five_hour: { utilization: 3, resets_at: "2026-11-14T15:03:46.000Z" },
			seven_day: { utilization: 19, resets_at: "2026-11-16T00:00:00.000Z" },
			monthly: { utilization: 74, resets_at: "2026-11-15T04:29:48.000Z" },
		} as never);

		const account = await readAccount();

		expect(account.usageUtilization).toBe(74);
		expect(account.usageWindow).toBe("monthly");
		expect(account.usageData).toMatchObject({
			five_hour: { utilization: 3 },
			seven_day: { utilization: 19 },
			monthly: { utilization: 74, resets_at: "2026-11-15T04:29:48.000Z" },
		});
	});

	it("reports null utilization when no usage has been polled", async () => {
		const account = await readAccount();

		expect(account.usageUtilization).toBeNull();
		expect(account.usageData).toBeNull();
	});
});
