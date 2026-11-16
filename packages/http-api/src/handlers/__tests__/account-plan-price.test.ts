import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, unlinkSync } from "node:fs";
import type { Config } from "@better-ccflare/config";
import type { DatabaseOperations } from "@better-ccflare/database";
import { DatabaseFactory } from "@better-ccflare/database";
import type { AccountResponse } from "@better-ccflare/types";
import {
	createAccountPlanPriceHandler,
	createAccountsListHandler,
} from "../accounts";

const TEST_DB_PATH = `${process.env.TMPDIR || "/tmp"}/test-account-plan-price.db`;

const ACCOUNT_ID = "acct-plan-price";

describe("POST /api/accounts/:id/plan-price", () => {
	let dbOps: DatabaseOperations;
	let handler: (req: Request, accountId: string) => Promise<Response>;

	function cleanupDbFiles() {
		for (const suffix of ["", "-wal", "-shm"]) {
			try {
				const p = `${TEST_DB_PATH}${suffix}`;
				if (existsSync(p)) unlinkSync(p);
			} catch {
				// best-effort cleanup
			}
		}
	}

	beforeEach(async () => {
		cleanupDbFiles();
		DatabaseFactory.initialize(TEST_DB_PATH);
		dbOps = DatabaseFactory.getInstance();
		handler = createAccountPlanPriceHandler(dbOps);

		await dbOps.getAdapter().run(
			`INSERT INTO accounts (id, name, provider, refresh_token, access_token, created_at)
				 VALUES (?, ?, ?, ?, ?, ?)`,
			[ACCOUNT_ID, "plan-price", "anthropic", "r1", "a1", Date.now()],
		);
	});

	afterEach(() => {
		// Close BEFORE unlinking: deleting the file under an open connection
		// makes close()'s `PRAGMA wal_checkpoint(TRUNCATE)` fail with
		// SQLITE_IOERR_VNODE, which surfaces as an unhandled error between
		// tests and can leave the next beforeEach unable to open the database.
		DatabaseFactory.reset();
		cleanupDbFiles();
	});

	function makeRequest(body: unknown) {
		return new Request(
			`http://localhost/api/accounts/${ACCOUNT_ID}/plan-price`,
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(body),
			},
		) as unknown as Request;
	}

	async function storedPrice(id = ACCOUNT_ID): Promise<number | null> {
		const row = await dbOps
			.getAdapter()
			.get<{ plan_monthly_usd: number | null }>(
				"SELECT plan_monthly_usd FROM accounts WHERE id = ?",
				[id],
			);
		return row ? row.plan_monthly_usd : null;
	}

	it("accepts a valid number and persists it", async () => {
		const res = await handler(
			makeRequest({ planMonthlyUsd: 200.5 }),
			ACCOUNT_ID,
		);
		expect(res.status).toBe(200);

		const body = (await res.json()) as { planMonthlyUsd: number | null };
		expect(body.planMonthlyUsd).toBe(200.5);
		expect(await storedPrice()).toBe(200.5);
	});

	it("accepts 0 as a real price rather than treating it as unset", async () => {
		const res = await handler(makeRequest({ planMonthlyUsd: 0 }), ACCOUNT_ID);
		expect(res.status).toBe(200);
		expect(await storedPrice()).toBe(0);
	});

	it("accepts null to clear the price", async () => {
		await handler(makeRequest({ planMonthlyUsd: 20 }), ACCOUNT_ID);
		expect(await storedPrice()).toBe(20);

		const res = await handler(
			makeRequest({ planMonthlyUsd: null }),
			ACCOUNT_ID,
		);
		expect(res.status).toBe(200);
		expect(await storedPrice()).toBeNull();
	});

	it("rejects a negative number", async () => {
		const res = await handler(makeRequest({ planMonthlyUsd: -1 }), ACCOUNT_ID);
		expect(res.status).toBe(400);
		expect(await storedPrice()).toBeNull();
	});

	it("rejects NaN", async () => {
		// JSON has no NaN literal, so NaN can only reach the handler from a
		// non-JSON caller: hand it a Request whose json() resolves to an object
		// carrying an actual NaN.
		const req = {
			json: async () => ({ planMonthlyUsd: Number.NaN }),
		} as unknown as Request;

		const res = await handler(req, ACCOUNT_ID);
		expect(res.status).toBe(400);
		expect(await storedPrice()).toBeNull();
	});

	it("rejects Infinity", async () => {
		const req = {
			json: async () => ({ planMonthlyUsd: Number.POSITIVE_INFINITY }),
		} as unknown as Request;

		const res = await handler(req, ACCOUNT_ID);
		expect(res.status).toBe(400);
		expect(await storedPrice()).toBeNull();
	});

	it("rejects a non-numeric type", async () => {
		const res = await handler(
			makeRequest({ planMonthlyUsd: "200" }),
			ACCOUNT_ID,
		);
		expect(res.status).toBe(400);
		expect(await storedPrice()).toBeNull();
	});

	it("rejects a missing planMonthlyUsd field", async () => {
		const res = await handler(makeRequest({}), ACCOUNT_ID);
		expect(res.status).toBe(400);
		expect(await storedPrice()).toBeNull();
	});

	it("returns 404 for an unknown account id", async () => {
		const res = await handler(
			makeRequest({ planMonthlyUsd: 20 }),
			"does-not-exist",
		);
		expect(res.status).toBe(404);
	});

	it("round-trips through the account repository", async () => {
		await dbOps.setAccountPlanMonthlyUsd(ACCOUNT_ID, 123.45);
		expect((await dbOps.getAccount(ACCOUNT_ID))?.plan_monthly_usd).toBe(123.45);

		// 0 must survive the row -> domain coercion (toNumOrNull would collapse it).
		await dbOps.setAccountPlanMonthlyUsd(ACCOUNT_ID, 0);
		expect((await dbOps.getAccount(ACCOUNT_ID))?.plan_monthly_usd).toBe(0);

		await dbOps.setAccountPlanMonthlyUsd(ACCOUNT_ID, null);
		expect((await dbOps.getAccount(ACCOUNT_ID))?.plan_monthly_usd).toBeNull();
	});

	it("appears in the GET /api/accounts response", async () => {
		const config = {
			getUsageThrottlingFiveHourEnabled: () => false,
			getUsageThrottlingWeeklyEnabled: () => false,
		} as unknown as Config;
		const listHandler = createAccountsListHandler(dbOps, config);

		const before = (await (await listHandler()).json()) as AccountResponse[];
		expect(before[0]?.planMonthlyUsd).toBeNull();

		await handler(makeRequest({ planMonthlyUsd: 100 }), ACCOUNT_ID);

		const after = (await (await listHandler()).json()) as AccountResponse[];
		expect(after[0]?.planMonthlyUsd).toBe(100);
	});
});
