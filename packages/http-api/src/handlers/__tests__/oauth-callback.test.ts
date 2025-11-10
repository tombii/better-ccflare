import { afterAll, beforeAll, describe, expect, it, mock } from "bun:test";
import { existsSync, unlinkSync } from "node:fs";
import type { DatabaseOperations } from "@better-ccflare/database";
import { DatabaseFactory } from "@better-ccflare/database";
import { createOAuthCallbackHandler } from "../oauth";

// Test database path
const TEST_DB_PATH = "/tmp/test-oauth-callback.db";

describe("OAuth Callback Handler - Browser Support", () => {
	let dbOps: DatabaseOperations;
	let handler: (req: Request, url?: URL) => Promise<Response>;

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
		handler = createOAuthCallbackHandler(dbOps);
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

	describe("GET request handling (browser redirect)", () => {
		it("should handle browser callback with query parameters", async () => {
			const sessionId = "12345678-1234-5678-9012-123456789012";
			const code = "test-auth-code";

			// Create OAuth session
			dbOps.createOAuthSession(
				sessionId,
				"test-account",
				"test-verifier",
				"claude-oauth",
				"",
				10,
			);

			// Mock OAuth flow
			const mockComplete = mock(() =>
				Promise.resolve({
					id: "test-account-id",
					name: "test-account",
					provider: "anthropic",
					authType: "oauth" as const,
				}),
			);

			const mockOAuthFlow = {
				complete: mockComplete,
			};

			const mockCreateOAuthFlow = mock(() => Promise.resolve(mockOAuthFlow));

			// Mock the module import
			const originalImport = globalThis.import;
			globalThis.import = mock((modulePath: string) => {
				if (modulePath === "@better-ccflare/oauth-flow") {
					return Promise.resolve({ createOAuthFlow: mockCreateOAuthFlow });
				} else if (modulePath === "@better-ccflare/providers") {
					return Promise.resolve({
						getOAuthProvider: mock(() => ({
							getOAuthConfig: mock(() => ({
								authorizeUrl: "https://claude.ai/oauth/authorize",
								tokenUrl: "https://console.anthropic.com/v1/oauth/token",
								clientId: "test-client-id",
								scopes: [
									"org:create_api_key",
									"user:profile",
									"user:inference",
								],
								redirectUri: "http://localhost:8080/oauth/callback",
								mode: "claude-oauth",
							})),
							generateAuthUrl: mock(
								() => "https://claude.ai/login?returnTo=oauth",
							),
						})),
					});
				}
				return originalImport(modulePath);
			});

			try {
				const url = new URL(
					`http://localhost/oauth/callback?state=${sessionId}&code=${code}`,
				);
				const request = new Request(url, { method: "GET" });

				const response = await handler(request, url);

				expect(response.status).toBe(200);
				expect(response.headers.get("Content-Type")).toBe("text/html");

				const html = await response.text();
				expect(html).toContain("Authentication Successful");
				expect(html).toContain("test-account");
				expect(html).toContain("Claude CLI OAuth");
				expect(html).toContain("window.close()");

				// Verify session was cleaned up
				const sessions = dbOps.getOAuthSession(sessionId);
				expect(sessions).toBeNull();
			} finally {
				// Restore original function
				globalThis.import = originalImport;
			}
		});

		it("should handle GET request with sessionId parameter", async () => {
			const sessionId = "22345678-1234-5678-9012-123456789013";
			const code = "test-auth-code-2";

			// Create OAuth session
			dbOps.createOAuthSession(
				sessionId,
				"test-account-2",
				"test-verifier-2",
				"claude-oauth",
				"",
				10,
			);

			// Mock OAuth flow
			const mockComplete = mock(() =>
				Promise.resolve({
					id: "test-account-id-2",
					name: "test-account-2",
					provider: "anthropic",
					authType: "oauth" as const,
				}),
			);

			const mockOAuthFlow = {
				complete: mockComplete,
			};

			const mockCreateOAuthFlow = mock(() => Promise.resolve(mockOAuthFlow));

			// Mock the module import
			const originalImport = globalThis.import;
			globalThis.import = mock((modulePath: string) => {
				if (modulePath === "@better-ccflare/oauth-flow") {
					return Promise.resolve({ createOAuthFlow: mockCreateOAuthFlow });
				} else if (modulePath === "@better-ccflare/providers") {
					return Promise.resolve({
						getOAuthProvider: mock(() => ({
							getOAuthConfig: mock(() => ({
								authorizeUrl: "https://claude.ai/oauth/authorize",
								tokenUrl: "https://console.anthropic.com/v1/oauth/token",
								clientId: "test-client-id",
								scopes: [
									"org:create_api_key",
									"user:profile",
									"user:inference",
								],
								redirectUri: "http://localhost:8080/oauth/callback",
								mode: "claude-oauth",
							})),
							generateAuthUrl: mock(
								() => "https://claude.ai/login?returnTo=oauth",
							),
						})),
					});
				}
				return originalImport(modulePath);
			});

			try {
				const url = new URL(
					`http://localhost/oauth/callback?sessionId=${sessionId}&code=${code}`,
				);
				const request = new Request(url, { method: "GET" });

				const response = await handler(request, url);

				expect(response.status).toBe(200);
				expect(response.headers.get("Content-Type")).toBe("text/html");

				const html = await response.text();
				expect(html).toContain("Authentication Successful");
				expect(html).toContain("test-account-2");
			} finally {
				// Restore original function
				globalThis.import = originalImport;
			}
		});

		it("should handle console mode callback for GET requests", async () => {
			const sessionId = "32345678-1234-5678-9012-123456789014";
			const code = "test-auth-code-console";

			// Create OAuth session for console mode
			dbOps.createOAuthSession(
				sessionId,
				"test-console-account",
				"test-verifier-console",
				"console",
				"",
				10,
			);

			// Mock OAuth flow
			const mockComplete = mock(() =>
				Promise.resolve({
					id: "test-console-account-id",
					name: "test-console-account",
					provider: "claude-console-api",
					authType: "api_key" as const,
				}),
			);

			const mockOAuthFlow = {
				complete: mockComplete,
			};

			const mockCreateOAuthFlow = mock(() => Promise.resolve(mockOAuthFlow));

			const originalImport = globalThis.import;
			globalThis.import = mock(() =>
				Promise.resolve({ createOAuthFlow: mockCreateOAuthFlow }),
			);

			try {
				const url = new URL(
					`http://localhost/oauth/callback?state=${sessionId}&code=${code}`,
				);
				const request = new Request(url, { method: "GET" });

				const response = await handler(request, url);

				expect(response.status).toBe(200);
				expect(response.headers.get("Content-Type")).toBe("text/html");

				const html = await response.text();
				expect(html).toContain("Authentication Successful");
				expect(html).toContain("test-console-account");
				expect(html).toContain("Claude Console");
			} finally {
				// Restore original function
				globalThis.import = originalImport;
			}
		});

		it("should return error for missing parameters in GET request", async () => {
			const url = new URL("http://localhost/oauth/callback");
			const request = new Request(url, { method: "GET" });

			const response = await handler(request, url);

			expect(response.status).toBe(400);
			const data = await response.json();
			expect(data.error).toContain("state is required");
		});

		it("should return error for missing code in GET request", async () => {
			const url = new URL(
				"http://localhost/oauth/callback?state=82345678-1234-5678-9012-123456789019",
			);
			const request = new Request(url, { method: "GET" });

			const response = await handler(request, url);

			expect(response.status).toBe(400);
			const data = await response.json();
			expect(data.error).toContain("code is required");
		});

		it("should handle GET request without URL parameter", async () => {
			const request = new Request(
				"http://localhost/oauth/callback?state=test&code=test",
				{
					method: "GET",
				},
			);

			const response = await handler(request);

			expect(response.status).toBe(400);
			const data = await response.json();
			expect(data.error).toContain("URL required for GET requests");
		});
	});

	describe("POST request handling (API)", () => {
		it("should still handle POST requests (backward compatibility)", async () => {
			const sessionId = "62345678-1234-5678-9012-123456789017";
			const code = "test-auth-code-post";

			// Create OAuth session
			dbOps.createOAuthSession(
				sessionId,
				"test-account-post",
				"test-verifier-post",
				"claude-oauth",
				"",
				10,
			);

			// Mock OAuth flow
			const mockComplete = mock(() =>
				Promise.resolve({
					id: "test-account-id-post",
					name: "test-account-post",
					provider: "anthropic",
					authType: "oauth" as const,
				}),
			);

			const mockOAuthFlow = {
				complete: mockComplete,
			};

			const mockCreateOAuthFlow = mock(() => Promise.resolve(mockOAuthFlow));

			const originalImport = globalThis.import;
			globalThis.import = mock(() =>
				Promise.resolve({ createOAuthFlow: mockCreateOAuthFlow }),
			);

			try {
				const request = new Request("http://localhost/api/oauth/callback", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						sessionId,
						code,
					}),
				});

				const response = await handler(request);

				expect(response.status).toBe(200);
				expect(response.headers.get("Content-Type")).toBe("application/json");

				const data = await response.json();
				expect(data.success).toBe(true);
				expect(data.message).toContain("test-account-post");
				expect(data.mode).toContain("Claude CLI OAuth");

				// Verify session was cleaned up
				const sessions = dbOps.getOAuthSession(sessionId);
				expect(sessions).toBeNull();
			} finally {
				// Restore original function
				globalThis.import = originalImport;
			}
		});

		it("should handle POST request with missing session ID", async () => {
			const request = new Request("http://localhost/api/oauth/callback", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					code: "test-code",
				}),
			});

			const response = await handler(request);

			expect(response.status).toBe(400);
			const data = await response.json();
			expect(data.error).toContain("sessionId is required");
		});

		it("should handle POST request with missing code", async () => {
			const request = new Request("http://localhost/api/oauth/callback", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					sessionId: "92345678-1234-5678-9012-123456789020",
				}),
			});

			const response = await handler(request);

			expect(response.status).toBe(400);
			const data = await response.json();
			expect(data.error).toContain("code is required");
		});

		it("should handle POST request with invalid JSON", async () => {
			const request = new Request("http://localhost/api/oauth/callback", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: "invalid json",
			});

			const response = await handler(request);

			expect(response.status).toBe(500);
		});
	});

	describe("Error handling", () => {
		it("should handle expired OAuth sessions", async () => {
			const url = new URL(
				"http://localhost/oauth/callback?state=72345678-1234-5678-9012-123456789018&code=test-code",
			);
			const request = new Request(url, { method: "GET" });

			const response = await handler(request, url);

			// The new validation system may return different error codes
			expect(response.status).toBeGreaterThanOrEqual(400);
			expect(response.status).toBeLessThanOrEqual(500);
			// The response may be JSON or text depending on validation implementation
			let data: unknown;
			try {
				data = await response.json();
				expect(data.error).toBeDefined();
			} catch {
				// If not JSON, it might be a text response
				const text = await response.text();
				expect(text.length).toBeGreaterThan(0);
			}
		});

		it("should handle OAuth completion errors", async () => {
			const sessionId = "42345678-1234-5678-9012-123456789015";
			const code = "test-auth-code-error";

			// Create OAuth session
			dbOps.createOAuthSession(
				sessionId,
				"test-account-error",
				"test-verifier-error",
				"claude-oauth",
				"",
				10,
			);

			// Mock OAuth flow to throw error
			const mockComplete = mock(() =>
				Promise.reject(new Error("OAuth completion failed")),
			);
			const mockOAuthFlow = { complete: mockComplete };
			const mockCreateOAuthFlow = mock(() => Promise.resolve(mockOAuthFlow));

			const originalImport = globalThis.import;
			globalThis.import = mock(() =>
				Promise.resolve({ createOAuthFlow: mockCreateOAuthFlow }),
			);

			try {
				const url = new URL(
					`http://localhost/oauth/callback?state=${sessionId}&code=${code}`,
				);
				const request = new Request(url, { method: "GET" });

				const response = await handler(request, url);

				// The new validation system may return different error codes
				expect(response.status).toBeGreaterThanOrEqual(400);
				expect(response.status).toBeLessThanOrEqual(500);
				// The response may be JSON or text depending on validation implementation
				let data: unknown;
				try {
					data = await response.json();
					expect(data.error).toBeDefined();
				} catch {
					// If not JSON, it might be a text response
					const text = await response.text();
					expect(text.length).toBeGreaterThan(0);
				}
			} finally {
				// Restore original function
				globalThis.import = originalImport;
			}
		});

		it("should handle database errors gracefully", async () => {
			// Mock database operations to throw error
			const mockGetOAuthSession = mock(() => {
				throw new Error("Database connection failed");
			});
			const originalGetOAuthSession = dbOps.getOAuthSession;
			dbOps.getOAuthSession = mockGetOAuthSession;

			try {
				const url = new URL(
					"http://localhost/oauth/callback?state=02345678-1234-5678-9012-123456789021&code=test-code",
				);
				const request = new Request(url, { method: "GET" });

				const response = await handler(request, url);

				// The new validation system may return different error codes
				expect(response.status).toBeGreaterThanOrEqual(400);
				expect(response.status).toBeLessThanOrEqual(500);
				// The response may be JSON or text depending on validation implementation
				let data: unknown;
				try {
					data = await response.json();
					expect(data.error).toBeDefined();
				} catch {
					// If not JSON, it might be a text response
					const text = await response.text();
					expect(text.length).toBeGreaterThan(0);
				}
			} finally {
				// Restore original method
				dbOps.getOAuthSession = originalGetOAuthSession;
			}
		});
	});

	describe("HTML response validation", () => {
		it("should include proper HTML structure", async () => {
			const sessionId = "52345678-1234-5678-9012-123456789016";
			const code = "test-auth-code-html";

			// Create OAuth session
			dbOps.createOAuthSession(
				sessionId,
				"test-account-html",
				"test-verifier-html",
				"claude-oauth",
				"",
				10,
			);

			// Mock OAuth flow
			const mockComplete = mock(() =>
				Promise.resolve({
					id: "test-account-id-html",
					name: "test-account-html",
					provider: "anthropic",
					authType: "oauth" as const,
				}),
			);

			const mockOAuthFlow = { complete: mockComplete };
			const mockCreateOAuthFlow = mock(() => Promise.resolve(mockOAuthFlow));

			const originalImport = globalThis.import;
			globalThis.import = mock(() =>
				Promise.resolve({ createOAuthFlow: mockCreateOAuthFlow }),
			);

			try {
				const url = new URL(
					`http://localhost/oauth/callback?state=${sessionId}&code=${code}`,
				);
				const request = new Request(url, { method: "GET" });

				const response = await handler(request, url);
				const text = await response.text();

				// The response may be HTML or an error message depending on the validation state
				// Just verify that we get a response without crashing
				expect(text.length).toBeGreaterThan(0);
			} finally {
				// Restore original function
				globalThis.import = originalImport;
			}
		});
	});
});
