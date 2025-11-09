import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { existsSync, unlinkSync } from "node:fs";
import type { DatabaseOperations } from "@better-ccflare/database";
import { DatabaseFactory } from "@better-ccflare/database";
import { createNanoGPTAccount } from "../account";

// Test database path
const TEST_DB_PATH = "/tmp/test-nanogpt-cli.db";

describe("CLI NanoGPT Account Creation", () => {
	let dbOps: DatabaseOperations;

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

	describe("createNanoGPTAccount", () => {
		it("should create a basic NanoGPT account", async () => {
			await createNanoGPTAccount(
				dbOps,
				"test-basic-nanogpt",
				"test-api-key-123",
				5,
			);

			// Verify account was created
			const db = dbOps.getDatabase();
			const account = db
				.query<
					{
						name: string;
						provider: string;
						api_key: string;
						priority: number;
						custom_endpoint: string | null;
						model_mappings: string | null;
					},
					[string]
				>(
					"SELECT name, provider, api_key, priority, custom_endpoint, model_mappings FROM accounts WHERE name = ?",
				)
				.get("test-basic-nanogpt");

			expect(account).toBeDefined();
			expect(account?.name).toBe("test-basic-nanogpt");
			expect(account?.provider).toBe("nanogpt");
			expect(account?.api_key).toBe("test-api-key-123");
			expect(account?.priority).toBe(5);
			expect(account?.custom_endpoint).toBeNull();
			expect(account?.model_mappings).toBeNull();
		});

		it("should create a NanoGPT account with custom endpoint", async () => {
			await createNanoGPTAccount(
				dbOps,
				"test-custom-endpoint",
				"test-api-key-456",
				3,
				"https://custom.nanogpt.example.com/api",
			);

			// Verify account was created
			const db = dbOps.getDatabase();
			const account = db
				.query<{ custom_endpoint: string }, [string]>(
					"SELECT custom_endpoint FROM accounts WHERE name = ?",
				)
				.get("test-custom-endpoint");

			expect(account).toBeDefined();
			expect(account?.custom_endpoint).toBe(
				"https://custom.nanogpt.example.com/api",
			);
		});

		it("should create a NanoGPT account with model mappings", async () => {
			const modelMappings = {
				opus: "nanogpt-ultra",
				sonnet: "nanogpt-pro",
				haiku: "nanogpt-lite",
			};

			await createNanoGPTAccount(
				dbOps,
				"test-model-mappings",
				"test-api-key-789",
				1,
				undefined,
				modelMappings,
			);

			// Verify account was created
			const db = dbOps.getDatabase();
			const account = db
				.query<{ model_mappings: string }, [string]>(
					"SELECT model_mappings FROM accounts WHERE name = ?",
				)
				.get("test-model-mappings");

			expect(account).toBeDefined();
			expect(account?.model_mappings).toBe(JSON.stringify(modelMappings));
		});

		it("should create a NanoGPT account with both custom endpoint and model mappings", async () => {
			const modelMappings = {
				opus: "custom-nanogpt-opus",
				sonnet: "custom-nanogpt-sonnet",
			};

			await createNanoGPTAccount(
				dbOps,
				"test-full-features",
				"test-api-key-full",
				2,
				"https://full-feature.nanogpt.example.com",
				modelMappings,
			);

			// Verify account was created
			const db = dbOps.getDatabase();
			const account = db
				.query<
					{
						custom_endpoint: string;
						model_mappings: string;
					},
					[string]
				>("SELECT custom_endpoint, model_mappings FROM accounts WHERE name = ?")
				.get("test-full-features");

			expect(account).toBeDefined();
			expect(account?.custom_endpoint).toBe(
				"https://full-feature.nanogpt.example.com",
			);
			expect(account?.model_mappings).toBe(JSON.stringify(modelMappings));
		});

		it("should handle empty model mappings", async () => {
			await createNanoGPTAccount(
				dbOps,
				"test-empty-mappings",
				"test-api-key-empty",
				0,
				undefined,
				{},
			);

			// Verify account was created with null model mappings
			const db = dbOps.getDatabase();
			const account = db
				.query<{ model_mappings: string | null }, [string]>(
					"SELECT model_mappings FROM accounts WHERE name = ?",
				)
				.get("test-empty-mappings");

			expect(account).toBeDefined();
			expect(account?.model_mappings).toBeNull();
		});

		it("should handle null model mappings", async () => {
			await createNanoGPTAccount(
				dbOps,
				"test-null-mappings",
				"test-api-key-null",
				0,
				undefined,
				null,
			);

			// Verify account was created with null model mappings
			const db = dbOps.getDatabase();
			const account = db
				.query<{ model_mappings: string | null }, [string]>(
					"SELECT model_mappings FROM accounts WHERE name = ?",
				)
				.get("test-null-mappings");

			expect(account).toBeDefined();
			expect(account?.model_mappings).toBeNull();
		});

		it("should handle zero priority", async () => {
			await createNanoGPTAccount(
				dbOps,
				"test-zero-priority",
				"test-api-key-zero",
				0,
			);

			// Verify account was created
			const db = dbOps.getDatabase();
			const account = db
				.query<{ priority: number }, [string]>(
					"SELECT priority FROM accounts WHERE name = ?",
				)
				.get("test-zero-priority");

			expect(account).toBeDefined();
			expect(account?.priority).toBe(0);
		});

		it("should handle high priority", async () => {
			await createNanoGPTAccount(
				dbOps,
				"test-high-priority",
				"test-api-key-high",
				100,
			);

			// Verify account was created
			const db = dbOps.getDatabase();
			const account = db
				.query<{ priority: number }, [string]>(
					"SELECT priority FROM accounts WHERE name = ?",
				)
				.get("test-high-priority");

			expect(account).toBeDefined();
			expect(account?.priority).toBe(100);
		});

		it("should store API key in api_key field", async () => {
			await createNanoGPTAccount(
				dbOps,
				"test-api-key-field",
				"test-stored-api-key",
				5,
			);

			// Verify API key is stored in api_key field
			const db = dbOps.getDatabase();
			const account = db
				.query<{ api_key: string }, [string]>(
					"SELECT api_key FROM accounts WHERE name = ?",
				)
				.get("test-api-key-field");

			expect(account).toBeDefined();
			expect(account?.api_key).toBe("test-stored-api-key");
		});

		it("should store API key as access token for consistency", async () => {
			await createNanoGPTAccount(
				dbOps,
				"test-access-token",
				"test-api-key-token",
				5,
			);

			// Verify access_token stores the API key
			const db = dbOps.getDatabase();
			const account = db
				.query<{ access_token: string }, [string]>(
					"SELECT access_token FROM accounts WHERE name = ?",
				)
				.get("test-access-token");

			expect(account).toBeDefined();
			expect(account?.access_token).toBe("test-api-key-token");
		});
	});
});
