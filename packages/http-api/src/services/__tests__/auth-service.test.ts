import { describe, expect, test } from "bun:test";

/**
 * Tests for extractApiKey header parsing logic
 *
 * This tests the multi-header authentication support for:
 * - x-api-key header (Vercel AI SDK / Opencode)
 * - Authorization: Bearer header (existing format)
 */
describe("API Key Header Extraction", () => {
	/**
	 * Simulates the extractApiKey logic from AuthService
	 */
	function extractApiKey(headers: Headers): string | null {
		// Check x-api-key header first (Anthropic/Vercel AI SDK format)
		const apiKey = headers.get("x-api-key");
		if (apiKey) {
			return apiKey;
		}

		// Check Authorization header with Bearer token
		const authHeader = headers.get("authorization");
		if (authHeader) {
			const parts = authHeader.trim().split(/\s+/);
			if (parts.length === 2 && parts[0].toLowerCase() === "bearer") {
				return parts[1];
			}
		}

		return null;
	}

	describe("x-api-key header", () => {
		test("extracts API key from x-api-key header", () => {
			const headers = new Headers({ "x-api-key": "sk-test-key-123" });
			const apiKey = extractApiKey(headers);
			expect(apiKey).toBe("sk-test-key-123");
		});

		test("handles empty x-api-key header (falls back to Authorization)", () => {
			const headers = new Headers({ "x-api-key": "" });
			const apiKey = extractApiKey(headers);
			// Empty string is returned as null by Headers.get(), so falls through
			expect(apiKey).toBeNull();
		});
	});

	describe("Authorization Bearer header", () => {
		test("extracts API key from Authorization: Bearer header", () => {
			const headers = new Headers({ authorization: "Bearer sk-test-key-456" });
			const apiKey = extractApiKey(headers);
			expect(apiKey).toBe("sk-test-key-456");
		});

		test("handles lowercase bearer", () => {
			const headers = new Headers({ authorization: "bearer sk-test-key-789" });
			const apiKey = extractApiKey(headers);
			expect(apiKey).toBe("sk-test-key-789");
		});

		test("handles mixed case bearer", () => {
			const headers = new Headers({ authorization: "BEARER sk-test-key-abc" });
			const apiKey = extractApiKey(headers);
			expect(apiKey).toBe("sk-test-key-abc");
		});

		test("handles extra whitespace in Authorization header", () => {
			const headers = new Headers({
				authorization: "  Bearer   sk-test-key-def  ",
			});
			const apiKey = extractApiKey(headers);
			expect(apiKey).toBe("sk-test-key-def");
		});

		test("returns null for malformed Authorization header (missing Bearer)", () => {
			const headers = new Headers({ authorization: "sk-test-key-ghi" });
			const apiKey = extractApiKey(headers);
			expect(apiKey).toBeNull();
		});

		test("returns null for malformed Authorization header (wrong prefix)", () => {
			const headers = new Headers({ authorization: "Basic sk-test-key-jkl" });
			const apiKey = extractApiKey(headers);
			expect(apiKey).toBeNull();
		});

		test("returns null for Authorization header with only Bearer", () => {
			const headers = new Headers({ authorization: "Bearer" });
			const apiKey = extractApiKey(headers);
			expect(apiKey).toBeNull();
		});
	});

	describe("priority: x-api-key over Authorization", () => {
		test("prefers x-api-key when both headers are present", () => {
			const headers = new Headers({
				"x-api-key": "sk-from-x-api-key",
				authorization: "Bearer sk-from-auth",
			});
			const apiKey = extractApiKey(headers);
			expect(apiKey).toBe("sk-from-x-api-key");
		});

		test("falls back to Authorization when x-api-key is empty", () => {
			const headers = new Headers({
				"x-api-key": "",
				authorization: "Bearer sk-from-auth",
			});
			const apiKey = extractApiKey(headers);
			// Empty string is returned as null by Headers.get(), so falls back to Authorization
			expect(apiKey).toBe("sk-from-auth");
		});
	});

	describe("no authentication headers", () => {
		test("returns null when no auth headers present", () => {
			const headers = new Headers();
			const apiKey = extractApiKey(headers);
			expect(apiKey).toBeNull();
		});

		test("returns null when unrelated headers present", () => {
			const headers = new Headers({
				"content-type": "application/json",
				"user-agent": "test-client",
			});
			const apiKey = extractApiKey(headers);
			expect(apiKey).toBeNull();
		});
	});

	describe("Vercel AI SDK / Opencode compatibility", () => {
		test("supports Vercel AI SDK x-api-key format", () => {
			// Vercel AI SDK (@ai-sdk/anthropic) sends x-api-key header
			const headers = new Headers({
				"x-api-key": "sk-ant-api03-test-key",
				"anthropic-version": "2023-06-01",
				"content-type": "application/json",
			});
			const apiKey = extractApiKey(headers);
			expect(apiKey).toBe("sk-ant-api03-test-key");
		});

		test("supports Anthropic SDK Authorization Bearer format", () => {
			// Original Anthropic SDK uses Authorization: Bearer
			const headers = new Headers({
				authorization: "Bearer sk-ant-api03-test-key",
				"anthropic-version": "2023-06-01",
				"content-type": "application/json",
			});
			const apiKey = extractApiKey(headers);
			expect(apiKey).toBe("sk-ant-api03-test-key");
		});
	});
});
