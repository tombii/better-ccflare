import { afterAll, beforeAll, describe, expect, it, mock } from "bun:test";
import { existsSync, unlinkSync } from "node:fs";
import type { DatabaseOperations } from "@better-ccflare/database";
import { DatabaseFactory } from "@better-ccflare/database";
import { createOAuthFlow } from "@better-ccflare/oauth-flow";
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
			const sessionId = "test-session-id";
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
			const _originalCreateOAuthFlow = createOAuthFlow;

			// Mock the module import
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
			const sessionId = "test-session-id-2";
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

			const originalImport = globalThis.import;
			globalThis.import = mock(() =>
				Promise.resolve({ createOAuthFlow: mockCreateOAuthFlow }),
			);

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
			const sessionId = "test-session-console";
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
			expect(data.error).toContain("Session ID is required");
		});

		it("should return error for missing code in GET request", async () => {
			const url = new URL("http://localhost/oauth/callback?state=test-session");
			const request = new Request(url, { method: "GET" });

			const response = await handler(request, url);

			expect(response.status).toBe(400);
			const data = await response.json();
			expect(data.error).toContain("Authorization code is required");
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
			const sessionId = "test-session-post";
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
			expect(data.error).toContain("Session ID is required");
		});

		it("should handle POST request with missing code", async () => {
			const request = new Request("http://localhost/api/oauth/callback", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					sessionId: "test-session",
				}),
			});

			const response = await handler(request);

			expect(response.status).toBe(400);
			const data = await response.json();
			expect(data.error).toContain("Authorization code is required");
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
				"http://localhost/oauth/callback?state=expired-session&code=test-code",
			);
			const request = new Request(url, { method: "GET" });

			const response = await handler(request, url);

			expect(response.status).toBe(404);
			const data = await response.json();
			expect(data.error).toContain("not found or has expired");
		});

		it("should handle OAuth completion errors", async () => {
			const sessionId = "test-session-error";
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

				expect(response.status).toBe(500);
				const data = await response.json();
				expect(data.error).toContain("OAuth completion failed");
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
					"http://localhost/oauth/callback?state=test-session&code=test-code",
				);
				const request = new Request(url, { method: "GET" });

				const response = await handler(request, url);

				expect(response.status).toBe(500);
				const data = await response.json();
				expect(data.error).toContain("Database connection failed");
			} finally {
				// Restore original method
				dbOps.getOAuthSession = originalGetOAuthSession;
			}
		});
	});

	describe("HTML response validation", () => {
		it("should include proper HTML structure", async () => {
			const sessionId = "test-session-html";
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
				const html = await response.text();

				// Validate HTML structure
				expect(html).toContain("<!DOCTYPE html>");
				expect(html).toContain("<html>");
				expect(html).toContain("<head>");
				expect(html).toContain("<title>Authentication Successful</title>");
				expect(html).toContain("<style>");
				expect(html).toContain("<body>");
				expect(html).toContain("</html>");

				// Validate content
				expect(html).toContain("✅ Authentication Successful");
				expect(html).toContain("test-account-html");
				expect(html).toContain("Claude CLI OAuth");
				expect(html).toContain("You can now close this window");
				expect(html).toContain("Close Window");
				expect(html).toContain("window.close()");
				expect(html).toContain("setTimeout(() => window.close(), 3000)");
			} finally {
				// Restore original function
				globalThis.import = originalImport;
			}
		});
	});
});
