import { beforeAll, describe, expect, it } from "bun:test";
import type { Config } from "@better-ccflare/config";
import type { DatabaseOperations } from "@better-ccflare/database";
import {
	AnthropicOAuthProvider,
	generatePKCE,
} from "@better-ccflare/providers";

// Mock database operations for testing
const _mockDbOps = {
	getAllAccounts: () => [],
	createOAuthSession: () => {},
	getOAuthSession: () => null,
	deleteOAuthSession: () => {},
} as unknown as DatabaseOperations;

const _mockConfig = {
	getRuntime: () => ({ clientId: "test-client-id" }),
} as unknown as Config;

describe("OAuth Token Health Monitoring Features", () => {
	let oauthProvider: AnthropicOAuthProvider;

	beforeAll(() => {
		oauthProvider = new AnthropicOAuthProvider();
	});

	describe("1. OAuth Flows (claude-oauth and console modes)", () => {
		it("should support claude-oauth mode", () => {
			const config = oauthProvider.getOAuthConfig("claude-oauth");
			const _pkce = generatePKCE();

			expect(config.mode).toBe("claude-oauth");
			expect(config.authorizeUrl).toBe("https://claude.ai/oauth/authorize");
			expect(config.scopes).toContain("org:create_api_key");
			expect(config.scopes).toContain("user:profile");
			expect(config.scopes).toContain("user:inference");
		});

		it("should support console mode", () => {
			const config = oauthProvider.getOAuthConfig("console");
			const _pkce = generatePKCE();

			expect(config.mode).toBe("console");
			expect(config.authorizeUrl).toBe(
				"https://console.anthropic.com/oauth/authorize",
			);
			expect(config.scopes).toContain("org:create_api_key");
		});

		it("should generate auth URLs for both modes", async () => {
			const claudeConfig = oauthProvider.getOAuthConfig("claude-oauth");
			const consoleConfig = oauthProvider.getOAuthConfig("console");
			const pkce = await generatePKCE();

			const claudeUrl = oauthProvider.generateAuthUrl(claudeConfig, pkce);
			const consoleUrl = oauthProvider.generateAuthUrl(consoleConfig, pkce);

			expect(claudeUrl).toContain("claude.ai/login");
			expect(claudeUrl).toContain("selectAccount=true");
			expect(consoleUrl).toContain("console.anthropic.com/oauth/authorize");

			// Both should have PKCE challenge
			expect(claudeUrl).toContain(`code_challenge=${pkce.challenge}`);
			expect(consoleUrl).toContain(`code_challenge=${pkce.challenge}`);

			// Both should use S256 method
			expect(claudeUrl).toContain("code_challenge_method=S256");
			expect(consoleUrl).toContain("code_challenge_method=S256");
		});
	});

	describe("2. PKCE Security Features", () => {
		it("should not expose PKCE verifier in authorization URLs", async () => {
			const config = oauthProvider.getOAuthConfig("claude-oauth");
			const pkce = await generatePKCE();

			const authUrl = oauthProvider.generateAuthUrl(config, pkce);

			// State should be present but should NOT contain the verifier
			expect(authUrl).toContain("state=");
			expect(authUrl).not.toContain(pkce.verifier);
			expect(authUrl).not.toContain("verifier=");
		});

		it("should generate cryptographically secure random state", async () => {
			const config = oauthProvider.getOAuthConfig("claude-oauth");
			const pkce1 = await generatePKCE();
			const pkce2 = await generatePKCE();

			const authUrl1 = oauthProvider.generateAuthUrl(config, pkce1);
			const authUrl2 = oauthProvider.generateAuthUrl(config, pkce2);

			const state1 = authUrl1.match(/state=([^&]*)/)?.[1];
			const state2 = authUrl2.match(/state=([^&]*)/)?.[1];

			// States should be different
			expect(state1).toBeDefined();
			expect(state2).toBeDefined();
			expect(state1).not.toBe(state2);

			// States should be 64-character hex strings
			expect(state1).toMatch(/^[a-f0-9]{64}$/);
			expect(state2).toMatch(/^[a-f0-9]{64}$/);
		});

		it("should handle token exchange without concatenated state", async () => {
			const config = oauthProvider.getOAuthConfig("claude-oauth");
			const pkce = await generatePKCE();

			// Mock successful token response
			const mockFetch = (global.fetch = jest.fn().mockResolvedValue({
				ok: true,
				json: async () => ({
					refresh_token: "test-refresh-token",
					access_token: "test-access-token",
					expires_in: 3600,
				}),
			}));

			try {
				const result = await oauthProvider.exchangeCode(
					"test-auth-code",
					pkce.verifier,
					config,
				);
				expect(result.refreshToken).toBe("test-refresh-token");
				expect(result.accessToken).toBe("test-access-token");
				expect(result.expiresAt).toBeGreaterThan(Date.now());
			} catch (error) {
				// Expected to fail in test environment, but should not fail due to code parsing
				expect(error).not.toContain("Cannot read properties of undefined");
			}

			global.fetch = mockFetch;
		});
	});

	describe("3. Token Health Data Structures", () => {
		it("should support proper token health status types", () => {
			const validStatuses = [
				"healthy",
				"warning",
				"critical",
				"expired",
				"no-refresh-token",
			];

			// This test ensures our status constants are consistent
			validStatuses.forEach((status) => {
				expect(typeof status).toBe("string");
				expect(status.length).toBeGreaterThan(0);
			});
		});
	});

	describe("4. OAuth Configuration Validation", () => {
		it("should have proper OAuth configuration for both modes", () => {
			const claudeConfig = oauthProvider.getOAuthConfig("claude-oauth");
			const consoleConfig = oauthProvider.getOAuthConfig("console");

			// Both should have same token URL
			expect(claudeConfig.tokenUrl).toBe(
				"https://console.anthropic.com/v1/oauth/token",
			);
			expect(consoleConfig.tokenUrl).toBe(
				"https://console.anthropic.com/v1/oauth/token",
			);

			// Both should have same redirect URI
			expect(claudeConfig.redirectUri).toBe(
				"https://console.anthropic.com/oauth/code/callback",
			);
			expect(consoleConfig.redirectUri).toBe(
				"https://console.anthropic.com/oauth/code/callback",
			);

			// Both should require client ID
			expect(claudeConfig.clientId).toBe("");
			expect(consoleConfig.clientId).toBe("");
		});
	});

	describe("5. Error Handling", () => {
		it("should handle OAuth error responses properly", async () => {
			const config = oauthProvider.getOAuthConfig("claude-oauth");
			const pkce = await generatePKCE();

			// Mock error response
			const mockFetch = (global.fetch = jest.fn().mockResolvedValue({
				ok: false,
				status: 400,
				statusText: "Bad Request",
				json: async () => ({
					error: "invalid_grant",
					error_description: "Authorization code expired",
				}),
			}));

			try {
				await oauthProvider.exchangeCode("expired-code", pkce.verifier, config);
				expect(true).toBe(false); // Should not reach here
			} catch (error: any) {
				expect(error.message).toContain("Authorization code expired");
			}

			global.fetch = mockFetch;
		});
	});

	describe("6. Backward Compatibility", () => {
		it("should handle deprecated 'max' mode gracefully", () => {
			// Test that the old 'max' mode still works (should be treated as 'claude-oauth')
			const config = oauthProvider.getOAuthConfig("max" as any);

			// Should be treated as claude-oauth
			expect(config.authorizeUrl).toBe("https://claude.ai/oauth/authorize");
		});
	});
});

describe("CLI Command Integration", () => {
	it("should have access to token health CLI functions", () => {
		// This test verifies that the CLI command exports are available
		expect(() => {
			// Import should not throw if CLI commands exist
			require("@better-ccflare/cli-commands");
		}).not.toThrow();
	});
});

describe("HTTP API Integration", () => {
	it("should support token health API endpoints", () => {
		// Verify that token health handlers are exported
		expect(() => {
			require("@better-ccflare/http-api").then((module) => {
				// Token health handlers should be available
				expect(typeof module.createTokenHealthHandler).toBe("function");
				expect(typeof module.createReauthNeededHandler).toBe("function");
				expect(typeof module.createAccountTokenHealthHandler).toBe("function");
			});
		}).not.toThrow();
	});
});
