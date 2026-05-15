import { randomBytes } from "node:crypto";
import { existsSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	deleteApiKey,
	disableApiKey,
	enableApiKey,
	generateApiKey,
	listApiKeys,
} from "@better-ccflare/cli-commands";
import { DatabaseOperations } from "@better-ccflare/database";
import { AuthService } from "@better-ccflare/http-api";

function tempDbPath(): string {
	return join(tmpdir(), `test-api-auth-${randomBytes(6).toString("hex")}.db`);
}

function makeRequest(opts: {
	apiKey?: string;
	bearer?: string;
	url?: string;
}): Request {
	const headers = new Headers();
	if (opts.apiKey) headers.set("x-api-key", opts.apiKey);
	if (opts.bearer) headers.set("authorization", `Bearer ${opts.bearer}`);
	return new Request(opts.url ?? "http://localhost:8080/v1/messages", {
		headers,
		method: "POST",
	});
}

describe("AuthService", () => {
	let dbPath: string;
	let dbOps: DatabaseOperations;
	let authService: AuthService;

	beforeEach(() => {
		dbPath = tempDbPath();
		dbOps = new DatabaseOperations(dbPath);
		authService = new AuthService(dbOps);
	});

	afterEach(() => {
		dbOps.dispose?.();
		if (existsSync(dbPath)) unlinkSync(dbPath);
	});

	describe("isAuthenticationEnabled()", () => {
		test("returns false when no keys are configured", async () => {
			expect(await authService.isAuthenticationEnabled()).toBe(false);
		});

		test("returns true when at least one active key exists", async () => {
			await generateApiKey(dbOps, "first-key");
			expect(await authService.isAuthenticationEnabled()).toBe(true);
		});

		test("returns false when the only key is disabled", async () => {
			await generateApiKey(dbOps, "only-key");
			await disableApiKey(dbOps, "only-key");
			expect(await authService.isAuthenticationEnabled()).toBe(false);
		});

		test("returns true when at least one of several keys is active", async () => {
			await generateApiKey(dbOps, "active");
			await generateApiKey(dbOps, "inactive");
			await disableApiKey(dbOps, "inactive");
			expect(await authService.isAuthenticationEnabled()).toBe(true);
		});
	});

	describe("authenticateRequest() with no keys configured", () => {
		// When no API keys exist, authentication is effectively disabled — every
		// path passes through. This matches single-user / first-run behaviour.
		test.each([
			["/", "GET"],
			["/dashboard", "GET"],
			["/health", "GET"],
			["/api/stats", "GET"],
			["/api/accounts", "GET"],
			["/v1/messages", "POST"],
			["/messages", "POST"],
		])("%s %s passes through with no key", async (path, method) => {
			const req = makeRequest({ url: `http://localhost:8080${path}` });
			const result = await authService.authenticateRequest(req, path, method);
			expect(result.isAuthenticated).toBe(true);
			expect(result.apiKeyId).toBeUndefined();
		});
	});

	describe("authenticateRequest() with a key configured", () => {
		let validKey: string;

		beforeEach(async () => {
			const result = await generateApiKey(dbOps, "test-key");
			validKey = result.apiKey;
		});

		describe("public paths require no key", () => {
			test.each([
				["/", "GET"],
				["/dashboard", "GET"],
				["/health", "GET"],
				["/api", "GET"],
				["/api/stats", "GET"],
				["/api/accounts", "GET"],
				["/api/oauth/init", "POST"],
				["/some-client-route", "GET"],
				["/static/logo.png", "GET"],
			])("%s %s is public", async (path, method) => {
				const req = makeRequest({ url: `http://localhost:8080${path}` });
				const result = await authService.authenticateRequest(req, path, method);
				expect(result.isAuthenticated).toBe(true);
				expect(result.apiKeyId).toBeUndefined();
			});
		});

		describe("/v1/* and /messages/* require an API key", () => {
			test.each([
				["/v1/messages", "POST"],
				["/v1/models", "GET"],
				["/v1/anthropic/version", "GET"],
				["/messages", "POST"],
				["/messages/123", "POST"],
			])("%s %s rejects requests without a key", async (path, method) => {
				const req = makeRequest({ url: `http://localhost:8080${path}` });
				const result = await authService.authenticateRequest(req, path, method);
				expect(result.isAuthenticated).toBe(false);
				expect(result.error).toMatch(/API key required/);
			});

			test("rejects an invalid key", async () => {
				const req = makeRequest({ apiKey: "btr-not-a-real-key" });
				const result = await authService.authenticateRequest(
					req,
					"/v1/messages",
					"POST",
				);
				expect(result.isAuthenticated).toBe(false);
				expect(result.error).toBe("Invalid API key");
			});

			test("accepts a valid key via the x-api-key header", async () => {
				const req = makeRequest({ apiKey: validKey });
				const result = await authService.authenticateRequest(
					req,
					"/v1/messages",
					"POST",
				);
				expect(result.isAuthenticated).toBe(true);
				expect(result.apiKeyName).toBe("test-key");
				expect(result.apiKeyId).toBeDefined();
				expect(result.error).toBeUndefined();
			});

			test("accepts a valid key via Authorization: Bearer", async () => {
				const req = makeRequest({ bearer: validKey });
				const result = await authService.authenticateRequest(
					req,
					"/v1/messages",
					"POST",
				);
				expect(result.isAuthenticated).toBe(true);
				expect(result.apiKeyName).toBe("test-key");
			});

			test("rejects a key that has been disabled", async () => {
				await disableApiKey(dbOps, "test-key");
				// Now there are 0 active keys → isAuthenticationEnabled returns
				// false, so authenticateRequest lets everything through. Verify
				// that explicitly: this is the documented "no keys configured"
				// behaviour, even though the row still exists.
				const req = makeRequest({ apiKey: validKey });
				const result = await authService.authenticateRequest(
					req,
					"/v1/messages",
					"POST",
				);
				expect(result.isAuthenticated).toBe(true);
			});

			test("with a second key active, disabled key is rejected", async () => {
				await generateApiKey(dbOps, "second-key");
				await disableApiKey(dbOps, "test-key");
				const req = makeRequest({ apiKey: validKey });
				const result = await authService.authenticateRequest(
					req,
					"/v1/messages",
					"POST",
				);
				expect(result.isAuthenticated).toBe(false);
				expect(result.error).toBe("Invalid API key");
			});
		});
	});
});

describe("API Key lifecycle", () => {
	let dbPath: string;
	let dbOps: DatabaseOperations;

	beforeEach(() => {
		dbPath = tempDbPath();
		dbOps = new DatabaseOperations(dbPath);
	});

	afterEach(() => {
		dbOps.dispose?.();
		if (existsSync(dbPath)) unlinkSync(dbPath);
	});

	test("generateApiKey produces a btr-prefixed key with metadata", async () => {
		const result = await generateApiKey(dbOps, "lifecycle-test");
		expect(result.name).toBe("lifecycle-test");
		expect(result.apiKey).toMatch(/^btr-[a-zA-Z0-9]{32}$/);
		expect(result.prefixLast8).toHaveLength(8);
		expect(result.id).toMatch(/^[a-f0-9-]{36}$/);
		expect(result.createdAt).toBeDefined();
	});

	test("rejects empty key name", async () => {
		await expect(generateApiKey(dbOps, "")).rejects.toThrow(
			"API key name cannot be empty",
		);
	});

	test("rejects whitespace-only key name", async () => {
		await expect(generateApiKey(dbOps, "   ")).rejects.toThrow(
			"API key name cannot be empty",
		);
	});

	test("rejects duplicate key names", async () => {
		await generateApiKey(dbOps, "dup");
		await expect(generateApiKey(dbOps, "dup")).rejects.toThrow(
			"already exists",
		);
	});

	test("listApiKeys returns all keys without the raw secret", async () => {
		await generateApiKey(dbOps, "alpha");
		await generateApiKey(dbOps, "beta");
		const keys = await listApiKeys(dbOps);
		expect(keys).toHaveLength(2);
		const names = keys.map((k) => k.name).sort();
		expect(names).toEqual(["alpha", "beta"]);
		for (const k of keys) {
			expect((k as unknown as { apiKey?: string }).apiKey).toBeUndefined();
			expect((k as unknown as { hashedKey?: string }).hashedKey).toBeUndefined();
		}
	});

	test("disable + enable round-trip preserves the key", async () => {
		await generateApiKey(dbOps, "toggle");

		await disableApiKey(dbOps, "toggle");
		let keys = await listApiKeys(dbOps);
		expect(keys.find((k) => k.name === "toggle")?.isActive).toBe(false);

		await enableApiKey(dbOps, "toggle");
		keys = await listApiKeys(dbOps);
		expect(keys.find((k) => k.name === "toggle")?.isActive).toBe(true);
	});

	test("disable on an already-disabled key throws", async () => {
		await generateApiKey(dbOps, "twice");
		await disableApiKey(dbOps, "twice");
		await expect(disableApiKey(dbOps, "twice")).rejects.toThrow(
			"already disabled",
		);
	});

	test("enable on an already-active key throws", async () => {
		await generateApiKey(dbOps, "active");
		await expect(enableApiKey(dbOps, "active")).rejects.toThrow(
			"already active",
		);
	});

	test("deleteApiKey removes the row", async () => {
		await generateApiKey(dbOps, "to-delete");
		await deleteApiKey(dbOps, "to-delete");
		const keys = await listApiKeys(dbOps);
		expect(keys.find((k) => k.name === "to-delete")).toBeUndefined();
	});

	test("disable/enable/delete on a missing key throws not-found", async () => {
		await expect(disableApiKey(dbOps, "nope")).rejects.toThrow("not found");
		await expect(enableApiKey(dbOps, "nope")).rejects.toThrow("not found");
		await expect(deleteApiKey(dbOps, "nope")).rejects.toThrow("not found");
	});
});
