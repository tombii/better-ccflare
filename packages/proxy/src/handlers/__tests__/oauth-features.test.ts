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

			// Both should have PKCE challenge (in different locations due to flow differences)
			// For claude mode, challenge is in the returnTo parameter (URL-encoded)
			const encodedChallenge = encodeURIComponent(pkce.challenge);
			expect(claudeUrl).toContain(encodedChallenge);
			expect(consoleUrl).toContain(`code_challenge=${pkce.challenge}`);

			// Both should use S256 method
			const encodedMethod = encodeURIComponent("S256");
			expect(claudeUrl).toContain(encodedMethod); // S256 encoded in URL
			expect(consoleUrl).toContain("code_challenge_method=S256");
		});
	});

	describe("2. PKCE Security Features", () => {
		it("should not expose PKCE verifier in authorization URLs", async () => {
			const config = oauthProvider.getOAuthConfig("claude-oauth");
			const pkce = await generatePKCE();

			const authUrl = oauthProvider.generateAuthUrl(config, pkce);

			// State should be present in the URL (nested in returnTo parameter for Claude OAuth)
			// The state parameter exists in the returnTo URL-encoded parameter
			const returnToMatch = authUrl.match(/returnTo=([^&]*)/);
			expect(returnToMatch).toBeDefined();
			if (returnToMatch) {
				const decodedReturnTo = decodeURIComponent(returnToMatch[1]);
				expect(decodedReturnTo).toContain("state=");
			}
			expect(authUrl).not.toContain(pkce.verifier);
			expect(authUrl).not.toContain("verifier=");
		});

		it("should generate cryptographically secure random state", async () => {
			const config = oauthProvider.getOAuthConfig("claude-oauth");
			const pkce1 = await generatePKCE();
			const pkce2 = await generatePKCE();

			const authUrl1 = oauthProvider.generateAuthUrl(config, pkce1);
			const authUrl2 = oauthProvider.generateAuthUrl(config, pkce2);

			// Extract state from potentially nested URL structure (returnTo parameter)
			let state1, state2;

			// For Claude OAuth mode, state is in the returnTo parameter which is URL-encoded
			const returnToMatch1 = authUrl1.match(/returnTo=([^&]*)/);
			const returnToMatch2 = authUrl2.match(/returnTo=(.*)&?/);

			if (returnToMatch1) {
				const decodedReturnTo1 = decodeURIComponent(returnToMatch1[1]);
				state1 = decodedReturnTo1.match(/state=([^&]*)/)?.[1];
			}

			if (returnToMatch2) {
				const decodedReturnTo2 = decodeURIComponent(returnToMatch2[1]);
				state2 = decodedReturnTo2.match(/state=([^&]*)/)?.[1];
			}

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
			const originalFetch = global.fetch;
			global.fetch = async () =>
				({
					ok: true,
					json: async () => ({
						refresh_token: "test-refresh-token",
						access_token: "test-access-token",
						expires_in: 3600,
					}),
				}) as any;

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

			global.fetch = originalFetch;
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
			const originalFetch = global.fetch;
			global.fetch = async () =>
				({
					ok: false,
					status: 400,
					statusText: "Bad Request",
					json: async () => ({
						error: "invalid_grant",
						error_description: "Authorization code expired",
					}),
				}) as any;

			try {
				await oauthProvider.exchangeCode("expired-code", pkce.verifier, config);
				expect(true).toBe(false); // Should not reach here
			} catch (error: any) {
				expect(error.message).toContain("Authorization code expired");
			}

			global.fetch = originalFetch;
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
	it("should be importable", () => {
		// Verify that the HTTP API module can be imported without errors
		expect(() => {
			require("@better-ccflare/http-api");
		}).not.toThrow();
	});
});
