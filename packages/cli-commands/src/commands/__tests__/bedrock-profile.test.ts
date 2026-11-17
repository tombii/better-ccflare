import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, unlinkSync } from "node:fs";
import type { Config } from "@better-ccflare/config";
import type { DatabaseOperations } from "@better-ccflare/database";
import { DatabaseFactory } from "@better-ccflare/database";
import { addAccount } from "../account";

// Invalid AWS profile names must be rejected before any ~/.aws read, so these
// tests do not depend on the home directory.

const TEST_DB_PATH = `${process.env.TMPDIR || "/tmp"}/test-bedrock-profile-cli.db`;

describe("CLI Bedrock profile validation", () => {
	let dbOps: DatabaseOperations;

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
	});

	afterEach(() => {
		DatabaseFactory.reset();
		cleanupDbFiles();
	});

	function countAccounts(): number {
		const row = dbOps
			.getDatabase()
			.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM accounts")
			.get();
		return row?.n ?? 0;
	}

	it("rejects a profile with regex metacharacters and does not insert", async () => {
		await expect(
			addAccount(dbOps, {} as Config, {
				name: "bedrock-wildcard",
				mode: "bedrock",
				profile: "a.*",
			}),
		).rejects.toThrow(/profile/i);
		expect(countAccounts()).toBe(0);
	});

	it("rejects a profile containing ':' and does not insert", async () => {
		await expect(
			addAccount(dbOps, {} as Config, {
				name: "bedrock-colon",
				mode: "bedrock",
				profile: "prod:eu-west-1",
			}),
		).rejects.toThrow(/profile/i);
		expect(countAccounts()).toBe(0);
	});
});
