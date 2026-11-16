import { afterEach, describe, expect, it } from "bun:test";
import {
	getReasoningEffortOverrides,
	getSupportedReasoningEfforts,
	resolveReasoningEffort,
	setReasoningEffortOverrides,
} from "./reasoning";

describe("operator reasoning-effort overrides", () => {
	afterEach(() => {
		setReasoningEffortOverrides(null);
	});

	it("has no overrides by default", () => {
		expect(getReasoningEffortOverrides()).toEqual({});
		expect(getSupportedReasoningEfforts("grok-4.7-build-fast")).toBeNull();
	});

	it("adds levels for a model the built-ins do not know", () => {
		setReasoningEffortOverrides({
			"grok-4.7-build-fast": ["low", "medium", "high", "xhigh"],
		});
		expect(getSupportedReasoningEfforts("grok-4.7-build-fast")).toEqual([
			"low",
			"medium",
			"high",
			"xhigh",
		]);
		expect(
			resolveReasoningEffort("max", { targetModel: "grok-4.7-build-fast" })
				.effort,
		).toBe("xhigh");
	});

	it("takes precedence over the built-in Claude and Codex tables", () => {
		setReasoningEffortOverrides({
			"claude-haiku-5-5": ["low", "medium", "high", "xhigh", "max"],
			"gpt-5.4-mini": ["low"],
		});
		expect(getSupportedReasoningEfforts("claude-haiku-5-5")).toEqual([
			"low",
			"medium",
			"high",
			"xhigh",
			"max",
		]);
		expect(
			resolveReasoningEffort("max", { targetModel: "claude-haiku-5-5" }).effort,
		).toBe("max");
		expect(
			resolveReasoningEffort("high", { targetModel: "gpt-5.4-mini" }).effort,
		).toBe("low");
		// Models without an override keep their built-in table.
		expect(getSupportedReasoningEfforts("claude-haiku-4-5")).toEqual([]);
	});

	it("re-enables levels for a model whose built-in table is empty", () => {
		// Haiku 4.5 rejects the effort parameter, but the operator map can still
		// declare support (e.g. for an upstream that accepts the field).
		setReasoningEffortOverrides({ "claude-haiku-4-5": ["low", "max"] });
		expect(getSupportedReasoningEfforts("claude-haiku-4-5")).toEqual([
			"low",
			"max",
		]);
		expect(
			resolveReasoningEffort("high", { targetModel: "claude-haiku-4-5" })
				.effort,
		).toBe("low");
	});

	it("re-enables max for Opus 4.5", () => {
		setReasoningEffortOverrides({
			"claude-opus-4-5": ["low", "medium", "high", "xhigh", "max"],
		});
		expect(
			resolveReasoningEffort("max", { targetModel: "claude-opus-4-5" }).effort,
		).toBe("max");
	});

	it("matches by normalized model name (case, whitespace, provider prefix)", () => {
		setReasoningEffortOverrides({
			" OpenRouter/DeepSeek-V4.1-Flash ": ["low", "high", "max"],
		});
		expect(getSupportedReasoningEfforts("deepseek-v4.1-flash")).toEqual([
			"low",
			"high",
			"max",
		]);
		expect(
			resolveReasoningEffort("medium", {
				targetModel: "openrouter/deepseek-v4.1-flash",
			}).effort,
		).toBe("low");
		expect(
			resolveReasoningEffort("xhigh", { targetModel: "DEEPSEEK-V4.1-FLASH" })
				.effort,
		).toBe("high");
	});

	it("leaves unknown models unchanged", () => {
		setReasoningEffortOverrides({ "some-model": ["low"] });
		expect(
			resolveReasoningEffort("xhigh", { targetModel: "another-model" }).effort,
		).toBe("xhigh");
	});

	it("drops invalid levels, orders by rank and ignores empty entries", () => {
		setReasoningEffortOverrides({
			a: ["max", "bogus", "low", "low"],
			b: ["nope"],
			c: [],
		} as unknown as Record<string, string[]>);
		expect(getReasoningEffortOverrides()).toEqual({ a: ["low", "max"] });
		expect(getSupportedReasoningEfforts("b")).toBeNull();
	});

	it("replaces the whole map on each call and clears with null", () => {
		setReasoningEffortOverrides({ a: ["low"] });
		setReasoningEffortOverrides({ b: ["high"] });
		expect(getReasoningEffortOverrides()).toEqual({ b: ["high"] });
		setReasoningEffortOverrides(null);
		expect(getReasoningEffortOverrides()).toEqual({});
	});

	it("still rejects an invalid requested effort", () => {
		setReasoningEffortOverrides({ a: ["low"] });
		expect(() =>
			resolveReasoningEffort("extreme", { targetModel: "a" }),
		).toThrow("reasoning.effort must be one of");
	});
});
