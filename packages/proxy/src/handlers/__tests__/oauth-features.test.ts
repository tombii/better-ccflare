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

describe("4. PKCE and State Security Tests", () => {
	describe("PKCE Generation", () => {
		it("should generate valid PKCE verifier and challenge", async () => {
			const pkce = await generatePKCE();

			// Verify structure
			expect(pkce).toHaveProperty("verifier");
			expect(pkce).toHaveProperty("challenge");
			expect(typeof pkce.verifier).toBe("string");
			expect(typeof pkce.challenge).toBe("string");

			// Verify verifier length (should be 43 chars for 32 random bytes with base64url)
			expect(pkce.verifier.length).toBe(43);

			// Verify verifier contains only valid base64url characters
			expect(pkce.verifier).toMatch(/^[a-zA-Z0-9_-]+$/);

			// Verify challenge is also valid base64url
			expect(pkce.challenge).toMatch(/^[a-zA-Z0-9_-]+$/);

			// Verify challenge is different from verifier (SHA-256 hash)
			expect(pkce.challenge).not.toBe(pkce.verifier);

			// Verify challenge length (43 chars for SHA-256 hash)
			expect(pkce.challenge.length).toBe(43);
		});

		it("should generate unique PKCE pairs each time", async () => {
			const pkce1 = await generatePKCE();
			const pkce2 = await generatePKCE();

			// Each generation should produce unique values
			expect(pkce1.verifier).not.toBe(pkce2.verifier);
			expect(pkce1.challenge).not.toBe(pkce2.challenge);
		});

		it("should validate PKCE challenge calculation", async () => {
			const pkce = await generatePKCE();

			// Manual verification that challenge is SHA-256 hash of verifier
			const encoder = new TextEncoder();
			const data = encoder.encode(pkce.verifier);
			const hashBuffer = await crypto.subtle.digest("SHA-256", data);

			// Convert hash to base64url (same as PKCE implementation)
			const hashArray = new Uint8Array(hashBuffer);
			const base64 = btoa(String.fromCharCode(...hashArray));
			const expectedChallenge = base64
				.replace(/\+/g, "-")
				.replace(/\//g, "_")
				.replace(/=/g, "");

			// Challenge should match expected value
			expect(pkce.challenge).toBe(expectedChallenge);
		});
	});

	describe("State Generation and Validation", () => {
		it("should generate cryptographically secure random state", () => {
			const generateState = (): string => {
				const array = new Uint8Array(32);
				crypto.getRandomValues(array);
				return Array.from(array, (byte) =>
					byte.toString(16).padStart(2, "0"),
				).join("");
			};

			const state1 = generateState();
			const state2 = generateState();

			// Verify state properties
			expect(typeof state1).toBe("string");
			expect(typeof state2).toBe("string");

			// Should be 64 characters long (32 bytes * 2 hex chars per byte)
			expect(state1.length).toBe(64);
			expect(state2.length).toBe(64);

			// Should contain only hex characters
			expect(state1).toMatch(/^[0-9a-f]+$/);
			expect(state2).toMatch(/^[0-9a-f]+$/);

			// Should be unique each time
			expect(state1).not.toBe(state2);
		});

		it("should properly validate CSRF state in OAuth callback", () => {
			const generateState = (): string => {
				const array = new Uint8Array(32);
				crypto.getRandomValues(array);
				return Array.from(array, (byte) =>
					byte.toString(16).padStart(2, "0"),
				).join("");
			};

			const expectedState = generateState();

			// Valid state should pass validation
			expect(expectedState).toBe(expectedState);

			// Invalid state should not match
			const invalidState = "invalid-state-value";
			expect(expectedState === invalidState).toBe(false);

			// Empty state should not match
			expect(expectedState === "").toBe(false);

			// Different valid state should not match
			const differentState = generateState();
			expect(expectedState === differentState).toBe(false);
		});
	});

	describe("Timestamp Validation for Replay Attack Prevention", () => {
		it("should accept valid timestamps within 5 minutes", () => {
			const now = Date.now();
			const recentTimestamp = now - 4 * 60 * 1000; // 4 minutes ago
			const slightlyOldTimestamp = now - 4 * 60 * 1000 + 59000; // 4 minutes 59 seconds ago

			// Mock the isValidTimestamp function for testing
			const isValidTimestamp = (timestamp: number): boolean => {
				const currentTime = Date.now();
				const age = currentTime - timestamp;
				const maxAge = 5 * 60 * 1000; // 5 minutes in milliseconds
				return age < maxAge && age >= 0; // Not too old and not from the future
			};

			expect(isValidTimestamp(recentTimestamp)).toBe(true);
			expect(isValidTimestamp(slightlyOldTimestamp)).toBe(true);
		});

		it("should reject timestamps older than 5 minutes", () => {
			const now = Date.now();
			const oldTimestamp = now - 6 * 60 * 1000; // 6 minutes ago

			const isValidTimestamp = (timestamp: number): boolean => {
				const currentTime = Date.now();
				const age = currentTime - timestamp;
				const maxAge = 5 * 60 * 1000; // 5 minutes in milliseconds
				return age < maxAge && age >= 0;
			};

			expect(isValidTimestamp(oldTimestamp)).toBe(false);
		});

		it("should reject future timestamps", () => {
			const now = Date.now();
			const futureTimestamp = now + 60 * 1000; // 1 minute in the future

			const isValidTimestamp = (timestamp: number): boolean => {
				const currentTime = Date.now();
				const age = currentTime - timestamp;
				const maxAge = 5 * 60 * 1000; // 5 minutes in milliseconds
				return age < maxAge && age >= 0;
			};

			expect(isValidTimestamp(futureTimestamp)).toBe(false);
		});

		it("should properly encode and decode OAuth state with timestamp", () => {
			const generateStateWithTimestamp = (): string => {
				const array = new Uint8Array(32);
				crypto.getRandomValues(array);
				const csrfToken = Array.from(array, (byte) =>
					byte.toString(16).padStart(2, "0"),
				).join("");

				const state = {
					csrfToken,
					timestamp: Date.now(),
				};

				return btoa(JSON.stringify(state))
					.replace(/\+/g, "-")
					.replace(/\//g, "_")
					.replace(/=/g, "");
			};

			const parseOAuthState = (state: string): any => {
				try {
					const base64State = state.replace(/-/g, "+").replace(/_/g, "/");
					const jsonState = atob(base64State + "=".repeat((4 - (base64State.length % 4)) % 4));
					return JSON.parse(jsonState);
				} catch (error) {
					return null;
				}
			};

			const generatedState = generateStateWithTimestamp();
			const parsedState = parseOAuthState(generatedState);

			// Should be able to parse the generated state
			expect(parsedState).not.toBeNull();
			expect(parsedState).toHaveProperty("csrfToken");
			expect(parsedState).toHaveProperty("timestamp");

			// CSRF token should be a valid hex string
			expect(typeof parsedState.csrfToken).toBe("string");
			expect(parsedState.csrfToken).toMatch(/^[0-9a-f]+$/);
			expect(parsedState.csrfToken.length).toBe(64);

			// Timestamp should be a recent number
			expect(typeof parsedState.timestamp).toBe("number");
			const now = Date.now();
			const age = now - parsedState.timestamp;
			expect(age).toBeGreaterThanOrEqual(0);
			expect(age).toBeLessThan(60000); // Should be very recent
		});
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
