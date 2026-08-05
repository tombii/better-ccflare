/**
 * Tests for the CLI's server-notification calls (issue #216, stage 1).
 *
 * Previously, `--force-reset-rate-limit` and OAuth re-authentication
 * (`--reauthenticate`) would silently skip notifying a locally-running
 * server whenever API-key auth was enabled — the DB was updated, but the
 * live server never heard about it (rate limit state stayed stale in
 * memory, tokens weren't reloaded). Since API keys are only ever stored as
 * scrypt hashes (never recoverable in plaintext), the CLI cannot just reuse
 * an existing API key to authenticate these calls to itself.
 *
 * Instead, both the CLI and the server resolve a shared `local_control_secret`
 * from the same on-disk config file (`Config#getLocalControlSecret`, generated
 * once and persisted). The CLI now always sends this secret via the
 * `x-better-ccflare-local-control-secret` header instead of skipping the
 * notification — AuthService only honors it for the small allowlisted
 * account-notify endpoints, so this isn't a general auth bypass.
 */
import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config } from "@better-ccflare/config";
import type { DatabaseOperations } from "@better-ccflare/database";
import { DatabaseFactory } from "@better-ccflare/database";

mock.module("../../utils/browser", () => ({
	openBrowser: async () => true,
}));

mock.module("@better-ccflare/providers/qwen", () => ({
	initiateDeviceFlow: async () => ({
		deviceCode: "device-code",
		userCode: "USER-CODE",
		verificationUri: "https://example.com/verify",
		verificationUriComplete: "https://example.com/verify?code=USER-CODE",
		interval: 1,
		pkce: { verifier: "verifier", challenge: "challenge" },
	}),
	pollForToken: async () => ({
		access_token: "access-token-reauth",
		refresh_token: "refresh-token-reauth",
		expires_in: 3600,
		resource_url: null,
	}),
}));

const { forceResetRateLimit, reauthenticateAccount } = await import(
	"../account"
);

const LOCAL_CONTROL_SECRET_HEADER = "x-better-ccflare-local-control-secret";
const TEST_SECRET = "test-local-control-secret";

function makeConfig(): Config {
	return {
		getRuntime: () => ({ port: 8080, tlsEnabled: false }),
		getLocalControlSecret: () => TEST_SECRET,
	} as unknown as Config;
}

describe("CLI notify-server calls send the local-control-secret (#216)", () => {
	let dbOps: DatabaseOperations;
	let dbPath: string;
	let originalFetch: typeof fetch;
	let capturedRequests: Array<{ url: string; headers: Record<string, string> }>;

	beforeEach(() => {
		const suffix = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
		dbPath = join(tmpdir(), `test-notify-cli-${suffix}.db`);
		DatabaseFactory.initialize(dbPath);
		dbOps = DatabaseFactory.getInstance();

		capturedRequests = [];
		originalFetch = globalThis.fetch;
		globalThis.fetch = (async (
			input: RequestInfo | URL,
			init?: RequestInit,
		) => {
			const url = typeof input === "string" ? input : input.toString();
			const headers: Record<string, string> = {};
			if (init?.headers) {
				for (const [k, v] of Object.entries(
					init.headers as Record<string, string>,
				)) {
					headers[k.toLowerCase()] = v;
				}
			}
			capturedRequests.push({ url, headers });
			// Simulate "no server running" so the CLI functions complete quickly
			// without needing a real listening server.
			throw new Error("connection refused");
		}) as typeof fetch;
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
		DatabaseFactory.reset();
		for (const path of [dbPath, `${dbPath}-shm`, `${dbPath}-wal`]) {
			if (existsSync(path)) {
				rmSync(path, { recursive: true, force: true });
			}
		}
	});

	it("sends the local-control-secret header from forceResetRateLimit even though it cannot reach a server", async () => {
		const accountId = crypto.randomUUID();
		await dbOps.getAdapter().run(
			`INSERT INTO accounts (
				id, name, provider, api_key, refresh_token, access_token,
				expires_at, created_at, request_count, total_requests, priority
			) VALUES (?, ?, ?, NULL, NULL, NULL, NULL, ?, 0, 0, ?)`,
			[accountId, "force-reset-acct", "anthropic", Date.now(), 50],
		);

		const config = makeConfig();
		const result = await forceResetRateLimit(dbOps, "force-reset-acct", config);

		expect(result.success).toBe(true);
		expect(capturedRequests.length).toBeGreaterThan(0);
		for (const req of capturedRequests) {
			expect(req.url).toContain("/force-reset-rate-limit");
			expect(req.headers[LOCAL_CONTROL_SECRET_HEADER]).toBe(TEST_SECRET);
		}
	});

	it("sends the local-control-secret header when reauthenticating a Qwen account", async () => {
		const accountId = crypto.randomUUID();
		await dbOps.getAdapter().run(
			`INSERT INTO accounts (
				id, name, provider, api_key, refresh_token, access_token,
				expires_at, created_at, request_count, total_requests, priority,
				custom_endpoint, refresh_token_issued_at
			) VALUES (?, ?, ?, NULL, ?, ?, ?, ?, 0, 0, ?, ?, ?)`,
			[
				accountId,
				"qwen-notify-acct",
				"qwen",
				"refresh-token-original",
				"access-token-original",
				Date.now() + 60_000,
				Date.now(),
				50,
				"https://example.com",
				Date.now() - 60_000,
			],
		);

		const config = makeConfig();
		const result = await reauthenticateAccount(
			dbOps,
			config,
			"qwen-notify-acct",
		);

		expect(result.success).toBe(true);
		const reloadRequests = capturedRequests.filter((r) =>
			r.url.includes("/reload"),
		);
		expect(reloadRequests.length).toBeGreaterThan(0);
		for (const req of reloadRequests) {
			expect(req.headers[LOCAL_CONTROL_SECRET_HEADER]).toBe(TEST_SECRET);
		}
	});
});
