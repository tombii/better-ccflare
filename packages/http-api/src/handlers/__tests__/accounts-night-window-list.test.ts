import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { Config } from "@better-ccflare/config";
import {
	BunSqlAdapter,
	ensureSchema,
	runMigrations,
} from "@better-ccflare/database";
import type { AccountResponse } from "@better-ccflare/types";
import { createAccountsListHandler } from "../accounts";

/**
 * The dashboard's night-window switch reads `nightWindowEnabled` off the
 * accounts list. If the list omits it, the switch always renders off and every
 * click sends `true`, so the feature can be turned on but never off.
 */
describe("GET /api/accounts nightWindowEnabled field", () => {
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

	async function list(): Promise<AccountResponse[]> {
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
		const handler = createAccountsListHandler(dbOps as never, config);
		return (await (await handler()).json()) as AccountResponse[];
	}

	async function insert(name: string, nightWindow: number) {
		await adapter.run(
			`INSERT INTO accounts (id, name, provider, refresh_token, access_token, expires_at, created_at, night_window_enabled)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
			[
				name,
				name,
				"sailresearch",
				"r",
				"a",
				Date.now() + 3_600_000,
				Date.now(),
				nightWindow,
			],
		);
	}

	it("reports the saved flag as a boolean", async () => {
		await insert("sail-on", 1);
		await insert("sail-off", 0);

		const accounts = await list();
		const on = accounts.find((a) => a.id === "sail-on") as
			| (AccountResponse & { nightWindowEnabled?: boolean })
			| undefined;
		const off = accounts.find((a) => a.id === "sail-off") as
			| (AccountResponse & { nightWindowEnabled?: boolean })
			| undefined;

		expect(on?.nightWindowEnabled).toBe(true);
		expect(off?.nightWindowEnabled).toBe(false);
	});

	it("defaults to false rather than undefined", async () => {
		await insert("sail-default", 0);
		const accounts = await list();
		const account = accounts[0] as AccountResponse & {
			nightWindowEnabled?: boolean;
		};
		expect(account.nightWindowEnabled).toBe(false);
	});
});
