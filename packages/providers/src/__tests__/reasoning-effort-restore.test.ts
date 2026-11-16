import { afterEach, describe, expect, it } from "bun:test";
import { setReasoningEffortOverrides } from "@better-ccflare/openai-formats";
import { restoreReasoningEffort } from "../utils/reasoning-effort";

afterEach(() => {
	setReasoningEffortOverrides(null);
});

describe("restoreReasoningEffort", () => {
	it("restores output_config.effort, resolving against the model", () => {
		const body: Record<string, unknown> = { model: "gpt-5.4-mini" };
		expect(
			restoreReasoningEffort(body, "output_config", "max", "gpt-5.4-mini"),
		).toBe(true);
		expect(body.output_config).toEqual({ effort: "medium" });
	});

	it("restores reasoning_effort as a top-level key", () => {
		const body: Record<string, unknown> = {};
		expect(
			restoreReasoningEffort(body, "reasoning_effort", "high", "gpt-5.4-mini"),
		).toBe(true);
		expect(body.reasoning_effort).toBe("medium");
	});

	it("restores reasoning.effort as an object", () => {
		const body: Record<string, unknown> = {};
		expect(
			restoreReasoningEffort(body, "reasoning", "low", "gpt-5.4-mini"),
		).toBe(true);
		expect(body.reasoning).toEqual({ effort: "low" });
	});

	it("merges into an existing output_config, keeping its other keys", () => {
		const body: Record<string, unknown> = {
			output_config: { format: { type: "text" } },
		};
		expect(
			restoreReasoningEffort(body, "output_config", "high", "claude-opus-4-7"),
		).toBe(true);
		expect(body.output_config).toEqual({
			format: { type: "text" },
			effort: "high",
		});
	});

	it("merges into an existing reasoning object, keeping its other keys", () => {
		const body: Record<string, unknown> = {
			reasoning: { exclude: true },
		};
		expect(
			restoreReasoningEffort(body, "reasoning", "low", "claude-opus-4-7"),
		).toBe(true);
		expect(body.reasoning).toEqual({ exclude: true, effort: "low" });
	});

	it("never overwrites a field the body already carries", () => {
		const cases: Array<
			[
				Record<string, unknown>,
				"output_config" | "reasoning" | "reasoning_effort",
			]
		> = [
			[{ output_config: { effort: "low" } }, "output_config"],
			[{ reasoning: { effort: "low" } }, "reasoning"],
			[{ reasoning_effort: "low" }, "reasoning_effort"],
		];
		for (const [body, target] of cases) {
			const before = structuredClone(body);
			expect(
				restoreReasoningEffort(body, target, "max", "claude-opus-4-7"),
			).toBe(false);
			expect(body).toEqual(before);
		}
	});

	it("does nothing when the model rejects the parameter outright", () => {
		const body: Record<string, unknown> = {};
		expect(
			restoreReasoningEffort(body, "output_config", "high", "claude-haiku-4-5"),
		).toBe(false);
		expect(body).toEqual({});
	});

	it("does nothing without a requested effort", () => {
		const body: Record<string, unknown> = {};
		expect(
			restoreReasoningEffort(
				body,
				"output_config",
				undefined,
				"claude-opus-4-7",
			),
		).toBe(false);
		expect(body).toEqual({});
	});

	it("does nothing for an invalid effort value", () => {
		const body: Record<string, unknown> = {};
		expect(
			restoreReasoningEffort(body, "reasoning_effort", "turbo", "gpt-5.4-mini"),
		).toBe(false);
		expect(body).toEqual({});
	});
});
