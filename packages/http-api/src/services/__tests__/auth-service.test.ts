import { describe, expect, test } from "bun:test";
import { extractApiKey } from "../extract-api-key";

/**
 * Tests for extractApiKey header parsing logic
 *
 * Covers multi-header authentication support:
 * - x-api-key header (Vercel AI SDK / Opencode)
 * - Authorization: Bearer header (standard OAuth format)
 */

function makeRequest(headers: Record<string, string>): Request {
	return new Request("http://localhost/", { headers });
}

describe("API Key Header Extraction", () => {
	describe("x-api-key header", () => {
		test("extracts API key from x-api-key header", () => {
			const req = makeRequest({ "x-api-key": "sk-test-key-123" });
			expect(extractApiKey(req)).toBe("sk-test-key-123");
		});

		test("handles empty x-api-key header (falls back to Authorization)", () => {
			const req = makeRequest({ "x-api-key": "" });
			expect(extractApiKey(req)).toBeNull();
		});
	});

	describe("Authorization Bearer header", () => {
		test("extracts API key from Authorization: Bearer header", () => {
			const req = makeRequest({ authorization: "Bearer sk-test-key-456" });
			expect(extractApiKey(req)).toBe("sk-test-key-456");
		});

		test("handles lowercase bearer", () => {
			const req = makeRequest({ authorization: "bearer sk-test-key-789" });
			expect(extractApiKey(req)).toBe("sk-test-key-789");
		});

		test("handles mixed case bearer", () => {
			const req = makeRequest({ authorization: "BEARER sk-test-key-abc" });
			expect(extractApiKey(req)).toBe("sk-test-key-abc");
		});

		test("handles extra whitespace in Authorization header", () => {
			const req = makeRequest({
				authorization: "  Bearer   sk-test-key-def  ",
			});
			expect(extractApiKey(req)).toBe("sk-test-key-def");
		});

		test("returns null for malformed Authorization header (missing Bearer)", () => {
			const req = makeRequest({ authorization: "sk-test-key-ghi" });
			expect(extractApiKey(req)).toBeNull();
		});

		test("returns null for malformed Authorization header (wrong prefix)", () => {
			const req = makeRequest({ authorization: "Basic sk-test-key-jkl" });
			expect(extractApiKey(req)).toBeNull();
		});

		test("returns null for Authorization header with only Bearer", () => {
			const req = makeRequest({ authorization: "Bearer" });
			expect(extractApiKey(req)).toBeNull();
		});
	});

	describe("priority: x-api-key over Authorization", () => {
		test("prefers x-api-key when both headers are present", () => {
			const req = makeRequest({
				"x-api-key": "sk-from-x-api-key",
				authorization: "Bearer sk-from-auth",
			});
			expect(extractApiKey(req)).toBe("sk-from-x-api-key");
		});

		test("falls back to Authorization when x-api-key is empty", () => {
			const req = makeRequest({
				"x-api-key": "",
				authorization: "Bearer sk-from-auth",
			});
			expect(extractApiKey(req)).toBe("sk-from-auth");
		});
	});

	describe("no authentication headers", () => {
		test("returns null when no auth headers present", () => {
			const req = makeRequest({});
			expect(extractApiKey(req)).toBeNull();
		});

		test("returns null when unrelated headers present", () => {
			const req = makeRequest({
				"content-type": "application/json",
				"user-agent": "test-client",
			});
			expect(extractApiKey(req)).toBeNull();
		});
	});

	describe("Vercel AI SDK / Opencode compatibility", () => {
		test("supports Vercel AI SDK x-api-key format", () => {
			const req = makeRequest({
				"x-api-key": "sk-ant-api03-test-key",
				"anthropic-version": "2023-06-01",
				"content-type": "application/json",
			});
			expect(extractApiKey(req)).toBe("sk-ant-api03-test-key");
		});

		test("supports Anthropic SDK Authorization Bearer format", () => {
			const req = makeRequest({
				authorization: "Bearer sk-ant-api03-test-key",
				"anthropic-version": "2023-06-01",
				"content-type": "application/json",
			});
			expect(extractApiKey(req)).toBe("sk-ant-api03-test-key");
		});
	});
});
