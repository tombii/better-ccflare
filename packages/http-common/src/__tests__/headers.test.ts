import { describe, expect, it } from "bun:test";
import { sanitizeRequestHeaders, sanitizeResponseHeaders } from "../headers";

describe("sanitizeRequestHeaders", () => {
	it("strips internal better-ccflare headers from persisted request headers", () => {
		const sanitized = sanitizeRequestHeaders(
			new Headers({
				"content-type": "application/json",
				"x-better-ccflare-account-id": "acc-secret",
				"x-better-ccflare-anthropic-oauth-allowlist": "Jenny_claude,acc-secret",
				"x-better-ccflare-request-source": "openai-responses-adapter",
				"x-ordinary-debug": "kept",
			}),
		);

		expect(sanitized.get("x-better-ccflare-account-id")).toBeNull();
		expect(
			sanitized.get("x-better-ccflare-anthropic-oauth-allowlist"),
		).toBeNull();
		expect(sanitized.get("x-better-ccflare-request-source")).toBeNull();
		expect(sanitized.get("content-type")).toBe("application/json");
		expect(sanitized.get("x-ordinary-debug")).toBe("kept");
	});
});

describe("sanitizeResponseHeaders", () => {
	it("strips internal better-ccflare headers from persisted response headers", () => {
		const sanitized = sanitizeResponseHeaders(
			new Headers({
				"content-type": "application/json",
				"x-better-ccflare-pool-status": "exhausted",
				"x-better-ccflare-request-id": "req-secret",
				"x-ordinary-debug": "kept",
			}),
		);

		expect(sanitized.get("x-better-ccflare-pool-status")).toBeNull();
		expect(sanitized.get("x-better-ccflare-request-id")).toBeNull();
		expect(sanitized.get("content-type")).toBe("application/json");
		expect(sanitized.get("x-ordinary-debug")).toBe("kept");
	});
});
