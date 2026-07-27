import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, unlinkSync } from "node:fs";
import type { DatabaseOperations } from "@better-ccflare/database";
import { DatabaseFactory } from "@better-ccflare/database";
import { createAccountAddHandler } from "../accounts";

const TEST_DB_PATH = "/tmp/test-account-add-duplicate-guard.db";

describe("createAccountAddHandler — duplicate (name, provider, custom_endpoint) guard", () => {
	let dbOps: DatabaseOperations;
	let handler: (req: Request) => Promise<Response>;

	beforeEach(() => {
		try {
			if (existsSync(TEST_DB_PATH)) unlinkSync(TEST_DB_PATH);
		} catch {
			// best-effort cleanup
		}
		DatabaseFactory.initialize(TEST_DB_PATH);
		dbOps = DatabaseFactory.getInstance();
		// The handler's _config arg is unused; pass null cast.
		handler = createAccountAddHandler(dbOps, null as never);
	});

	afterEach(() => {
		try {
			if (existsSync(TEST_DB_PATH)) unlinkSync(TEST_DB_PATH);
		} catch {
			// best-effort cleanup
		}
		DatabaseFactory.reset();
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
});
