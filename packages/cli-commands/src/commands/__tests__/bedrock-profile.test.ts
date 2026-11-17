import {
	afterAll,
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	mock,
} from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config } from "@better-ccflare/config";
import type { DatabaseOperations } from "@better-ccflare/database";
import { DatabaseFactory } from "@better-ccflare/database";
import { addAccount } from "../account";

// Invalid AWS profile names must be rejected before any ~/.aws read. A fixture
// home dir with a credentials file proves the rejection is the validation, not
// a missing ~/.aws.

const TEST_DB_PATH = `${process.env.TMPDIR || "/tmp"}/test-bedrock-profile-cli.db`;
const PROFILE_PATTERN_ERROR =
	/Profile names can only contain letters, numbers, dots, hyphens, and underscores/;

// mock.module is process-wide in Bun, so spread the real module and restore
// it afterwards for other test files sharing the process.
const actualOs = await import("node:os");
let fakeHome: string | null = null;

mock.module("node:os", () => ({
	...actualOs,
	homedir: () => fakeHome ?? actualOs.homedir(),
}));

afterAll(() => {
	mock.module("node:os", () => actualOs);
});

describe("CLI Bedrock profile validation", () => {
	let dbOps: DatabaseOperations;
	let homeDir: string;

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
		// An explicit DB path also skips DatabaseFactory's legacy-db migration,
		// which would otherwise stat the (absent) real ~/.config.
		process.env.BETTER_CCFLARE_DB_PATH = TEST_DB_PATH;
		cleanupDbFiles();
		DatabaseFactory.initialize(TEST_DB_PATH);
		dbOps = DatabaseFactory.getInstance();

		homeDir = mkdtempSync(join(tmpdir(), "ccflare-bedrock-cli-home-"));
		mkdirSync(join(homeDir, ".aws"));
		writeFileSync(
			join(homeDir, ".aws", "credentials"),
			"[my.profile]\naws_access_key_id = A\n\n[myxprofile]\naws_access_key_id = B\n",
		);
		writeFileSync(
			join(homeDir, ".aws", "config"),
			"[profile my.profile]\nregion = eu-west-1\n\n[profile myxprofile]\nregion = us-west-2\n",
		);
		fakeHome = homeDir;
	});

	afterEach(() => {
		delete process.env.BETTER_CCFLARE_DB_PATH;
		fakeHome = null;
		DatabaseFactory.reset();
		cleanupDbFiles();
		rmSync(homeDir, { recursive: true, force: true });
	});

	function countAccounts(): number {
		const row = dbOps
			.getDatabase()
			.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM accounts")
			.get();
		return row?.n ?? 0;
	}

	it("accepts a dotted profile and stores its exact section", async () => {
		await addAccount(dbOps, {} as Config, {
			name: "bedrock-dotted",
			mode: "bedrock",
			profile: "my.profile",
		});
		const row = dbOps
			.getDatabase()
			.query<{ custom_endpoint: string }, []>(
				"SELECT custom_endpoint FROM accounts WHERE name = 'bedrock-dotted'",
			)
			.get();
		expect(row?.custom_endpoint).toBe("bedrock:my.profile:eu-west-1");
	});

	it("rejects a profile with regex metacharacters and does not insert", async () => {
		await expect(
			addAccount(dbOps, {} as Config, {
				name: "bedrock-wildcard",
				mode: "bedrock",
				profile: "a.*",
			}),
		).rejects.toThrow(PROFILE_PATTERN_ERROR);
		expect(countAccounts()).toBe(0);
	});

	it("rejects a profile containing ':' and does not insert", async () => {
		await expect(
			addAccount(dbOps, {} as Config, {
				name: "bedrock-colon",
				mode: "bedrock",
				profile: "prod:eu-west-1",
			}),
		).rejects.toThrow(PROFILE_PATTERN_ERROR);
		expect(countAccounts()).toBe(0);
	});
});
