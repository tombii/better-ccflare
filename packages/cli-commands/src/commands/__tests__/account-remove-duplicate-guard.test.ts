import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, unlinkSync } from "node:fs";
import type { DatabaseOperations } from "@better-ccflare/database";
import { DatabaseFactory } from "@better-ccflare/database";
import { removeAccount, removeAccountById } from "../account";

// Conventional test pattern (mirrors kilo.test.ts) — uses DatabaseFactory
// against a temporary file. Requires the generated `inline-*-worker.ts`
// build artifacts to be present; run `bun run build` or the project's
// CI build step before executing.
const TEST_DB_PATH = "/tmp/test-remove-duplicate-guard.db";

function insertAccount(
	dbOps: DatabaseOperations,
	row: { id: string; name: string; provider?: string },
) {
	const db = dbOps.getAdapter();
	return db.run(
		`INSERT INTO accounts (id, name, provider, refresh_token, created_at)
		 VALUES (?, ?, ?, ?, ?)`,
		[row.id, row.name, row.provider ?? "anthropic", "rt", Date.now()],
	);
}

describe("removeAccountById / removeAccount duplicate-name safety", () => {
	let dbOps: DatabaseOperations;

	beforeEach(() => {
		try {
			if (existsSync(TEST_DB_PATH)) unlinkSync(TEST_DB_PATH);
		} catch {
			// best-effort cleanup
		}
		DatabaseFactory.initialize(TEST_DB_PATH);
		dbOps = DatabaseFactory.getInstance();
	});

	afterEach(() => {
		try {
			if (existsSync(TEST_DB_PATH)) unlinkSync(TEST_DB_PATH);
		} catch {
			// best-effort cleanup
		}
		DatabaseFactory.reset();
	});

	it("removeAccountById deletes the targeted row only", async () => {
		await insertAccount(dbOps, { id: "id-a", name: "alpha" });
		await insertAccount(dbOps, { id: "id-b", name: "alpha" });

		const result = await removeAccountById(dbOps, "id-a");
		expect(result.success).toBe(true);

		const remaining = await dbOps
			.getAdapter()
			.query<{ id: string }>(
				"SELECT id FROM accounts WHERE name = ? ORDER BY id",
				["alpha"],
			);
		expect(remaining.map((r) => r.id)).toEqual(["id-b"]);
	});

	it("removeAccountById returns failure for an unknown id", async () => {
		const result = await removeAccountById(dbOps, "missing-id");
		expect(result.success).toBe(false);
	});

	it("removeAccount refuses to delete when the name matches multiple accounts", async () => {
		await insertAccount(dbOps, { id: "id-a", name: "shared" });
		await insertAccount(dbOps, { id: "id-b", name: "shared" });

		const result = await removeAccount(dbOps, "shared");
		expect(result.success).toBe(false);
		expect(result.message).toMatch(/multiple/i);

		// No row was deleted.
		const stillThere = await dbOps
			.getAdapter()
			.query<{ id: string }>(
				"SELECT id FROM accounts WHERE name = ? ORDER BY id",
				["shared"],
			);
		expect(stillThere.map((r) => r.id)).toEqual(["id-a", "id-b"]);
	});

	it("removeAccount deletes a single match by id", async () => {
		await insertAccount(dbOps, { id: "id-only", name: "unique" });

		const result = await removeAccount(dbOps, "unique");
		expect(result.success).toBe(true);

		const remaining = await dbOps
			.getAdapter()
			.query<{ id: string }>("SELECT id FROM accounts WHERE name = ?", [
				"unique",
			]);
		expect(remaining).toHaveLength(0);
	});

	it("removeAccount returns not-found for an unknown name", async () => {
		const result = await removeAccount(dbOps, "missing");
		expect(result.success).toBe(false);
		expect(result.message).toMatch(/not found/i);
	});
});
