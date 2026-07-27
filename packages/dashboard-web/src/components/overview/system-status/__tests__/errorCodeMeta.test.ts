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
		// Since commit 657ea702, the mid-stream sniffer routes overloaded_error
		// through upstream_529_overloaded_no_reset (no synthetic resetTime) —
		// this reason's only remaining producer is a real Retry-After header
		// from response-processor.ts, so the description must NOT claim a
		// mid-stream path it can no longer produce.
		expect(meta.description).not.toContain("mid-stream");
		expect(meta.suggestion).toContain("automatically");
	});

	test("upstream_529_overloaded_no_reset returns provider overload (no Retry-After) warning", () => {
		const meta = getErrorMeta("upstream_529_overloaded_no_reset");
		expect(meta.title).toBe("Provider overload (no Retry-After)");
		expect(meta.severity).toBe("warning");
		expect(meta.description).toContain("529");
		// This reason now covers the mid-stream overloaded_error path too (see
		// above) — the description must acknowledge it so a dashboard reader
		// doesn't assume this code is only about a headerless HTTP 529.
		expect(meta.description).toContain("mid-stream");
		// This path is the 10s single-flight probe cooldown
		// (CCFLARE_OVERLOAD_COOLDOWN_MS), not the 429 no-reset default
		// (CCFLARE_DEFAULT_COOLDOWN_NO_RESET_MS, 60s) — a prior revision named
		// the wrong env var and duration here.
		expect(meta.suggestion).toContain("CCFLARE_OVERLOAD_COOLDOWN_MS");
		expect(meta.suggestion).not.toContain(
			"CCFLARE_DEFAULT_COOLDOWN_NO_RESET_MS",
		);
	});

	test("out_of_credits surfaces model-scoped credit depletion as an error", () => {
		const meta = getErrorMeta("out_of_credits");
		expect(meta.title).toBe("Account out of credits");
		expect(meta.severity).toBe("error");
		expect(meta.description).toContain("out_of_credits");
		expect(meta.suggestion).toContain("credits");
	});
});
