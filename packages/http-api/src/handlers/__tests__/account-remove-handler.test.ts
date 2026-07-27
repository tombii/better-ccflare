import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, unlinkSync } from "node:fs";
import * as cliCommands from "@better-ccflare/cli-commands";
import type { DatabaseOperations } from "@better-ccflare/database";
import { DatabaseFactory } from "@better-ccflare/database";
import { createAccountRemoveHandler } from "../accounts";

// Conventional test pattern (mirrors kilo.test.ts). Requires the
// generated `inline-*-worker.ts` build artifacts to be present.
const TEST_DB_PATH = "/tmp/test-account-remove-handler.db";

describe("createAccountRemoveHandler — id-scoped delete", () => {
	let dbOps: DatabaseOperations;
	let handler: ReturnType<typeof createAccountRemoveHandler>;

	beforeEach(() => {
		try {
			if (existsSync(TEST_DB_PATH)) unlinkSync(TEST_DB_PATH);
		} catch {
			// best-effort cleanup
		}
		DatabaseFactory.initialize(TEST_DB_PATH);
		dbOps = DatabaseFactory.getInstance();
		handler = createAccountRemoveHandler(dbOps);
	});

	afterEach(() => {
		try {
			if (existsSync(TEST_DB_PATH)) unlinkSync(TEST_DB_PATH);
		} catch {
			// best-effort cleanup
		}
		DatabaseFactory.reset();
	});

	function insertRow(id: string, name: string) {
		return dbOps.getAdapter().run(
			`INSERT INTO accounts (id, name, provider, refresh_token, created_at)
			 VALUES (?, ?, ?, ?, ?)`,
			[id, name, "anthropic", "rt", Date.now()],
		);
	}

	function makeRequest(confirm: string) {
		return new Request("http://localhost/api/accounts", {
			method: "DELETE",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ confirm }),
		}) as unknown as Request;
	}

	it("deletes by id when confirm matches the stored name", async () => {
		await insertRow("uuid-1", "alpha");
		const result = await cliCommands.removeAccountById(dbOps, "uuid-1");
		expect(result.success).toBe(true);

		// Re-create the row so we can exercise the HTTP handler in full.
		await insertRow("uuid-2", "beta");
		const response = await handler(makeRequest("beta"), "uuid-2");
		expect(response.ok).toBe(true);

		const remaining = await dbOps
			.getAdapter()
			.query<{ id: string }>("SELECT id FROM accounts", []);
		expect(remaining.map((r) => r.id)).toEqual(["uuid-1"]);
	});

	it("returns 404 when the id does not exist", async () => {
		const response = await handler(makeRequest("anything"), "missing-id");
		expect(response.status).toBe(404);
	});

	it("returns 400 when the confirm string does not match the stored name", async () => {
		await insertRow("uuid-3", "gamma");
		const response = await handler(makeRequest("not-the-name"), "uuid-3");
		expect(response.status).toBe(400);

		// Row must still exist.
		const remaining = await dbOps
			.getAdapter()
			.query<{ id: string }>("SELECT id FROM accounts WHERE id = ?", [
				"uuid-3",
			]);
		expect(remaining).toHaveLength(1);
	});

	it("does NOT cascade-delete rows that share a name when one id is targeted", async () => {
		// Reproduces the original bug: a name-keyed delete used to wipe every
		// row sharing the name. After the fix, the HTTP handler only ever
		// deletes the row whose id was in the URL.
		await insertRow("uuid-4", "shared");
		await insertRow("uuid-5", "shared");

		const response = await handler(makeRequest("shared"), "uuid-4");
		expect(response.ok).toBe(true);

		const remaining = await dbOps
			.getAdapter()
			.query<{ id: string }>(
				"SELECT id FROM accounts WHERE name = ? ORDER BY id",
				["shared"],
			);
		expect(remaining.map((r) => r.id)).toEqual(["uuid-5"]);
	});
});
