import { Database } from "bun:sqlite";
import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	setSystemTime,
} from "bun:test";
import type { Config } from "@better-ccflare/config";
import {
	BunSqlAdapter,
	ensureSchema,
	runMigrations,
} from "@better-ccflare/database";
import type { AccountResponse } from "@better-ccflare/types";
import { createAccountsListHandler } from "../accounts";

describe("GET /api/accounts peakHours field", () => {
	let sqlite: Database;
	let adapter: BunSqlAdapter;

	beforeEach(() => {
		sqlite = new Database(":memory:");
		ensureSchema(sqlite);
		runMigrations(sqlite);
		adapter = new BunSqlAdapter(sqlite);
	});

	afterEach(() => {
		setSystemTime();
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

	async function insert(name: string, provider: string) {
		await adapter.run(
			`INSERT INTO accounts (id, name, provider, refresh_token, access_token, expires_at, created_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?)`,
			[name, name, provider, "r", "a", Date.now() + 3_600_000, Date.now()],
		);
	}

	it("computes peak state per provider and null for others", async () => {
		await insert("ds", "deepseek");
		await insert("zai", "zai");
		await insert("an", "anthropic");
		await insert("oc", "openai-compatible");

		// Wed 2026-09-23 02:00 UTC: deepseek peak, zai/anthropic off-peak
		setSystemTime(new Date(Date.UTC(2026, 8, 23, 2, 0)));
		let byName = Object.fromEntries((await list()).map((a) => [a.name, a]));
		expect(byName.ds?.peakHours).toEqual({ active: true });
		expect(byName.zai?.peakHours).toEqual({ active: false });
		expect(byName.an?.peakHours).toEqual({ active: false });
		expect(byName.oc?.peakHours).toBeNull();

		// Wed 15:00 UTC: anthropic peak
		setSystemTime(new Date(Date.UTC(2026, 8, 23, 15, 0)));
		byName = Object.fromEntries((await list()).map((a) => [a.name, a]));
		expect(byName.an?.peakHours).toEqual({ active: true });
		expect(byName.ds?.peakHours).toEqual({ active: false });
	});
});
