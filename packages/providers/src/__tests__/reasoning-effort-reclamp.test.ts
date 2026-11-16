import { afterEach, describe, expect, it } from "bun:test";
import { setReasoningEffortOverrides } from "@better-ccflare/openai-formats";
import { reclampReasoningEffort } from "../utils/reasoning-effort";

afterEach(() => {
	setReasoningEffortOverrides(null);
});

describe("reclampReasoningEffort", () => {
	it("re-clamps output_config.effort from the client's original effort", () => {
		const body: Record<string, unknown> = {
			model: "gpt-5.4-mini",
			output_config: { effort: "high", format: { type: "text" } },
		};
		expect(reclampReasoningEffort(body, "gpt-5.4-mini", "high")).toBe(true);
		expect(body.output_config).toEqual({
			effort: "medium",
			format: { type: "text" },
		});
	});

	it("re-clamps reasoning_effort (openai-compatible)", () => {
		const body: Record<string, unknown> = { reasoning_effort: "max" };
		expect(reclampReasoningEffort(body, "gpt-5.4-mini", "max")).toBe(true);
		expect(body.reasoning_effort).toBe("medium");
	});

	it("re-clamps reasoning.effort (OpenRouter shape) and keeps other keys", () => {
		const body: Record<string, unknown> = {
			reasoning: { effort: "high", exclude: true },
		};
		expect(reclampReasoningEffort(body, "gpt-5.4-mini", "high")).toBe(true);
		expect(body.reasoning).toEqual({ effort: "medium", exclude: true });
	});

	it("starts from the requested effort, so two downgrades never compound", () => {
		// The first transform clamped "max" to "high" for a model limited to
		// [low, high]; the model actually sent supports "max".
		const body: Record<string, unknown> = { reasoning_effort: "high" };
		expect(reclampReasoningEffort(body, "claude-sonnet-4-6", "max")).toBe(true);
		expect(body.reasoning_effort).toBe("max");
	});

	it("re-clamps the current value when no requested effort is given", () => {
		const body: Record<string, unknown> = { reasoning_effort: "high" };
		expect(reclampReasoningEffort(body, "gpt-5.4-mini")).toBe(true);
		expect(body.reasoning_effort).toBe("medium");
	});

	it("removes the effort for a model that rejects the parameter outright", () => {
		const shapes: Array<{
			body: Record<string, unknown>;
			expected: Record<string, unknown>;
		}> = [
			{ body: { reasoning_effort: "high" }, expected: {} },
			{
				body: { reasoning: { effort: "high", exclude: true } },
				expected: { reasoning: { exclude: true } },
			},
			{
				body: { output_config: { effort: "high", format: { type: "text" } } },
				expected: { output_config: { format: { type: "text" } } },
			},
		];
		for (const { body, expected } of shapes) {
			expect(reclampReasoningEffort(body, "claude-haiku-4-5", "high")).toBe(
				true,
			);
			expect(body).toEqual(expected);
		}
	});

	it("leaves output_config.effort alone without a requested effort (may be client-native)", () => {
		const body: Record<string, unknown> = { output_config: { effort: "max" } };
		expect(reclampReasoningEffort(body, "gpt-5.4-mini")).toBe(false);
		expect(body.output_config).toEqual({ effort: "max" });
	});

	it("honours preserveOutputConfigEffort even with a requested effort", () => {
		const body: Record<string, unknown> = { output_config: { effort: "max" } };
		expect(
			reclampReasoningEffort(body, "gpt-5.4-mini", "low", {
				preserveOutputConfigEffort: true,
			}),
		).toBe(false);
		expect(body.output_config).toEqual({ effort: "max" });
	});

	it("never adds an effort where none is present", () => {
		const body: Record<string, unknown> = { model: "gpt-5.4-mini" };
		expect(reclampReasoningEffort(body, "gpt-5.4-mini", "high")).toBe(false);
		expect(body).toEqual({ model: "gpt-5.4-mini" });
	});

	it("returns false when the effort is already valid for the model", () => {
		const body: Record<string, unknown> = { reasoning_effort: "medium" };
		expect(reclampReasoningEffort(body, "gpt-5.4-mini", "medium")).toBe(false);
		expect(body.reasoning_effort).toBe("medium");
	});

	it("uses the operator override for the model", () => {
		setReasoningEffortOverrides({ "glm-9": ["low"] });
		const body: Record<string, unknown> = { reasoning_effort: "high" };
		expect(reclampReasoningEffort(body, "glm-9", "high")).toBe(true);
		expect(body.reasoning_effort).toBe("low");
	});
});
