import { describe, expect, it } from "bun:test";
import {
	providerRequestIdFromHeaders,
	providerRequestIdHeader,
} from "./provider-request-id";

function headers(init: Record<string, string>): Headers {
	return new Headers(init);
}

/**
 * Response headers recorded verbatim from a live NanoGPT call (2026-10-29,
 * POST https://nano-gpt.com/api/v1/messages, deepseek/deepseek-v4.1-flash-1017,
 * non-streaming, HTTP 200), trimmed to the headers that matter here. No
 * `request-id` header (the Codex-upstream spelling) was present.
 */
const CAPTURED_NANOGPT_HEADERS: Record<string, string> = {
	"content-type": "application/json",
	"x-request-id": "req_bdd860d4-ed1a-4d4b-8aea-ceb30aa24faf",
};

describe("providerRequestIdFromHeaders", () => {
	it("returns the id from a recorded live nanogpt response", () => {
		expect(
			providerRequestIdFromHeaders(
				"nanogpt",
				headers(CAPTURED_NANOGPT_HEADERS),
			),
		).toBe("req_bdd860d4-ed1a-4d4b-8aea-ceb30aa24faf");
	});

	it("does not fall back to the bare request-id spelling Codex upstream sends", () => {
		expect(
			providerRequestIdFromHeaders(
				"nanogpt",
				headers({ "request-id": "req_from_somewhere_else" }),
			),
		).toBeNull();
	});

	it("rejects an over-long value instead of surfacing it as an id", () => {
		expect(
			providerRequestIdFromHeaders(
				"nanogpt",
				headers({ "x-request-id": "a".repeat(513) }),
			),
		).toBeNull();
	});
	it("returns x-request-id for nanogpt", () => {
		expect(
			providerRequestIdFromHeaders(
				"nanogpt",
				headers({ "x-request-id": "req_abc123" }),
			),
		).toBe("req_abc123");
	});

	it("trims surrounding whitespace", () => {
		expect(
			providerRequestIdFromHeaders(
				"nanogpt",
				headers({ "x-request-id": "  req_abc123 " }),
			),
		).toBe("req_abc123");
	});

	it("returns null when nanogpt header is missing", () => {
		expect(providerRequestIdFromHeaders("nanogpt", headers({}))).toBeNull();
	});

	it("returns null when nanogpt header is empty", () => {
		expect(
			providerRequestIdFromHeaders("nanogpt", headers({ "x-request-id": "" })),
		).toBeNull();
	});

	it("returns null for providers with no known id header", () => {
		const h = headers({ "x-request-id": "req_abc123" });
		for (const name of [
			"anthropic",
			"claude-oauth",
			"console",
			"zai",
			"minimax",
			"openai-compatible",
			"codex",
			"qwen",
			"openrouter",
			"codebuddy",
		]) {
			expect(providerRequestIdFromHeaders(name, h)).toBeNull();
		}
	});
});

describe("providerRequestIdHeader", () => {
	it("names the nanogpt header", () => {
		expect(providerRequestIdHeader("nanogpt")).toBe("x-request-id");
	});

	it("has no header for openrouter (message id is not a request id)", () => {
		expect(providerRequestIdHeader("openrouter")).toBeNull();
	});
});
