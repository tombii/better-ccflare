import { describe, expect, it } from "bun:test";
import {
	servedProviderBodyField,
	servedProviderFromBody,
} from "./provider-serving";

/**
 * Response body recorded verbatim from a live OpenRouter call (2026-10-29,
 * POST https://openrouter.ai/api/v1/messages with
 * `provider: {"only":["morph"]}`), trimmed to the fields that matter here.
 */
const CAPTURED_OPENROUTER_BODY = {
	id: "msg_0123456789",
	type: "message",
	role: "assistant",
	model: "deepseek/deepseek-v4.1-flash-1017",
	provider: "Morph",
	content: [{ type: "text", text: "ok" }],
	usage: { input_tokens: 10, output_tokens: 2, cost: 0.0000078 },
};

describe("servedProviderFromBody", () => {
	it("returns the provider field from a recorded live openrouter response", () => {
		expect(servedProviderFromBody("openrouter", CAPTURED_OPENROUTER_BODY)).toBe(
			"Morph",
		);
	});

	it("trims surrounding whitespace", () => {
		expect(servedProviderFromBody("openrouter", { provider: "  Morph " })).toBe(
			"Morph",
		);
	});

	it("returns null for nanogpt even with a provider field", () => {
		expect(servedProviderFromBody("nanogpt", { provider: "Morph" })).toBeNull();
	});

	it("returns null for other providers", () => {
		for (const name of [
			"anthropic",
			"zai",
			"minimax",
			"openai-compatible",
			"codex",
			"qwen",
		]) {
			expect(servedProviderFromBody(name, { provider: "Morph" })).toBeNull();
		}
	});

	it("returns null when the field is missing", () => {
		expect(
			servedProviderFromBody("openrouter", { model: "x", usage: {} }),
		).toBeNull();
	});

	it("returns null for a wrong-typed value", () => {
		for (const provider of [42, { name: "Morph" }, ["Morph"], null, true]) {
			expect(servedProviderFromBody("openrouter", { provider })).toBeNull();
		}
	});

	it("returns null for whitespace-only values", () => {
		expect(
			servedProviderFromBody("openrouter", { provider: "   " }),
		).toBeNull();
	});

	it("rejects over-long values", () => {
		expect(
			servedProviderFromBody("openrouter", { provider: "a".repeat(513) }),
		).toBeNull();
	});

	it("returns null for non-object bodies", () => {
		for (const body of [null, undefined, "Morph", 7, []]) {
			expect(servedProviderFromBody("openrouter", body)).toBeNull();
		}
	});
});

describe("servedProviderBodyField", () => {
	it("names openrouter's field and no nanogpt field", () => {
		expect(servedProviderBodyField("openrouter")).toBe("provider");
		expect(servedProviderBodyField("nanogpt")).toBeNull();
	});
});
