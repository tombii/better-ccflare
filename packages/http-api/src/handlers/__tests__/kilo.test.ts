import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { existsSync, unlinkSync } from "node:fs";
import type { DatabaseOperations } from "@better-ccflare/database";
import { DatabaseFactory } from "@better-ccflare/database";
import { createKiloAccountAddHandler } from "../accounts";

// Test database path
const TEST_DB_PATH = "/tmp/test-kilo-handler.db";

describe("Kilo Gateway Handler", () => {
	let dbOps: DatabaseOperations;
	let handler: (req: Request) => Promise<Response>;

	beforeAll(async () => {
		// Clean up any existing test database
		try {
			if (existsSync(TEST_DB_PATH)) {
				unlinkSync(TEST_DB_PATH);
			}
		} catch (error) {
			console.warn("Failed to clean up existing test database:", error);
		}

		// Initialize test database
		DatabaseFactory.initialize(TEST_DB_PATH);
		dbOps = DatabaseFactory.getInstance();

		// Create handler
		handler = createKiloAccountAddHandler(dbOps);
	});

	afterAll(() => {
		// Clean up test database
		try {
			if (existsSync(TEST_DB_PATH)) {
				unlinkSync(TEST_DB_PATH);
			}
		} catch (error) {
			console.warn("Failed to clean up test database:", error);
		}
		DatabaseFactory.reset();
	});

	describe("Kilo Gateway Account Creation", () => {
		it("should create a Kilo account with valid data", async () => {
			const request = new Request("http://localhost/api/accounts/kilo", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					name: "test-kilo-account",
					apiKey: "test-kilo-api-key-123",
					priority: 5,
				}),
			});

			const response = await handler(request);
			const data = await response.json();

			expect(response.status).toBe(200);
			expect(data.message).toContain("added successfully");
			expect(data.account).toBeDefined();
			expect(data.account.name).toBe("test-kilo-account");
			expect(data.account.provider).toBe("kilo");
			expect(data.account.priority).toBe(5);
		});

		it("should store the API key correctly", async () => {
			const request = new Request("http://localhost/api/accounts/kilo", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					name: "test-kilo-apikey",
					apiKey: "kilo-secret-api-key",
					priority: 0,
				}),
			});

			const response = await handler(request);
			expect(response.status).toBe(200);

			// Verify the API key was stored
			const db = dbOps.getDatabase();
			const storedAccount = db
				.query<{ api_key: string; provider: string }, [string]>(
					"SELECT api_key, provider FROM accounts WHERE name = ?",
				)
				.get("test-kilo-apikey");
			expect(storedAccount?.api_key).toBe("kilo-secret-api-key");
			expect(storedAccount?.provider).toBe("kilo");
		});

		it("should reject requests with missing name", async () => {
			const request = new Request("http://localhost/api/accounts/kilo", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					apiKey: "test-api-key",
					priority: 5,
				}),
			});

			const response = await handler(request);
			const data = await response.json();

			expect(response.status).toBe(400);
			expect(data.error).toContain("name is required");
		});

		it("should reject requests with missing API key", async () => {
			const request = new Request("http://localhost/api/accounts/kilo", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					name: "test-account",
					priority: 5,
				}),
			});

			const response = await handler(request);
			const data = await response.json();

			expect(response.status).toBe(400);
			expect(data.error).toContain("apiKey is required");
		});

		it("should handle default priority when not provided", async () => {
			const request = new Request("http://localhost/api/accounts/kilo", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					name: "test-kilo-default-priority",
					apiKey: "test-api-key-default",
				}),
			});

			const response = await handler(request);
			const data = await response.json();

			expect(response.status).toBe(200);
			expect(data.account.priority).toBe(0);
		});

		it("should set expires_at to 1 year in the future", async () => {
			const before = Date.now();
			const request = new Request("http://localhost/api/accounts/kilo", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					name: "test-kilo-expiry",
					apiKey: "test-api-key-expiry",
					priority: 0,
				}),
			});

			const response = await handler(request);
			expect(response.status).toBe(200);

			const db = dbOps.getDatabase();
			const storedAccount = db
				.query<{ expires_at: number }, [string]>(
					"SELECT expires_at FROM accounts WHERE name = ?",
				)
				.get("test-kilo-expiry");

			const oneYearMs = 365 * 24 * 60 * 60 * 1000;
			expect(storedAccount?.expires_at).toBeGreaterThan(
				before + oneYearMs - 5000,
			);
			expect(storedAccount?.expires_at).toBeLessThan(before + oneYearMs + 5000);
		});
	});
});
