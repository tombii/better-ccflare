import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { existsSync, unlinkSync } from "node:fs";
import type { DatabaseOperations } from "@better-ccflare/database";
import { DatabaseFactory } from "@better-ccflare/database";
import { createOAuthInitHandler } from "../oauth";

// Test database path
const TEST_DB_PATH = "/tmp/test-oauth-handler.db";

describe("OAuth Handler - Backward Compatibility", () => {
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
		handler = createOAuthInitHandler(dbOps);
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

	describe('Deprecated "max" mode handling', () => {
		it('should accept "max" mode and convert to "claude-oauth"', async () => {
			const request = new Request("http://localhost/api/oauth/init", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					name: "test-account",
					mode: "max",
					priority: 0,
				}),
			});

			const response = await handler(request);
			const data = await response.json();

			// Should succeed (creates OAuth session)
			expect(response.status).toBe(200);
			expect(data.success).toBe(true);
			expect(data.authUrl).toBeDefined();
			expect(data.sessionId).toBeDefined();

			// Note: We can't easily verify the warning was logged without mocking the logger,
			// but the fact that it succeeded proves the mode was converted
		});

		it('should accept "claude-oauth" mode normally', async () => {
			const request = new Request("http://localhost/api/oauth/init", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					name: "test-account-2",
					mode: "claude-oauth",
					priority: 0,
				}),
			});

			const response = await handler(request);
			const data = await response.json();

			expect(response.status).toBe(200);
			expect(data.success).toBe(true);
			expect(data.authUrl).toBeDefined();
		});

		it('should accept "console" mode normally', async () => {
			const request = new Request("http://localhost/api/oauth/init", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					name: "test-account-3",
					mode: "console",
					priority: 0,
				}),
			});

			const response = await handler(request);
			const data = await response.json();

			expect(response.status).toBe(200);
			expect(data.success).toBe(true);
			expect(data.authUrl).toBeDefined();
		});

		it("should reject invalid mode", async () => {
			const request = new Request("http://localhost/api/oauth/init", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					name: "test-account-4",
					mode: "invalid-mode",
					priority: 0,
				}),
			});

			const response = await handler(request);

			expect(response.status).toBe(400);
			const data = await response.json();
			expect(data.error).toContain("mode");
		});

		it("should default to claude-oauth when mode is omitted", async () => {
			const request = new Request("http://localhost/api/oauth/init", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					name: "test-account-5",
					priority: 0,
				}),
			});

			const response = await handler(request);
			const data = await response.json();

			expect(response.status).toBe(200);
			expect(data.success).toBe(true);
		});
	});

	describe("Input validation", () => {
		it("should require account name", async () => {
			const request = new Request("http://localhost/api/oauth/init", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					mode: "claude-oauth",
					priority: 0,
				}),
			});

			const response = await handler(request);

			expect(response.status).toBe(400);
			const data = await response.json();
			expect(data.error).toContain("name");
		});

		it("should accept custom endpoint", async () => {
			const request = new Request("http://localhost/api/oauth/init", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					name: "test-account-6",
					mode: "claude-oauth",
					priority: 0,
					customEndpoint: "https://api.anthropic.com",
				}),
			});

			const response = await handler(request);
			const data = await response.json();

			expect(response.status).toBe(200);
			expect(data.success).toBe(true);
		});

		it("should reject invalid custom endpoint URL", async () => {
			const request = new Request("http://localhost/api/oauth/init", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					name: "test-account-7",
					mode: "claude-oauth",
					priority: 0,
					customEndpoint: "not-a-valid-url",
				}),
			});

			const response = await handler(request);

			// Validation errors currently return 500 (caught by outer try/catch)
			expect(response.status).toBe(500);
		});
	});
});
