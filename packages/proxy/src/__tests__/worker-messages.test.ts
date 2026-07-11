import { describe, expect, test } from "bun:test";
import { isModelRewrite } from "../worker-messages";

// isModelRewrite is the single predicate behind every consumer of the
// originalModel/appliedModel pair (StartMessage construction in
// response-handler.ts, request-row persistence in usage-collector.ts, and
// the x-better-ccflare-model-rewrite response header). These tests pin the
// Greptile finding from PR #300: an agent-detected but NOT rewritten
// request (equal values) must never be treated as a rewrite.
describe("isModelRewrite", () => {
	test("true when both models are present and different", () => {
		expect(isModelRewrite("claude-sonnet-5", "claude-opus-4-8")).toBe(true);
	});

	test("false when both models are equal (agent detected, no rewrite)", () => {
		expect(isModelRewrite("claude-sonnet-5", "claude-sonnet-5")).toBe(false);
	});

	test("false when the original model is missing", () => {
		expect(isModelRewrite(null, "claude-opus-4-8")).toBe(false);
		expect(isModelRewrite(undefined, "claude-opus-4-8")).toBe(false);
	});

	test("false when the applied model is missing", () => {
		expect(isModelRewrite("claude-sonnet-5", null)).toBe(false);
		expect(isModelRewrite("claude-sonnet-5", undefined)).toBe(false);
	});

	test("false when both are missing or empty", () => {
		expect(isModelRewrite(null, null)).toBe(false);
		expect(isModelRewrite("", "")).toBe(false);
	});
});
