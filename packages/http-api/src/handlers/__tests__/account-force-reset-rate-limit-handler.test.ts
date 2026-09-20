import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, unlinkSync } from "node:fs";
import type { DatabaseOperations } from "@better-ccflare/database";
import { DatabaseFactory } from "@better-ccflare/database";
import { createAccountForceResetRateLimitHandler } from "../accounts";

// Conventional test pattern (mirrors account-remove-handler.test.ts). Requires
// the generated `inline-*-worker.ts` build artifacts to be present.
const TEST_DB_PATH = `${process.env.TMPDIR || "/tmp"}/test-account-force-reset-rate-limit-handler.db`;

describe("createAccountForceResetRateLimitHandler", () => {
	let dbOps: DatabaseOperations;
	let handler: ReturnType<typeof createAccountForceResetRateLimitHandler>;

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

	beforeEach(() => {
		cleanupDbFiles();
		DatabaseFactory.initialize(TEST_DB_PATH);
		dbOps = DatabaseFactory.getInstance();
		handler = createAccountForceResetRateLimitHandler(dbOps);
	});

	afterEach(() => {
		// Close BEFORE unlinking: deleting the file under an open connection
		// makes close()'s `PRAGMA wal_checkpoint(TRUNCATE)` fail with
		// SQLITE_IOERR_VNODE, surfacing as an unhandled error between tests.
		DatabaseFactory.reset();
		cleanupDbFiles();
	});

	function insertRow(
		id: string,
		name: string,
		overrides: Partial<{
			rate_limited_until: number | null;
			rate_limited_reason: string | null;
			access_token: string | null;
			provider: string;
		}> = {},
	) {
		const {
			rate_limited_until = Date.now() + 60_000,
			rate_limited_reason = "429",
			access_token = null,
			provider = "anthropic",
		} = overrides;
		return dbOps.getAdapter().run(
			`INSERT INTO accounts
				(id, name, provider, refresh_token, created_at, access_token, rate_limited_until, rate_limited_reason)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
			[
				id,
				name,
				provider,
				"rt",
				Date.now(),
				access_token,
				rate_limited_until,
				rate_limited_reason,
			],
		);
	}

	function makeRequest() {
		return new Request(
			"http://localhost/api/accounts/uuid/force-reset-rate-limit",
			{ method: "POST" },
		) as unknown as Request;
	}

	it("returns 404 when the account does not exist", async () => {
		const response = await handler(makeRequest(), "missing-id");
		expect(response.status).toBe(404);
	});

	it("clears rate-limit fields for the targeted account", async () => {
		await insertRow("uuid-1", "alpha");

		const response = await handler(makeRequest(), "uuid-1");
		expect(response.ok).toBe(true);

		const body = (await response.json()) as {
			success: boolean;
			usagePollTriggered: boolean;
		};
		expect(body.success).toBe(true);
		// No polling/token provider registered for this account in the test
		// process, so refreshNow() short-circuits to false and the Anthropic
		// fallback is skipped because access_token is null.
		expect(body.usagePollTriggered).toBe(false);

		const row = await dbOps.getAdapter().get<{
			rate_limited_until: number | null;
			rate_limited_reason: string | null;
		}>(
			"SELECT rate_limited_until, rate_limited_reason FROM accounts WHERE id = ?",
			["uuid-1"],
		);
		expect(row?.rate_limited_until).toBeNull();
		expect(row?.rate_limited_reason).toBeNull();
	});

	it("does not clear rate-limit state on accounts it wasn't targeted at", async () => {
		await insertRow("uuid-2", "beta");
		await insertRow("uuid-3", "gamma");

		const response = await handler(makeRequest(), "uuid-2");
		expect(response.ok).toBe(true);

		const untouched = await dbOps
			.getAdapter()
			.get<{ rate_limited_until: number | null }>(
				"SELECT rate_limited_until FROM accounts WHERE id = ?",
				["uuid-3"],
			);
		expect(untouched?.rate_limited_until).not.toBeNull();
	});
});
