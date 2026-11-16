import { describe, expect, it } from "bun:test";
import { getReasoningEffortError } from "../utils/reasoning-effort";

describe("getReasoningEffortError", () => {
	it("returns null when no effort was sent", () => {
		expect(getReasoningEffortError(undefined)).toBeNull();
		expect(getReasoningEffortError(null)).toBeNull();
	});

	it("returns null for every known level", () => {
		for (const level of ["minimal", "low", "medium", "high", "xhigh", "max"]) {
			expect(getReasoningEffortError(level)).toBeNull();
		}
	});

	it("returns the validation message for an unknown level", () => {
		expect(getReasoningEffortError("extreme")).toBe(
			"reasoning.effort must be one of: minimal, low, medium, high, xhigh, max",
		);
	});

	it("returns the validation message for a non-string value", () => {
		expect(getReasoningEffortError(3)).toBe(
			"reasoning.effort must be one of: minimal, low, medium, high, xhigh, max",
		);
	});
});
