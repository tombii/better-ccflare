import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, unlinkSync } from "node:fs";
import type { DatabaseOperations } from "@better-ccflare/database";
import { DatabaseFactory } from "@better-ccflare/database";
import { createBedrockAccountAddHandler } from "../accounts";

// The AWS profile name is interpolated into a RegExp when reading
// ~/.aws/credentials and into the "bedrock:profile:region" custom_endpoint.
// Metacharacters must be rejected before either happens.

const TEST_DB_PATH = `${process.env.TMPDIR || "/tmp"}/test-account-add-bedrock-profile.db`;

describe("POST /api/accounts/bedrock profile validation", () => {
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
		handler = createBedrockAccountAddHandler(dbOps);
	});

	afterEach(() => {
		DatabaseFactory.reset();
		cleanupDbFiles();
	});

	function makeRequest(body: Record<string, unknown>) {
		return new Request("http://localhost/api/accounts/bedrock", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
		}) as unknown as Request;
	}

	function countAccounts(): number {
		const row = dbOps
			.getDatabase()
			.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM accounts")
			.get();
		return row?.n ?? 0;
	}

	it("rejects a regex-metacharacter profile with 400 and stores nothing", async () => {
		const res = await handler(
			makeRequest({
				name: "bedrock-wildcard",
				profile: "a.*",
				region: "us-east-1",
			}),
		);
		expect(res.status).toBe(400);
		expect(countAccounts()).toBe(0);
	});

	it("rejects a profile containing ':' with 400 and stores nothing", async () => {
		const res = await handler(
			makeRequest({
				name: "bedrock-colon",
				profile: "prod:eu-west-1",
				region: "us-east-1",
			}),
		);
		expect(res.status).toBe(400);
		expect(countAccounts()).toBe(0);
	});
});
