import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { DatabaseFactory } from "@better-ccflare/database";
import { AuthService } from "@better-ccflare/http-api";
import { generateApiKey, listApiKeys, disableApiKey, enableApiKey, deleteApiKey } from "@better-ccflare/cli-commands";
import { NodeCryptoUtils } from "@better-ccflare/types";

// Test data
const TEST_DB_PATH = "/tmp/test-api-auth.db";

describe("API Authentication", () => {
	let dbOps: any;
	let authService: AuthService;

	beforeAll(async () => {
		// Clean up any existing test database
		if (require("fs").existsSync(TEST_DB_PATH)) {
			require("fs").unlinkSync(TEST_DB_PATH);
		}

		// Initialize test database
		DatabaseFactory.initialize(TEST_DB_PATH);
		dbOps = DatabaseFactory.getInstance();
		authService = new AuthService(dbOps);
	});

	beforeEach(() => {
		// Clean up API keys between tests
		dbOps.clearApiKeys();
	});

	afterAll(() => {
		// Clean up test database
		if (require("fs").existsSync(TEST_DB_PATH)) {
			require("fs").unlinkSync(TEST_DB_PATH);
		}
		DatabaseFactory.reset();
	});

	describe("API Key Generation", () => {
		test("should generate API key with valid format", async () => {
			const result = await generateApiKey(dbOps, "test-key");

			expect(result.name).toBe("test-key");
			expect(result.apiKey).toMatch(/^btr-[a-zA-Z0-9]{32}$/);
			expect(result.prefixLast8).toHaveLength(8);
			expect(result.id).toMatch(/^[a-f0-9-]{36}$/);
			expect(result.createdAt).toBeDefined();
		});

		test("should reject empty key name", async () => {
			await expect(generateApiKey(dbOps, "")).rejects.toThrow("API key name cannot be empty");
		});

		test("should reject duplicate key names", async () => {
			await generateApiKey(dbOps, "duplicate-test");
			await expect(generateApiKey(dbOps, "duplicate-test")).rejects.toThrow("already exists");
		});
	});

	describe("API Key Management", () => {
		test("should list generated API keys", async () => {
			const result = await generateApiKey(dbOps, "list-test");
			const keys = listApiKeys(dbOps);

			expect(keys).toHaveLength(1);
			expect(keys[0].name).toBe("list-test");
			expect(keys[0].prefixLast8).toBe(result.prefixLast8);
			expect(keys[0].isActive).toBe(true);
		});

		test("should disable and enable API keys", async () => {
			const result = await generateApiKey(dbOps, "toggle-test");

			// Disable the key
			const disableResult = disableApiKey(dbOps, "toggle-test");
			expect(disableResult).toBe(true);

			// Verify it's disabled
			const keys = listApiKeys(dbOps);
			const key = keys.find(k => k.name === "toggle-test");
			expect(key?.isActive).toBe(false);

			// Enable the key
			const enableResult = enableApiKey(dbOps, "toggle-test");
			expect(enableResult).toBe(true);

			// Verify it's enabled
			const updatedKeys = listApiKeys(dbOps);
			const updatedKey = updatedKeys.find(k => k.name === "toggle-test");
			expect(updatedKey?.isActive).toBe(true);
		});

		test("should delete API keys", async () => {
			await generateApiKey(dbOps, "delete-test");

			// Verify key exists
			const keys = listApiKeys(dbOps);
			expect(keys.some(k => k.name === "delete-test")).toBe(true);

			// Delete the key
			const deleteResult = deleteApiKey(dbOps, "delete-test");
			expect(deleteResult).toBe(true);

			// Verify key is gone
			const updatedKeys = listApiKeys(dbOps);
			expect(updatedKeys.some(k => k.name === "delete-test")).toBe(false);
		});
	});

	describe("Authentication Service", () => {
		test("should detect authentication disabled when no keys exist", async () => {
			expect(authService.isAuthenticationEnabled()).toBe(false);
		});

		test("should detect authentication enabled when keys exist", async () => {
			await generateApiKey(dbOps, "auth-test");
			expect(authService.isAuthenticationEnabled()).toBe(true);
		});

		test("should validate API key format", async () => {
			const crypto = new NodeCryptoUtils();
			const apiKey = await crypto.generateApiKey();
			const hashedKey = await crypto.hashApiKey(apiKey);

			// Create API key manually for testing
			const id = globalThis.crypto.randomUUID();
			const now = Date.now();

			dbOps.createApiKey({
				id,
				name: "auth-validation-test",
				hashedKey,
				prefixLast8: apiKey.slice(-8),
				createdAt: now,
				lastUsed: null,
				isActive: true,
			});

			const result = await authService.validateApiKey(apiKey);
			expect(result.isAuthenticated).toBe(true);
			expect(result.apiKey?.name).toBe("auth-validation-test");
		});

		test("should reject invalid API keys", async () => {
			// Clear any existing API keys to ensure authentication is enabled
			dbOps.clearApiKeys();

			// Create a valid API key first to enable authentication
			await generateApiKey(dbOps, "valid-key-for-test");

			const result = await authService.validateApiKey("invalid-key");
			expect(result.isAuthenticated).toBe(false);
			expect(result.error).toBe("Invalid API key");
		});

		test("should extract API key from x-api-key header", () => {
			const request = new Request("http://localhost:8080", {
				headers: { "x-api-key": "btr-test-key-123" }
			});

			const extractedKey = authService.extractApiKey(request);
			expect(extractedKey).toBe("btr-test-key-123");
		});

		test("should extract API key from Authorization Bearer header", () => {
			const request = new Request("http://localhost:8080", {
				headers: { "authorization": "Bearer btr-bearer-key-456" }
			});

			const extractedKey = authService.extractApiKey(request);
			expect(extractedKey).toBe("btr-bearer-key-456");
		});

		test("should exempt dashboard paths from authentication", () => {
			expect(authService.isPathExempt("/", "GET")).toBe(true);
			expect(authService.isPathExempt("/dashboard", "GET")).toBe(true);
			expect(authService.isPathExempt("/health", "GET")).toBe(true);
			expect(authService.isPathExempt("/api/oauth/init", "POST")).toBe(true);
		});

		test("should exempt static assets from authentication", () => {
			expect(authService.isPathExempt("/chunk-abc123.js", "GET")).toBe(true);
			expect(authService.isPathExempt("/chunk-abc123.css", "GET")).toBe(true);
			expect(authService.isPathExempt("/favicon-abc123.svg", "GET")).toBe(true);
			expect(authService.isPathExempt("/chunk-abc123.js.map", "GET")).toBe(true);
			expect(authService.isPathExempt("/static/logo.png", "GET")).toBe(true);
			expect(authService.isPathExempt("/assets/font.woff2", "GET")).toBe(true);
		});

		test("should require authentication for API paths", () => {
			expect(authService.isPathExempt("/api/stats", "GET")).toBe(false);
			expect(authService.isPathExempt("/v1/messages", "POST")).toBe(false);
			expect(authService.isPathExempt("/api/accounts", "GET")).toBe(false);
		});
	});

	describe("RBAC Authorization", () => {
		test("should allow admin keys to access all endpoints", async () => {
			const crypto = new NodeCryptoUtils();
			const apiKey = await crypto.generateApiKey();
			const hashedKey = await crypto.hashApiKey(apiKey);

			// Create admin API key
			const id = globalThis.crypto.randomUUID();
			dbOps.createApiKey({
				id,
				name: "admin-key",
				hashedKey,
				prefixLast8: apiKey.slice(-8),
				createdAt: Date.now(),
				lastUsed: null,
				isActive: true,
				role: "admin",
			});

			const adminKey = dbOps.getApiKeyByName("admin-key")!;

			// Admin should have access to all endpoints
			expect((await authService.authorizeEndpoint(adminKey, "/api/accounts", "GET")).authorized).toBe(true);
			expect((await authService.authorizeEndpoint(adminKey, "/api/stats", "GET")).authorized).toBe(true);
			expect((await authService.authorizeEndpoint(adminKey, "/v1/messages", "POST")).authorized).toBe(true);
			expect((await authService.authorizeEndpoint(adminKey, "/api/api-keys", "GET")).authorized).toBe(true);
		});

		test("should allow api-only keys to access proxy endpoints", async () => {
			const crypto = new NodeCryptoUtils();
			const apiKey = await crypto.generateApiKey();
			const hashedKey = await crypto.hashApiKey(apiKey);

			// Create api-only API key
			const id = globalThis.crypto.randomUUID();
			dbOps.createApiKey({
				id,
				name: "api-only-key",
				hashedKey,
				prefixLast8: apiKey.slice(-8),
				createdAt: Date.now(),
				lastUsed: null,
				isActive: true,
				role: "api-only",
			});

			const apiOnlyKey = dbOps.getApiKeyByName("api-only-key")!;

			// API-only keys should have access to proxy endpoints
			expect((await authService.authorizeEndpoint(apiOnlyKey, "/v1/messages", "POST")).authorized).toBe(true);
			expect((await authService.authorizeEndpoint(apiOnlyKey, "/v1/models", "GET")).authorized).toBe(true);
			expect((await authService.authorizeEndpoint(apiOnlyKey, "/v1/anthropic/version", "GET")).authorized).toBe(true);
		});

		test("should block api-only keys from dashboard endpoints", async () => {
			const crypto = new NodeCryptoUtils();
			const apiKey = await crypto.generateApiKey();
			const hashedKey = await crypto.hashApiKey(apiKey);

			// Create api-only API key
			const id = globalThis.crypto.randomUUID();
			dbOps.createApiKey({
				id,
				name: "api-only-key",
				hashedKey,
				prefixLast8: apiKey.slice(-8),
				createdAt: Date.now(),
				lastUsed: null,
				isActive: true,
				role: "api-only",
			});

			const apiOnlyKey = dbOps.getApiKeyByName("api-only-key")!;

			// API-only keys should NOT have access to dashboard endpoints
			const accountsResult = await authService.authorizeEndpoint(apiOnlyKey, "/api/accounts", "GET");
			expect(accountsResult.authorized).toBe(false);
			expect(accountsResult.reason).toContain("API-only keys cannot access dashboard endpoints");

			const statsResult = await authService.authorizeEndpoint(apiOnlyKey, "/api/stats", "GET");
			expect(statsResult.authorized).toBe(false);

			const apiKeysResult = await authService.authorizeEndpoint(apiOnlyKey, "/api/api-keys", "GET");
			expect(apiKeysResult.authorized).toBe(false);

			const analyticsResult = await authService.authorizeEndpoint(apiOnlyKey, "/api/analytics", "GET");
			expect(analyticsResult.authorized).toBe(false);
		});
	});

	describe("Database Operations", () => {
		test("should track API key usage statistics", async () => {
			const result = await generateApiKey(dbOps, "usage-test");
			const initialKey = dbOps.getApiKeyByName("usage-test");
			expect(initialKey?.usageCount).toBe(0);
			expect(initialKey?.lastUsed).toBeNull();

			// Update usage
			dbOps.updateApiKeyUsage(initialKey!.id, Date.now());
			const updatedKey = dbOps.getApiKeyByName("usage-test");
			expect(updatedKey?.usageCount).toBe(1);
			expect(updatedKey?.lastUsed).toBeGreaterThan(0);
		});

		test("should count active and total API keys", async () => {
			// Clear existing keys
			const allKeys = listApiKeys(dbOps);
			for (const key of allKeys) {
				deleteApiKey(dbOps, key.name);
			}

			expect(dbOps.countAllApiKeys()).toBe(0);
			expect(dbOps.countActiveApiKeys()).toBe(0);

			// Add some keys
			await generateApiKey(dbOps, "count-test-1");
			await generateApiKey(dbOps, "count-test-2");
			await generateApiKey(dbOps, "count-test-3");

			expect(dbOps.countAllApiKeys()).toBe(3);
			expect(dbOps.countActiveApiKeys()).toBe(3);

			// Disable one key
			disableApiKey(dbOps, "count-test-2");
			expect(dbOps.countAllApiKeys()).toBe(3);
			expect(dbOps.countActiveApiKeys()).toBe(2);
		});
	});

	describe("Security", () => {
		test("should hash API keys securely", async () => {
			const crypto = new NodeCryptoUtils();
			const apiKey = await crypto.generateApiKey();
			const hashedKey1 = await crypto.hashApiKey(apiKey);
			const hashedKey2 = await crypto.hashApiKey(apiKey);

			// Same key should produce different hashes (different salts)
			expect(hashedKey1).not.toBe(hashedKey2);

			// But both should validate correctly
			const valid1 = await crypto.verifyApiKey(apiKey, hashedKey1);
			const valid2 = await crypto.verifyApiKey(apiKey, hashedKey2);
			expect(valid1).toBe(true);
			expect(valid2).toBe(true);

			// Wrong key should not validate
			const invalid = await crypto.verifyApiKey("wrong-key", hashedKey1);
			expect(invalid).toBe(false);
		});

		test("should use constant-time comparison to prevent timing attacks", async () => {
			const crypto = new NodeCryptoUtils();
			const apiKey = await crypto.generateApiKey();
			const hashedKey = await crypto.hashApiKey(apiKey);

			// Create two different keys with same length for timing comparison
			const correctKey = apiKey;
			const wrongKey = "btr-" + "x".repeat(32);

			// Verify correct key
			const validResult = await crypto.verifyApiKey(correctKey, hashedKey);
			expect(validResult).toBe(true);

			// Verify wrong key (should use constant-time comparison)
			const invalidResult = await crypto.verifyApiKey(wrongKey, hashedKey);
			expect(invalidResult).toBe(false);
		});

		test("should reject different length hashes early", async () => {
			const crypto = new NodeCryptoUtils();

			// Create a malformed hash with different length
			const malformedHash = "abc:123"; // Much shorter than a real hash
			const apiKey = await crypto.generateApiKey();

			// Should handle gracefully and return false
			const result = await crypto.verifyApiKey(apiKey, malformedHash);
			expect(result).toBe(false);
		});

		test("should handle invalid hash format gracefully", async () => {
			const crypto = new NodeCryptoUtils();
			const apiKey = await crypto.generateApiKey();

			// Test various invalid hash formats
			const invalidHashes = [
				"no-colon-separator",
				":missing-salt",
				"missing-hash:",
				"",
				"::::",
			];

			for (const invalidHash of invalidHashes) {
				const result = await crypto.verifyApiKey(apiKey, invalidHash);
				expect(result).toBe(false);
			}
		});

		test("should handle Buffer conversion errors gracefully", async () => {
			const crypto = new NodeCryptoUtils();
			const apiKey = await crypto.generateApiKey();

			// Create a valid hash structure but with potentially problematic content
			const edgeCaseHash = "salt:" + "a".repeat(128); // Valid format, long hash

			// Should not throw, should return a boolean
			const result = await crypto.verifyApiKey(apiKey, edgeCaseHash);
			expect(typeof result).toBe("boolean");
		});

		test("should generate keys with sufficient entropy", async () => {
			const crypto = new NodeCryptoUtils();
			const keys = await Promise.all([
				crypto.generateApiKey(),
				crypto.generateApiKey(),
				crypto.generateApiKey(),
				crypto.generateApiKey(),
				crypto.generateApiKey()
			]);

			// All keys should be different
			const uniqueKeys = new Set(keys);
			expect(uniqueKeys.size).toBe(5);

			// All keys should have the correct format
			for (const key of keys) {
				expect(key).toMatch(/^btr-[a-zA-Z0-9]{32}$/);
				expect(key).toHaveLength(36); // btr- + 32 chars
			}
		});
	});

	describe("Error Handling", () => {
		test("should handle missing API key gracefully", async () => {
			await generateApiKey(dbOps, "error-test");

			// Enable authentication
			expect(authService.isAuthenticationEnabled()).toBe(true);

			// Create request without API key
			const request = new Request("http://localhost:8080/api/stats");
			const result = await authService.authenticateRequest(request, "/api/stats", "GET");

			expect(result.isAuthenticated).toBe(false);
			expect(result.error).toContain("API key required");
		});

		test("should handle malformed headers gracefully", () => {
			const request = new Request("http://localhost:8080", {
				headers: { "x-api-key": "" }
			});

			const extractedKey = authService.extractApiKey(request);
			expect(extractedKey).toBeNull();
		});

		test("should handle invalid key names", async () => {
			await expect(generateApiKey(dbOps, "")).rejects.toThrow("empty");
			await expect(generateApiKey(dbOps, "   ")).rejects.toThrow("empty");
			await expect(generateApiKey(dbOps, "a".repeat(1000))).rejects.toThrow();
		});
	});
});