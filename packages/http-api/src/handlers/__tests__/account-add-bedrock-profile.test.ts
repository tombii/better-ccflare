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
import type { DatabaseOperations } from "@better-ccflare/database";
import { DatabaseFactory } from "@better-ccflare/database";
import { createBedrockAccountAddHandler } from "../accounts";

// The AWS profile name is interpolated into a RegExp when reading
// ~/.aws/credentials and into the "bedrock:profile:region" custom_endpoint.
// Metacharacters must be rejected before either happens. A fixture home dir
// with a credentials file proves the rejection is the validation, not a
// missing ~/.aws.

const TEST_DB_PATH = `${process.env.TMPDIR || "/tmp"}/test-account-add-bedrock-profile.db`;
const PROFILE_PATTERN_ERROR =
	"profile can only contain letters, numbers, dots, hyphens, and underscores";

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

describe("POST /api/accounts/bedrock profile validation", () => {
	let dbOps: DatabaseOperations;
	let handler: (req: Request) => Promise<Response>;
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
		handler = createBedrockAccountAddHandler(dbOps);

		homeDir = mkdtempSync(join(tmpdir(), "ccflare-bedrock-home-"));
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

	it("accepts a dotted profile and stores its exact section", async () => {
		const res = await handler(
			makeRequest({
				name: "bedrock-dotted",
				profile: "my.profile",
				region: "us-east-1",
			}),
		);
		expect(res.status).toBe(200);
		const row = dbOps
			.getDatabase()
			.query<{ custom_endpoint: string }, []>(
				"SELECT custom_endpoint FROM accounts WHERE name = 'bedrock-dotted'",
			)
			.get();
		expect(row?.custom_endpoint).toBe("bedrock:my.profile:us-east-1");
	});

	it("rejects a regex-metacharacter profile with the validation error and stores nothing", async () => {
		const res = await handler(
			makeRequest({
				name: "bedrock-wildcard",
				profile: "a.*",
				region: "us-east-1",
			}),
		);
		expect(res.status).toBe(400);
		expect(await res.json()).toEqual({ error: PROFILE_PATTERN_ERROR });
		expect(countAccounts()).toBe(0);
	});

	it("rejects a profile containing ':' with the validation error and stores nothing", async () => {
		const res = await handler(
			makeRequest({
				name: "bedrock-colon",
				profile: "prod:eu-west-1",
				region: "us-east-1",
			}),
		);
		expect(res.status).toBe(400);
		expect(await res.json()).toEqual({ error: PROFILE_PATTERN_ERROR });
		expect(countAccounts()).toBe(0);
	});
});
