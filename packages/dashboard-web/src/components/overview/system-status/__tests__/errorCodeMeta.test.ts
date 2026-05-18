import { describe, expect, test } from "bun:test";
import { getErrorMeta } from "../errorCodeMeta";

describe("getErrorMeta", () => {
	test("unknown code returns fallback meta with the code as title", () => {
		const meta = getErrorMeta("totally_unknown_code");
		expect(meta.title).toBe("totally_unknown_code");
		expect(meta.severity).toBe("error");
	});

	test("model_fallback_429 with no context defaults to a warning that points at Model Mappings", () => {
		const meta = getErrorMeta("model_fallback_429");
		expect(meta.severity).toBe("warning");
		expect(meta.suggestion).toContain("Model Mappings");
	});

	test("model_fallback_429 with anthropic provider replaces the suggestion with the OAuth-friendly copy", () => {
		const meta = getErrorMeta("model_fallback_429", { provider: "anthropic" });
		expect(meta.suggestion).toContain("No action needed");
	});

	test("model_fallback_429 with anthropic provider and no other accounts upgrades severity and prefixes description", () => {
		const meta = getErrorMeta("model_fallback_429", {
			provider: "anthropic",
			otherAccountsAvailable: false,
		});
		expect(meta.severity).toBe("error");
		expect(meta.description.startsWith("No other accounts are available")).toBe(
			true,
		);
	});

	test("model_fallback_429 with multi-model provider keeps default suggestion and warning severity", () => {
		const meta = getErrorMeta("model_fallback_429", {
			provider: "zai",
			otherAccountsAvailable: true,
		});
		expect(meta.severity).toBe("warning");
		expect(meta.suggestion).toContain("Model Mappings");
	});

	test("upstream_429_with_reset entry stays unchanged", () => {
		const meta = getErrorMeta("upstream_429_with_reset");
		expect(meta.title).toBe("Provider rate limit");
		expect(meta.severity).toBe("warning");
	});
});
