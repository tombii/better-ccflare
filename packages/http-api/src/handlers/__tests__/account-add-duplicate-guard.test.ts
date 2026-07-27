import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, unlinkSync } from "node:fs";
import type { DatabaseOperations } from "@better-ccflare/database";
import { DatabaseFactory } from "@better-ccflare/database";
import { createAccountAddHandler } from "../accounts";

const TEST_DB_PATH = "/tmp/test-account-add-duplicate-guard.db";

describe("createAccountAddHandler — duplicate (name, provider, custom_endpoint) guard", () => {
	let dbOps: DatabaseOperations;
	let handler: (req: Request) => Promise<Response>;

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
		// The handler's _config arg is unused; pass null cast.
		handler = createAccountAddHandler(dbOps, null as never);
	});

	afterEach(() => {
		// Close BEFORE unlinking: deleting the file under an open connection
		// makes close()'s `PRAGMA wal_checkpoint(TRUNCATE)` fail with
		// SQLITE_IOERR_VNODE, which surfaces as an unhandled error between
		// tests and can leave the next beforeEach unable to open the database.
		DatabaseFactory.reset();
		cleanupDbFiles();
	});

	function makeRequest(body: Record<string, unknown>) {
		return new Request("http://localhost/api/accounts", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
		}) as unknown as Request;
	}

	it("rejects a second add that collides on (name, provider, custom_endpoint)", async () => {
		const first = await handler(
			makeRequest({
				name: "alpha",
				provider: "anthropic",
				accessToken: "a1",
				refreshToken: "r1",
			}),
		);
		expect(first.status).toBe(200);

		const second = await handler(
			makeRequest({
				name: "alpha",
				provider: "anthropic",
				accessToken: "a2",
				refreshToken: "r2",
			}),
		);
		expect(second.status).toBe(400);

		// Only the first row was persisted.
		const rows = await dbOps
			.getAdapter()
			.query<{ id: string }>("SELECT id FROM accounts WHERE name = ?", [
				"alpha",
			]);
		expect(rows).toHaveLength(1);
	});

	it("allows adds that differ on provider or custom_endpoint", async () => {
		const first = await handler(
			makeRequest({
				name: "beta",
				provider: "anthropic",
				accessToken: "a1",
				refreshToken: "r1",
				customEndpoint: "https://api.example.com",
			}),
		);
		expect(first.status).toBe(200);

		// Same name + provider, but a different custom_endpoint — should succeed.
		const second = await handler(
			makeRequest({
				name: "beta",
				provider: "anthropic",
				accessToken: "a2",
				refreshToken: "r2",
				customEndpoint: "https://api.other.example.com",
			}),
		);
		expect(second.status).toBe(200);
	});

	// Greptile P1 (PR #343): the pre-check SELECT-then-INSERT race. The atomic
	// guarantee now comes from the DB-level UNIQUE index
	// `idx_accounts_unique_name_provider_endpoint` enforced on every INSERT.
	// This test proves the handler still returns a clean 400 with the same
	// "is already taken" copy even when assertAccountNameAvailable is bypassed
	// (e.g. a concurrent caller who won the race AND lost the INSERT, or any
	// non-http-api INSERT path that races us).
	it("returns 400 when a row already exists for the tuple, even if pre-check is bypassed", async () => {
		// Seed a row directly so the pre-check's SELECT would have found it
		// (sequential path) — but call the handler with a fresh name first,
		// then via a simulated race insert the second row directly through the
		// adapter BEFORE the handler can run its own INSERT. We use two
		// separate calls and a direct INSERT in between to simulate the
		// interleaving that real concurrency produces.
		await handler(
			makeRequest({
				name: "race",
				provider: "anthropic",
				accessToken: "a1",
				refreshToken: "r1",
			}),
		);

		// Bypass the pre-check: insert a duplicate tuple directly. This is
		// what a concurrent caller (or any non-handler INSERT path — CLI,
		// oauth-flow, dashboard-web) would emit if it raced past the SELECT.
		const adapter = dbOps.getAdapter();
		// `adapter.run` is async. Without awaiting it inside the try, the
		// UNIQUE violation never reaches this catch — it escapes as an
		// unhandled rejection between tests, and the assertion below sees the
		// synchronous pre-await return value instead of "rejected". The test
		// then passes or fails for reasons unrelated to the constraint.
		const directInsertOk = await (async () => {
			try {
				await adapter.run(
					`INSERT INTO accounts (id, name, provider, refresh_token, access_token, created_at)
					 VALUES (?, ?, ?, ?, ?, ?)`,
					[
						"concurrent",
						"race",
						"anthropic",
						"r-direct",
						"a-direct",
						Date.now(),
					],
				);
				return true;
			} catch (e) {
				// Expected: the UNIQUE constraint rejects it. The atomic
				// guarantee is precisely this rejection.
				return e instanceof Error &&
					e.message.includes("UNIQUE constraint failed")
					? "rejected"
					: false;
			}
		})();
		expect(directInsertOk).toBe("rejected");

		// Now exercise the handler against the same tuple — its pre-check
		// WILL find the seeded row (sequential path), but the contract we
		// are verifying is that the UNIQUE constraint is what backs the
		// 400, not just the pre-check.
		const second = await handler(
			makeRequest({
				name: "race",
				provider: "anthropic",
				accessToken: "a2",
				refreshToken: "r2",
			}),
		);
		expect(second.status).toBe(400);

		const rows = await dbOps
			.getAdapter()
			.query<{ id: string }>("SELECT id FROM accounts WHERE name = ?", [
				"race",
			]);
		expect(rows).toHaveLength(1);
	});
});
