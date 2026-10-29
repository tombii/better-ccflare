import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, unlinkSync } from "node:fs";
import type { DatabaseOperations } from "@better-ccflare/database";
import { DatabaseFactory } from "@better-ccflare/database";
import {
	registerPollingRestarter,
	unregisterPollingRestarter,
} from "@better-ccflare/proxy";
import { createAccountAddHandler } from "../accounts";

// POST /api/accounts used to accept only "anthropic" and store every other
// provider as an Anthropic account. These tests pin the fixed behaviour: any
// known provider is accepted and the secret lands in the column the provider
// actually reads from (api_key for key-based providers, the token pair for
// OAuth providers).

const TEST_DB_PATH = `${process.env.TMPDIR || "/tmp"}/test-account-add-generic-provider.db`;
const SERVER_ID = "test-account-add-generic-provider-server";
const ONE_YEAR_MS = 365 * 24 * 60 * 60 * 1000;

interface StoredAccount {
	provider: string;
	api_key: string | null;
	access_token: string | null;
	refresh_token: string | null;
	expires_at: number | null;
}

describe("POST /api/accounts with a generic provider", () => {
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
		handler = createAccountAddHandler(dbOps, null as never);
		// Best-effort polling restart runs after the insert; a no-op restarter
		// keeps it from reaching any runtime.
		registerPollingRestarter(SERVER_ID, async () => true);
	});

	afterEach(() => {
		unregisterPollingRestarter(SERVER_ID);
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

	function getStoredAccount(name: string): StoredAccount | null {
		const db = dbOps.getDatabase();
		return (
			db
				.query<StoredAccount, [string]>(
					"SELECT provider, api_key, access_token, refresh_token, expires_at FROM accounts WHERE name = ?",
				)
				.get(name) ?? null
		);
	}

	function countAccounts(): number {
		const db = dbOps.getDatabase();
		const row = db
			.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM accounts")
			.get();
		return row?.n ?? 0;
	}

	async function expectKeyAccountStored(
		provider: "nanogpt" | "openrouter",
		apiKey: string,
	) {
		const name = `${provider}-generic`;
		const before = Date.now();
		const res = await handler(makeRequest({ name, provider, apiKey }));
		expect(res.status).toBe(200);
		const payload = (await res.json()) as {
			success: boolean;
			message: string;
			accountId: string;
		};
		expect(payload.success).toBe(true);
		expect(payload.message).toContain("added successfully");

		const row = getStoredAccount(name);
		expect(row).not.toBeNull();
		if (!row) return;
		// The provider selector must survive; previously this became anthropic.
		expect(row.provider).toBe(provider);
		// The secret is stored where the provider reads it, verbatim.
		expect(row.api_key).toBe(apiKey);
		expect(row.access_token).toBeNull();
		expect(row.refresh_token).toBeNull();
		// Static key accounts get the "never expires" sentinel, ~1 year ahead.
		expect(row.expires_at).not.toBeNull();
		if (row.expires_at !== null) {
			const expected = before + ONE_YEAR_MS;
			expect(row.expires_at).toBeGreaterThanOrEqual(expected);
			expect(row.expires_at).toBeLessThanOrEqual(Date.now() + ONE_YEAR_MS);
		}
	}

	it("stores a nanogpt account's apiKey in api_key with null tokens and a ~1 year expiry", async () => {
		await expectKeyAccountStored("nanogpt", "sk-nanogpt-generic-key");
	});

	it("stores an openrouter account's apiKey in api_key with null tokens and a ~1 year expiry", async () => {
		await expectKeyAccountStored("openrouter", "sk-or-generic-key");
	});

	it("stores an anthropic account's token pair with api_key and expires_at null", async () => {
		const res = await handler(
			makeRequest({
				name: "anthropic-generic",
				provider: "anthropic",
				accessToken: "at-generic",
				refreshToken: "rt-generic",
			}),
		);
		expect(res.status).toBe(200);

		const row = getStoredAccount("anthropic-generic");
		expect(row).not.toBeNull();
		if (!row) return;
		expect(row.provider).toBe("anthropic");
		expect(row.api_key).toBeNull();
		expect(row.access_token).toBe("at-generic");
		expect(row.refresh_token).toBe("rt-generic");
		expect(row.expires_at).toBeNull();
	});

	it("rejects a key provider without apiKey and inserts no row", async () => {
		const res = await handler(
			makeRequest({
				name: "nanogpt-no-key",
				provider: "nanogpt",
				accessToken: "at-generic",
				refreshToken: "rt-generic",
			}),
		);
		expect(res.status).toBe(400);
		const payload = (await res.json()) as { error: string };
		expect(payload.error).toContain("apiKey");

		expect(getStoredAccount("nanogpt-no-key")).toBeNull();
		expect(countAccounts()).toBe(0);
	});

	it("rejects a token provider given only apiKey and inserts no row", async () => {
		const res = await handler(
			makeRequest({
				name: "anthropic-key-only",
				provider: "anthropic",
				apiKey: "sk-only-a-key",
			}),
		);
		expect(res.status).toBe(400);
		const payload = (await res.json()) as { error: string };
		expect(payload.error).toContain("accessToken");

		expect(getStoredAccount("anthropic-key-only")).toBeNull();
		expect(countAccounts()).toBe(0);
	});

	it("rejects an unknown provider and inserts no row", async () => {
		const res = await handler(
			makeRequest({
				name: "bogus",
				provider: "bogus-provider",
				accessToken: "at-generic",
				refreshToken: "rt-generic",
			}),
		);
		expect(res.status).toBe(400);
		const payload = (await res.json()) as { error: string };
		expect(payload.error).toContain("provider");

		expect(getStoredAccount("bogus")).toBeNull();
		expect(countAccounts()).toBe(0);
	});

	it("defaults an omitted provider to anthropic", async () => {
		const res = await handler(
			makeRequest({
				name: "default-provider",
				accessToken: "at-default",
				refreshToken: "rt-default",
			}),
		);
		expect(res.status).toBe(200);

		const row = getStoredAccount("default-provider");
		expect(row).not.toBeNull();
		if (!row) return;
		expect(row.provider).toBe("anthropic");
		expect(row.api_key).toBeNull();
		expect(row.access_token).toBe("at-default");
		expect(row.refresh_token).toBe("rt-default");
		expect(row.expires_at).toBeNull();
	});

	// vertex-ai and bedrock authenticate with ambient cloud credentials, but
	// they also need connection settings (vertex: project/region JSON; bedrock:
	// profile/region) that only their dedicated endpoints collect. Accepting a
	// bare {name, provider} here would create an account that fails every
	// request, so both are rejected with a pointer to the right route.
	it("rejects vertex-ai with no secret and names the dedicated route", async () => {
		const res = await handler(
			makeRequest({ name: "vertex-generic", provider: "vertex-ai" }),
		);
		expect(res.status).toBe(400);
		const payload = (await res.json()) as { error: string };
		expect(payload.error).toContain("vertex-ai");
		expect(payload.error).toContain("POST /api/accounts/vertex-ai");

		expect(getStoredAccount("vertex-generic")).toBeNull();
		expect(countAccounts()).toBe(0);
	});

	it("rejects bedrock with no secret and names the dedicated route", async () => {
		const res = await handler(
			makeRequest({ name: "bedrock-generic", provider: "bedrock" }),
		);
		expect(res.status).toBe(400);
		const payload = (await res.json()) as { error: string };
		expect(payload.error).toContain("bedrock");
		expect(payload.error).toContain("POST /api/accounts/bedrock");

		expect(getStoredAccount("bedrock-generic")).toBeNull();
		expect(countAccounts()).toBe(0);
	});

	it("rejects vertex-ai even when connection-shaped fields are sent", async () => {
		// The generic endpoint's customEndpoint is a URL; vertex-ai's settings
		// are JSON, so nothing it accepts can make such an account work.
		const res = await handler(
			makeRequest({
				name: "vertex-shaped",
				provider: "vertex-ai",
				customEndpoint: "https://us-central1-aiplatform.googleapis.com",
			}),
		);
		expect(res.status).toBe(400);
		expect(getStoredAccount("vertex-shaped")).toBeNull();
	});
});

// POST /api/accounts also accepts `mode`, the CLI's account-type vocabulary
// (claude-oauth, zai, nanogpt, ...), as an alias for `provider`. A CLI-shaped
// body must create the account it names; an unknown mode or a mode that
// disagrees with an explicit provider must be rejected rather than silently
// falling back to anthropic.
describe("POST /api/accounts with a mode alias", () => {
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
		handler = createAccountAddHandler(dbOps, null as never);
		registerPollingRestarter(SERVER_ID, async () => true);
	});

	afterEach(() => {
		unregisterPollingRestarter(SERVER_ID);
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

	function getStoredAccount(name: string): StoredAccount | null {
		const db = dbOps.getDatabase();
		return (
			db
				.query<StoredAccount, [string]>(
					"SELECT provider, api_key, access_token, refresh_token, expires_at FROM accounts WHERE name = ?",
				)
				.get(name) ?? null
		);
	}

	function countNamedAccounts(name: string): number {
		const db = dbOps.getDatabase();
		const row = db
			.query<{ n: number }, [string]>(
				"SELECT COUNT(*) AS n FROM accounts WHERE name = ?",
			)
			.get(name);
		return row?.n ?? 0;
	}

	it("creates a nanogpt account from mode alone, storing the key in api_key", async () => {
		const res = await handler(
			makeRequest({
				name: "nanogpt-mode",
				mode: "nanogpt",
				apiKey: "sk-nanogpt-mode-key",
			}),
		);
		expect(res.status).toBe(200);

		const row = getStoredAccount("nanogpt-mode");
		expect(row).not.toBeNull();
		if (!row) return;
		expect(row.provider).toBe("nanogpt");
		expect(row.api_key).toBe("sk-nanogpt-mode-key");
		expect(row.access_token).toBeNull();
		expect(row.refresh_token).toBeNull();
	});

	it("maps every CLI mode to its provider when sent alone", async () => {
		const keyModes: Array<[string, string]> = [
			["zai", "zai"],
			["minimax", "minimax"],
			["deepseek", "deepseek"],
			["anthropic-compatible", "anthropic-compatible"],
			["openai-compatible", "openai-compatible"],
			["nanogpt", "nanogpt"],
			["ollama", "ollama"],
			["meta", "meta"],
		];
		for (const [mode, expectedProvider] of keyModes) {
			const name = `mode-${mode}`;
			const res = await handler(
				makeRequest({ name, mode, apiKey: `key-${mode}` }),
			);
			expect({ mode, status: res.status }).toEqual({ mode, status: 200 });
			const row = getStoredAccount(name);
			expect(row?.provider).toBe(expectedProvider);
			expect(row?.api_key).toBe(`key-${mode}`);
		}

		const claudeRes = await handler(
			makeRequest({
				name: "mode-claude-oauth",
				mode: "claude-oauth",
				accessToken: "at-mode",
				refreshToken: "rt-mode",
			}),
		);
		expect(claudeRes.status).toBe(200);
		expect(getStoredAccount("mode-claude-oauth")?.provider).toBe("anthropic");
	});

	// A claude-console-api account is an Anthropic API key: the CLI's console
	// mode ends in createConsoleAccountWithApiKey (api_key set, tokens NULL)
	// and the provider reads api_key for it (anthropic/provider.ts treats
	// `!!account.api_key` as console mode). So the generic endpoint demands
	// apiKey here too, and the key lands in api_key, not the token columns.
	it("maps mode console to claude-console-api and stores apiKey in api_key", async () => {
		const res = await handler(
			makeRequest({
				name: "mode-console",
				mode: "console",
				apiKey: "sk-ant-console",
			}),
		);
		expect(res.status).toBe(200);
		const row = getStoredAccount("mode-console");
		expect(row?.provider).toBe("claude-console-api");
		expect(row?.api_key).toBe("sk-ant-console");
		expect(row?.access_token).toBeNull();
		expect(row?.refresh_token).toBeNull();
		expect(row?.expires_at).not.toBeNull();
	});

	it("rejects mode console given only the token pair and inserts no row", async () => {
		const res = await handler(
			makeRequest({
				name: "console-tokens-only",
				mode: "console",
				accessToken: "at-console",
				refreshToken: "rt-console",
			}),
		);
		expect(res.status).toBe(400);
		const payload = (await res.json()) as { error: string };
		expect(payload.error).toContain("apiKey");
		expect(countNamedAccounts("console-tokens-only")).toBe(0);
	});

	it("rejects a provider that contradicts the mode and inserts no row", async () => {
		const res = await handler(
			makeRequest({
				name: "contradict",
				provider: "openrouter",
				mode: "nanogpt",
				apiKey: "sk-contradict",
			}),
		);
		expect(res.status).toBe(400);
		const payload = (await res.json()) as { error: string };
		expect(payload.error).toContain("contradicts");

		expect(countNamedAccounts("contradict")).toBe(0);
	});

	it("accepts provider and mode when they agree", async () => {
		const res = await handler(
			makeRequest({
				name: "agree-oauth",
				provider: "anthropic",
				mode: "claude-oauth",
				accessToken: "at-agree",
				refreshToken: "rt-agree",
			}),
		);
		expect(res.status).toBe(200);

		const row = getStoredAccount("agree-oauth");
		expect(row).not.toBeNull();
		if (!row) return;
		expect(row.provider).toBe("anthropic");
		expect(row.access_token).toBe("at-agree");
		expect(row.refresh_token).toBe("rt-agree");
		expect(row.api_key).toBeNull();

		const keyRes = await handler(
			makeRequest({
				name: "agree-key",
				provider: "nanogpt",
				mode: "nanogpt",
				apiKey: "sk-agree-key",
			}),
		);
		expect(keyRes.status).toBe(200);
		expect(getStoredAccount("agree-key")?.provider).toBe("nanogpt");
		expect(getStoredAccount("agree-key")?.api_key).toBe("sk-agree-key");
	});

	it("rejects an unknown mode instead of defaulting to anthropic and inserts no row", async () => {
		const res = await handler(
			makeRequest({
				name: "bogus-mode",
				mode: "bogus-mode",
				accessToken: "at-bogus",
				refreshToken: "rt-bogus",
			}),
		);
		expect(res.status).toBe(400);
		const payload = (await res.json()) as { error: string };
		expect(payload.error).toContain("mode");

		expect(countNamedAccounts("bogus-mode")).toBe(0);
	});

	it("requires the token pair for mode claude-oauth with no provider", async () => {
		const missing = await handler(
			makeRequest({
				name: "claude-oauth-no-tokens",
				mode: "claude-oauth",
			}),
		);
		expect(missing.status).toBe(400);
		const payload = (await missing.json()) as { error: string };
		expect(payload.error).toContain("accessToken");
		expect(countNamedAccounts("claude-oauth-no-tokens")).toBe(0);

		const keyOnly = await handler(
			makeRequest({
				name: "claude-oauth-key-only",
				mode: "claude-oauth",
				apiKey: "sk-not-a-token",
			}),
		);
		expect(keyOnly.status).toBe(400);
		expect(countNamedAccounts("claude-oauth-key-only")).toBe(0);
	});

	it("still honours a provider-only body (no mode) unchanged", async () => {
		const res = await handler(
			makeRequest({
				name: "provider-only",
				provider: "openrouter",
				apiKey: "sk-or-provider-only",
			}),
		);
		expect(res.status).toBe(200);
		const row = getStoredAccount("provider-only");
		expect(row?.provider).toBe("openrouter");
		expect(row?.api_key).toBe("sk-or-provider-only");
	});
});
