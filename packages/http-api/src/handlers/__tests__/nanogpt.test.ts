import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import type { DatabaseOperations } from "@better-ccflare/database";
import { DatabaseFactory } from "@better-ccflare/database";
import { createNanoGPTAccountAddHandler } from "../accounts";

// Test database path
const TEST_DB_PATH = "/tmp/test-nanogpt-handler.db";

describe("NanoGPT Handler", () => {
	let dbOps: DatabaseOperations;
	let handler: (req: Request) => Promise<Response>;

	beforeAll(async () => {
		// Clean up any existing test database
		if (require("node:fs").existsSync(TEST_DB_PATH)) {
			require("node:fs").unlinkSync(TEST_DB_PATH);
		}

		// Initialize test database
		DatabaseFactory.initialize(TEST_DB_PATH);
		dbOps = DatabaseFactory.getInstance();

		// Create handler
		handler = createNanoGPTAccountAddHandler(dbOps);
	});

	afterAll(() => {
		// Clean up test database
		if (require("node:fs").existsSync(TEST_DB_PATH)) {
			require("node:fs").unlinkSync(TEST_DB_PATH);
		}
		DatabaseFactory.reset();
	});

	describe("NanoGPT Account Creation", () => {
		it("should create a NanoGPT account with valid data", async () => {
			const request = new Request("http://localhost/api/accounts/nanogpt", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					name: "test-nanogpt-account",
					apiKey: "test-api-key-123",
					priority: 5,
				}),
			});

			const response = await handler(request);
			const data = await response.json();

			expect(response.status).toBe(200);
			expect(data.message).toContain("added successfully");
			expect(data.account).toBeDefined();
			expect(data.account.name).toBe("test-nanogpt-account");
			expect(data.account.provider).toBe("nanogpt");
			expect(data.account.priority).toBe(5);
		});

		it("should create a NanoGPT account with custom endpoint", async () => {
			const request = new Request("http://localhost/api/accounts/nanogpt", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					name: "test-nanogpt-custom",
					apiKey: "test-api-key-456",
					priority: 3,
					customEndpoint: "https://custom.nanogpt.example.com/api",
				}),
			});

			const response = await handler(request);
			const data = await response.json();

			expect(response.status).toBe(200);
			expect(data.message).toContain("added successfully");
			expect(data.account.name).toBe("test-nanogpt-custom");
			expect(data.account.provider).toBe("nanogpt");

			// Verify the account was stored with custom endpoint
			const db = dbOps.getDatabase();
			const storedAccount = db
				.query<{ custom_endpoint: string }, [string]>(
					"SELECT custom_endpoint FROM accounts WHERE name = ?",
				)
				.get("test-nanogpt-custom");
			expect(storedAccount?.custom_endpoint).toBe(
				"https://custom.nanogpt.example.com/api",
			);
		});

		it("should create a NanoGPT account with model mappings", async () => {
			const modelMappings = {
				opus: "nanogpt-ultra",
				sonnet: "nanogpt-pro",
				haiku: "nanogpt-lite",
			};

			const request = new Request("http://localhost/api/accounts/nanogpt", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					name: "test-nanogpt-mappings",
					apiKey: "test-api-key-789",
					priority: 1,
					modelMappings,
				}),
			});

			const response = await handler(request);
			const data = await response.json();

			expect(response.status).toBe(200);
			expect(data.message).toContain("added successfully");
			expect(data.account.name).toBe("test-nanogpt-mappings");

			// Verify the account was stored with model mappings
			const db = dbOps.getDatabase();
			const storedAccount = db
				.query<{ model_mappings: string }, [string]>(
					"SELECT model_mappings FROM accounts WHERE name = ?",
				)
				.get("test-nanogpt-mappings");
			expect(storedAccount?.model_mappings).toBe(JSON.stringify(modelMappings));
		});

		it("should reject requests with missing name", async () => {
			const request = new Request("http://localhost/api/accounts/nanogpt", {
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
			const request = new Request("http://localhost/api/accounts/nanogpt", {
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

		it("should reject requests with invalid custom endpoint URL", async () => {
			const request = new Request("http://localhost/api/accounts/nanogpt", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					name: "test-account",
					apiKey: "test-api-key",
					priority: 5,
					customEndpoint: "https://[invalid-url-with-brackets",
				}),
			});

			const response = await handler(request);
			const data = await response.json();

			expect(response.status).toBe(400);
			expect(data.error).toContain("Invalid URL format");
		});

		it("should reject requests with invalid model mappings", async () => {
			const request = new Request("http://localhost/api/accounts/nanogpt", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					name: "test-account",
					apiKey: "test-api-key",
					priority: 5,
					modelMappings: "invalid-json",
				}),
			});

			const response = await handler(request);
			const _data = await response.json();

			expect(response.status).toBe(400);
		});

		it("should handle default priority when not provided", async () => {
			const request = new Request("http://localhost/api/accounts/nanogpt", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					name: "test-nanogpt-default-priority",
					apiKey: "test-api-key-default",
				}),
			});

			const response = await handler(request);
			const data = await response.json();

			expect(response.status).toBe(200);
			expect(data.account.priority).toBe(0); // Default priority
		});

		it("should handle empty model mappings object", async () => {
			const request = new Request("http://localhost/api/accounts/nanogpt", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					name: "test-nanogpt-empty-mappings",
					apiKey: "test-api-key-empty",
					priority: 5,
					modelMappings: {},
				}),
			});

			const response = await handler(request);
			const data = await response.json();

			expect(response.status).toBe(200);
			expect(data.account.name).toBe("test-nanogpt-empty-mappings");

			// Verify empty model mappings are handled
			const db = dbOps.getDatabase();
			const storedAccount = db
				.query<{ model_mappings: string | null }, [string]>(
					"SELECT model_mappings FROM accounts WHERE name = ?",
				)
				.get("test-nanogpt-empty-mappings");
			expect(storedAccount?.model_mappings).toBeNull();
		});
	});
});
