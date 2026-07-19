import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config } from "@better-ccflare/config";
import type { DatabaseOperations } from "@better-ccflare/database";
import { DatabaseFactory } from "@better-ccflare/database";
import type { PromptAdapter } from "../../prompts";
import { addAccount, reauthenticateAccount } from "../account";

const DEFAULT_XAI_TOKEN_TTL_MS = 6 * 60 * 60 * 1000;

const config = {} as Config;
const quietAdapter: PromptAdapter = {
	async select(_question, options) {
		return (options.find((option) => option.value === "no") ?? options[0])
			.value;
	},
	async input() {
		return "";
	},
	async confirm() {
		return true;
	},
};

describe("CLI xAI account import", () => {
	let dbOps: DatabaseOperations;
	let dbPath: string;
	let homeDir: string;
	let grokAuthPath: string;
	let previousGrokAuthPath: string | undefined;

	beforeEach(() => {
		const suffix = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
		dbPath = join(tmpdir(), `test-xai-cli-${suffix}.db`);
		homeDir = join(tmpdir(), `test-xai-home-${suffix}`);
		grokAuthPath = join(homeDir, ".grok", "auth.json");
		mkdirSync(join(homeDir, ".grok"), { recursive: true });

		previousGrokAuthPath = process.env.BETTER_CCFLARE_GROK_AUTH_PATH;
		process.env.BETTER_CCFLARE_GROK_AUTH_PATH = grokAuthPath;

		DatabaseFactory.initialize(dbPath);
		dbOps = DatabaseFactory.getInstance();
	});

	afterEach(() => {
		DatabaseFactory.reset();
		if (previousGrokAuthPath === undefined) {
			delete process.env.BETTER_CCFLARE_GROK_AUTH_PATH;
		} else {
			process.env.BETTER_CCFLARE_GROK_AUTH_PATH = previousGrokAuthPath;
		}
		for (const path of [dbPath, `${dbPath}-shm`, `${dbPath}-wal`, homeDir]) {
			if (existsSync(path)) {
				rmSync(path, { recursive: true, force: true });
			}
		}
	});

	it("uses the refresh fallback TTL when imported Grok auth has no readable expiry", async () => {
		writeGrokAuth({
			key: "access-token-create",
			refresh_token: "refresh-token-create",
		});

		const before = Date.now();
		await addAccount(dbOps, config, {
			name: "xai-create",
			mode: "xai",
			priority: 50,
			adapter: quietAdapter,
		});
		const after = Date.now();

		const account = dbOps
			.getDatabase()
			.query<
				{ access_token: string; refresh_token: string; expires_at: number },
				[string]
			>(
				"SELECT access_token, refresh_token, expires_at FROM accounts WHERE name = ?",
			)
			.get("xai-create");

		expect(account).toBeDefined();
		expect(account?.access_token).toBe("access-token-create");
		expect(account?.refresh_token).toBe("refresh-token-create");
		expect(account?.expires_at).toBeGreaterThanOrEqual(
			before + DEFAULT_XAI_TOKEN_TTL_MS,
		);
		expect(account?.expires_at).toBeLessThanOrEqual(
			after + DEFAULT_XAI_TOKEN_TTL_MS,
		);
	});

	it("uses the refresh fallback TTL when re-imported Grok auth has no readable expiry", async () => {
		writeGrokAuth({
			key: "access-token-original",
			refresh_token: "refresh-token-original",
			expires_at: new Date(Date.now() + 60_000).toISOString(),
		});
		await addAccount(dbOps, config, {
			name: "xai-reauth",
			mode: "xai",
			priority: 50,
			adapter: quietAdapter,
		});

		writeGrokAuth({
			key: "access-token-reauth",
			refresh_token: "refresh-token-reauth",
		});

		const before = Date.now();
		const result = await reauthenticateAccount(dbOps, config, "xai-reauth");
		const after = Date.now();

		expect(result.success).toBe(true);
		const account = dbOps
			.getDatabase()
			.query<
				{
					access_token: string;
					refresh_token: string;
					expires_at: number;
					refresh_token_issued_at: number | null;
					requires_reauth: number;
				},
				[string]
			>(
				"SELECT access_token, refresh_token, expires_at, refresh_token_issued_at, requires_reauth FROM accounts WHERE name = ?",
			)
			.get("xai-reauth");

		expect(account).toBeDefined();
		expect(account?.access_token).toBe("access-token-reauth");
		expect(account?.refresh_token).toBe("refresh-token-reauth");
		expect(account?.expires_at).toBeGreaterThanOrEqual(
			before + DEFAULT_XAI_TOKEN_TTL_MS,
		);
		expect(account?.expires_at).toBeLessThanOrEqual(
			after + DEFAULT_XAI_TOKEN_TTL_MS,
		);
		expect(account?.requires_reauth).toBe(0);
		expect(account?.refresh_token_issued_at).toBeGreaterThanOrEqual(before);
		expect(account?.refresh_token_issued_at).toBeLessThanOrEqual(after);
	});

	function writeGrokAuth(entry: {
		key: string;
		refresh_token: string;
		expires_at?: string;
	}) {
		writeFileSync(
			grokAuthPath,
			JSON.stringify({ "test@example.com": entry }),
			"utf8",
		);
	}
});
