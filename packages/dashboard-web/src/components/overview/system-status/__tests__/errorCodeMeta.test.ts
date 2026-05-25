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

	test("upstream_529_overloaded_with_reset returns provider overload warning", () => {
		const meta = getErrorMeta("upstream_529_overloaded_with_reset");
		expect(meta.title).toBe("Provider overload");
		expect(meta.severity).toBe("warning");
		expect(meta.description).toContain("529");
		// Reason is also used for mid-stream overloaded_error detections where
		// no Retry-After header is parsed; the description must acknowledge that
		// path so a dashboard reader doesn't assume the cooldown always came
		// from an HTTP header.
		expect(meta.description).toContain("mid-stream");
		expect(meta.suggestion).toContain("automatically");
	});

	test("upstream_529_overloaded_no_reset returns provider overload (no Retry-After) warning", () => {
		const meta = getErrorMeta("upstream_529_overloaded_no_reset");
		expect(meta.title).toBe("Provider overload (no Retry-After)");
		expect(meta.severity).toBe("warning");
		expect(meta.description).toContain("529");
		expect(meta.suggestion).toContain("CCFLARE_DEFAULT_COOLDOWN_NO_RESET_MS");
	});
});
