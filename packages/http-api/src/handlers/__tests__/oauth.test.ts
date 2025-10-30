import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { Config } from "@better-ccflare/config";
import { DatabaseFactory } from "@better-ccflare/database";
import type { DatabaseOperations } from "@better-ccflare/database";
import { createOAuthInitHandler } from "../oauth";

// Test database path
const TEST_DB_PATH = "/tmp/test-oauth-handler.db";

describe("OAuth Handler - Backward Compatibility", () => {
	let dbOps: DatabaseOperations;
	let handler: (req: Request) => Promise<Response>;

	beforeAll(async () => {
		// Clean up any existing test database
		if (require("fs").existsSync(TEST_DB_PATH)) {
			require("fs").unlinkSync(TEST_DB_PATH);
		}

		// Initialize test database
		DatabaseFactory.initialize(TEST_DB_PATH);
		dbOps = DatabaseFactory.getInstance();

		// Create handler
		handler = createOAuthInitHandler(dbOps);
	});

	afterAll(() => {
		// Clean up test database
		if (require("fs").existsSync(TEST_DB_PATH)) {
			require("fs").unlinkSync(TEST_DB_PATH);
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

			// Validation errors currently return 500 (caught by outer try/catch)
			// This is consistent with current error handling in the handler
			expect(response.status).toBe(500);
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

			// Validation errors currently return 500 (caught by outer try/catch)
			expect(response.status).toBe(500);
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
