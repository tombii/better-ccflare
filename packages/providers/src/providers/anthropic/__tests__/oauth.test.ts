import { describe, expect, it, spyOn } from "bun:test";
import { OAuthError } from "@better-ccflare/core";
import { AnthropicOAuthProvider } from "../oauth";

describe("AnthropicOAuthProvider - Claude OAuth Fixes", () => {
	const createTestProvider = () => new AnthropicOAuthProvider();

	const createMockSuccessResponse = () => ({
		ok: true,
		json: async () => ({
			refresh_token: "test-refresh-token",
			access_token: "test-access-token",
			expires_in: 3600,
		}),
	});

	const createMockErrorResponse = (errorResponse: any, status = 400) => ({
		ok: false,
		status,
		statusText: "Bad Request",
		json: async () => errorResponse,
	});

	const createTestConfig = (overrides: any = {}) => ({
		clientId: "test-client-id",
		redirectUri: "https://console.anthropic.com/oauth/code/callback",
		tokenUrl: "https://console.anthropic.com/v1/oauth/token",
		mode: "claude-oauth",
		...overrides,
	});

	describe("Authorization Code Parsing (code#state format)", () => {
		it("should correctly split authorization code with state parameter", async () => {
			const mockFetch = spyOn(global, "fetch").mockResolvedValueOnce(
				createMockSuccessResponse(),
			);
			const provider = createTestProvider();
			const config = createTestConfig();

			const codeWithState = "authorization-code-123#state-456";
			const verifier = "test-verifier";

			const result = await provider.exchangeCode(
				codeWithState,
				verifier,
				config,
			);

			const requestBody = JSON.parse(mockFetch.mock.calls[0][1].body);
			expect(requestBody.code).toBe("authorization-code-123");
			expect(requestBody.state).toBe("state-456");
			expect(result.refreshToken).toBe("test-refresh-token");
			expect(result.accessToken).toBe("test-access-token");
			mockFetch.mockRestore();
		});

		it("should handle authorization code without state parameter", async () => {
			const mockFetch = spyOn(global, "fetch").mockResolvedValueOnce(
				createMockSuccessResponse(),
			);
			const provider = createTestProvider();
			const config = createTestConfig();

			const codeWithoutState = "authorization-code-only";
			const verifier = "test-verifier";

			const result = await provider.exchangeCode(
				codeWithoutState,
				verifier,
				config,
			);

			const requestBody = JSON.parse(mockFetch.mock.calls[0][1].body);
			expect(requestBody.code).toBe("authorization-code-only");
			expect(requestBody.state).toBeUndefined();
			expect(result.refreshToken).toBe("test-refresh-token");
			mockFetch.mockRestore();
		});

		it("should handle authorization code with multiple # characters", async () => {
			const mockFetch = spyOn(global, "fetch").mockResolvedValueOnce(
				createMockSuccessResponse(),
			);
			const provider = createTestProvider();
			const config = createTestConfig();

			const codeWithMultipleHash = "auth-code#state-param#extra-data";
			const verifier = "test-verifier";

			await provider.exchangeCode(codeWithMultipleHash, verifier, config);

			const requestBody = JSON.parse(mockFetch.mock.calls[0][1].body);
			// Should split on first # only, taking only the first element after split
			expect(requestBody.code).toBe("auth-code");
			expect(requestBody.state).toBe("state-param");
			mockFetch.mockRestore();
		});

		it("should handle empty authorization code", async () => {
			const mockFetch = spyOn(global, "fetch").mockResolvedValueOnce(
				createMockSuccessResponse(),
			);
			const provider = createTestProvider();
			const config = createTestConfig();

			const emptyCode = "#state-only";
			const verifier = "test-verifier";

			await provider.exchangeCode(emptyCode, verifier, config);

			const requestBody = JSON.parse(mockFetch.mock.calls[0][1].body);
			expect(requestBody.code).toBe("");
			expect(requestBody.state).toBe("state-only");
			mockFetch.mockRestore();
		});

		it("should handle empty state parameter", async () => {
			const mockFetch = spyOn(global, "fetch").mockResolvedValueOnce(
				createMockSuccessResponse(),
			);
			const provider = createTestProvider();
			const config = createTestConfig();

			const codeWithEmptyState = "auth-code#";
			const verifier = "test-verifier";

			await provider.exchangeCode(codeWithEmptyState, verifier, config);

			const requestBody = JSON.parse(mockFetch.mock.calls[0][1].body);
			expect(requestBody.code).toBe("auth-code");
			expect(requestBody.state).toBe("");
			mockFetch.mockRestore();
		});
	});

	describe("State Parameter in Token Exchange", () => {
		it("should include state parameter in token exchange request body", async () => {
			const mockFetch = spyOn(global, "fetch").mockResolvedValueOnce(
				createMockSuccessResponse(),
			);
			const provider = createTestProvider();
			const config = createTestConfig();

			const code = "test-auth-code#test-state-123";
			const verifier = "test-verifier";

			await provider.exchangeCode(code, verifier, config);

			const requestBody = JSON.parse(mockFetch.mock.calls[0][1].body);

			// Verify all required parameters are present
			expect(requestBody).toEqual({
				code: "test-auth-code",
				state: "test-state-123",
				grant_type: "authorization_code",
				client_id: "test-client-id",
				redirect_uri: "https://console.anthropic.com/oauth/code/callback",
				code_verifier: "test-verifier",
			});
			mockFetch.mockRestore();
		});

		it("should work with console mode (no state in response)", async () => {
			const mockFetch = spyOn(global, "fetch").mockResolvedValueOnce(
				createMockSuccessResponse(),
			);
			const provider = createTestProvider();
			const config = createTestConfig({ mode: "console" });

			const consoleCode = "console-auth-code";
			const verifier = "test-verifier";

			await provider.exchangeCode(consoleCode, verifier, config);

			const requestBody = JSON.parse(mockFetch.mock.calls[0][1].body);
			expect(requestBody.code).toBe("console-auth-code");
			expect(requestBody.state).toBeUndefined();
			mockFetch.mockRestore();
		});
	});

	describe("Error Handling Improvements", () => {
		it("should handle object-formatted error responses", async () => {
			const errorResponse = {
				error: {
					message: "Invalid request format",
					code: "INVALID_FORMAT",
				},
				error_description: "The request format is invalid",
			};
			const mockFetch = spyOn(global, "fetch").mockResolvedValueOnce(
				createMockErrorResponse(errorResponse),
			);
			const provider = createTestProvider();
			const config = createTestConfig();

			const code = "test-code#test-state";
			const verifier = "test-verifier";

			try {
				await provider.exchangeCode(code, verifier, config);
				expect.fail("Should have thrown OAuthError");
			} catch (error) {
				expect(error).toBeInstanceOf(OAuthError);
				expect(error.message).toBe("The request format is invalid");
				expect(error.provider).toBe("anthropic");
			}
			mockFetch.mockRestore();
		});

		it("should handle string-formatted error responses", async () => {
			const errorResponse = {
				error: "invalid_request",
				error_description: "Invalid request format",
			};
			const mockFetch = spyOn(global, "fetch").mockResolvedValueOnce(
				createMockErrorResponse(errorResponse),
			);
			const provider = createTestProvider();
			const config = createTestConfig();

			const code = "test-code#test-state";
			const verifier = "test-verifier";

			try {
				await provider.exchangeCode(code, verifier, config);
				expect.fail("Should have thrown OAuthError");
			} catch (error) {
				expect(error).toBeInstanceOf(OAuthError);
				expect(error.message).toBe("Invalid request format");
				expect(error.provider).toBe("anthropic");
			}
			mockFetch.mockRestore();
		});

		it("should handle error object without message property", async () => {
			const errorResponse = {
				error: {
					code: "UNKNOWN_ERROR",
					// No message property
				},
			};
			const mockFetch = spyOn(global, "fetch").mockResolvedValueOnce(
				createMockErrorResponse(errorResponse),
			);
			const provider = createTestProvider();
			const config = createTestConfig();

			const code = "test-code#test-state";
			const verifier = "test-verifier";

			try {
				await provider.exchangeCode(code, verifier, config);
				expect.fail("Should have thrown OAuthError");
			} catch (error) {
				expect(error).toBeInstanceOf(OAuthError);
				// Should fall back to stringified object or status text
				expect(error.message).toMatch(/Bad Request|UNKNOWN_ERROR/);
			}
			mockFetch.mockRestore();
		});

		it("should handle non-parseable error responses", async () => {
			const mockFetch = spyOn(global, "fetch").mockResolvedValueOnce({
				ok: false,
				status: 500,
				statusText: "Internal Server Error",
				json: async () => {
					throw new Error("Failed to parse JSON");
				},
			});
			const provider = createTestProvider();
			const config = createTestConfig();

			const code = "test-code#test-state";
			const verifier = "test-verifier";

			try {
				await provider.exchangeCode(code, verifier, config);
				expect.fail("Should have thrown OAuthError");
			} catch (error) {
				expect(error).toBeInstanceOf(OAuthError);
				expect(error.message).toBe("Internal Server Error");
			}
			mockFetch.mockRestore();
		});
	});

	describe("Integration Scenarios", () => {
		it("should handle complete OAuth flow with Claude CLI format", async () => {
			const mockFetch = spyOn(global, "fetch").mockResolvedValueOnce({
				ok: true,
				json: async () => ({
					refresh_token: "refresh-123",
					access_token: "access-456",
					expires_in: 7200,
				}),
			});
			const provider = createTestProvider();
			const config = createTestConfig();

			// Simulate real Claude OAuth response format
			const claudeAuthCode = "au_1x2y3z4a5b6c7d8e9f0#xyz987";
			const pkceVerifier = "pkce-verifier-123";

			const result = await provider.exchangeCode(
				claudeAuthCode,
				pkceVerifier,
				config,
			);

			// Verify the request was formatted correctly
			expect(mockFetch).toHaveBeenCalledTimes(1);
			const requestBody = JSON.parse(mockFetch.mock.calls[0][1].body);

			expect(requestBody.code).toBe("au_1x2y3z4a5b6c7d8e9f0");
			expect(requestBody.state).toBe("xyz987");
			expect(requestBody.grant_type).toBe("authorization_code");
			expect(requestBody.client_id).toBe("test-client-id");
			expect(requestBody.redirect_uri).toBe(
				"https://console.anthropic.com/oauth/code/callback",
			);
			expect(requestBody.code_verifier).toBe("pkce-verifier-123");

			// Verify token result
			expect(result.refreshToken).toBe("refresh-123");
			expect(result.accessToken).toBe("access-456");
			expect(result.expiresAt).toBeGreaterThan(Date.now());
			mockFetch.mockRestore();
		});
	});
});
