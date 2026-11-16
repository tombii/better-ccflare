/*
 * Copyright (c) 2026 Gili Tzabari. All rights reserved.
 *
 * Licensed under the CAT Commercial License.
 * See LICENSE.md in the project root for license terms.
 */
import { describe, expect, it } from "bun:test";
import {
	getSupportedReasoningEfforts,
	resolveReasoningEffort,
	validateReasoningEffort,
} from "./reasoning";

const ALL_CLAUDE_LEVELS = ["low", "medium", "high", "xhigh", "max"];
const NO_XHIGH_LEVELS = ["low", "medium", "high", "max"];
const LOW_TO_HIGH_LEVELS = ["low", "medium", "high"];
const GPT5_LEVELS = ["minimal", "low", "medium", "high", "xhigh"];
const LOW_MEDIUM_LEVELS = ["low", "medium"];

describe("built-in Claude effort matrix", () => {
	it("grants every level to the 5.x generation of each family", () => {
		for (const model of [
			"claude-opus-5-5",
			"claude-sonnet-5-0",
			"claude-haiku-5-5",
			"claude-haiku-5",
			"claude-fable-5-1",
		]) {
			expect(getSupportedReasoningEfforts(model)).toEqual(ALL_CLAUDE_LEVELS);
		}
	});

	it("grants every level to Opus 4.7 and 4.8", () => {
		expect(getSupportedReasoningEfforts("claude-opus-4-7")).toEqual(
			ALL_CLAUDE_LEVELS,
		);
		expect(getSupportedReasoningEfforts("claude-opus-4-8")).toEqual(
			ALL_CLAUDE_LEVELS,
		);
	});

	it("drops xhigh for the 4.6 generation", () => {
		expect(getSupportedReasoningEfforts("claude-opus-4-6")).toEqual(
			NO_XHIGH_LEVELS,
		);
		expect(getSupportedReasoningEfforts("claude-sonnet-4-6")).toEqual(
			NO_XHIGH_LEVELS,
		);
	});

	it("grants low/medium/high to Opus 4.5", () => {
		expect(getSupportedReasoningEfforts("claude-opus-4-5")).toEqual(
			LOW_TO_HIGH_LEVELS,
		);
		expect(getSupportedReasoningEfforts("claude-opus-4-5-20251101")).toEqual(
			LOW_TO_HIGH_LEVELS,
		);
	});

	it("returns an empty list for models that reject the effort parameter", () => {
		for (const model of [
			"claude-opus-4",
			"claude-opus-4-1-20250805",
			"claude-sonnet-4",
			"claude-sonnet-4-5",
			"claude-sonnet-4-5-20250929",
			"claude-haiku-4-5",
			"claude-haiku-4-5-20251001",
			"claude-3-5-sonnet-20241022",
			"claude-3-7-sonnet-20250219",
			"claude-3-opus-20240229",
			"claude-3-5-haiku-20241022",
		]) {
			expect(getSupportedReasoningEfforts(model)).toEqual([]);
		}
	});

	it("does not read a date snapshot as a minor version", () => {
		// Sonnet 4.0, not Sonnet 4.20250514 — 4.0 has no effort support.
		expect(getSupportedReasoningEfforts("claude-sonnet-4-20250514")).toEqual(
			[],
		);
		// A dated 4.6 snapshot still resolves to 4.6.
		expect(getSupportedReasoningEfforts("claude-sonnet-4-6-20250929")).toEqual(
			NO_XHIGH_LEVELS,
		);
	});

	it("keeps full support for bare family aliases and unparseable ids", () => {
		for (const model of [
			"sonnet",
			"opus",
			"haiku",
			"claude-haiku",
			"my-sonnet-proxy",
		]) {
			expect(getSupportedReasoningEfforts(model)).toEqual(ALL_CLAUDE_LEVELS);
		}
	});

	it("normalizes the provider prefix before parsing the generation", () => {
		expect(getSupportedReasoningEfforts("anthropic/claude-haiku-5-5")).toEqual(
			ALL_CLAUDE_LEVELS,
		);
		expect(getSupportedReasoningEfforts("anthropic/claude-haiku-4-5")).toEqual(
			[],
		);
	});
});

describe("built-in non-Claude effort table", () => {
	it("matches the longest table prefix with a - or . boundary", () => {
		expect(getSupportedReasoningEfforts("gpt-5")).toEqual(GPT5_LEVELS);
		expect(getSupportedReasoningEfforts("gpt-5-2026-01-01")).toEqual(
			GPT5_LEVELS,
		);
		expect(getSupportedReasoningEfforts("gpt-5.3-codex")).toEqual(GPT5_LEVELS);
		expect(getSupportedReasoningEfforts("gpt-5.3-codex-2026-02-01")).toEqual(
			GPT5_LEVELS,
		);
		expect(getSupportedReasoningEfforts("gpt-5.4-mini")).toEqual(
			LOW_MEDIUM_LEVELS,
		);
		// The dated snapshot must not fall back to the permissive gpt-5 list.
		expect(getSupportedReasoningEfforts("gpt-5.4-mini-2026-01-01")).toEqual(
			LOW_MEDIUM_LEVELS,
		);
	});

	it("requires a boundary after a table key", () => {
		expect(getSupportedReasoningEfforts("gpt-50")).toBeNull();
		expect(getSupportedReasoningEfforts("gpt-5x-mini")).toBeNull();
	});

	it("knows the documented Mistral reasoning models", () => {
		expect(getSupportedReasoningEfforts("mistral-large-4")).toEqual(
			LOW_TO_HIGH_LEVELS,
		);
		expect(getSupportedReasoningEfforts("mistral-large-4-0")).toEqual(
			LOW_TO_HIGH_LEVELS,
		);
		expect(getSupportedReasoningEfforts("zai-glm-5-3")).toEqual([
			"low",
			"high",
			"max",
		]);
		expect(getSupportedReasoningEfforts("zai-glm-5-3-flash")).toEqual([
			"low",
			"high",
			"max",
		]);
	});

	it("leaves Mistral models with undocumented level sets to the operator map", () => {
		expect(getSupportedReasoningEfforts("mistral-small-2603")).toBeNull();
		expect(getSupportedReasoningEfforts("mistral-medium-3-5")).toBeNull();
	});
});

describe("reasoning effort resolution", () => {
	it("accepts a valid effort for supported Claude and Codex models", () => {
		expect(
			validateReasoningEffort("xhigh", {
				sourceModel: "claude-sonnet-4-6",
				targetModel: "gpt-5.3-codex",
			}),
		).toBe("xhigh");
	});

	it("keeps the top level for a current-generation model", () => {
		expect(
			resolveReasoningEffort("max", { targetModel: "claude-haiku-5-5" }),
		).toEqual({ effort: "max", downgrades: [] });
	});

	it("downgrades xhigh to high on Opus 4.6", () => {
		expect(
			resolveReasoningEffort("xhigh", { targetModel: "claude-opus-4-6" }),
		).toEqual({
			effort: "high",
			downgrades: [{ model: "claude-opus-4-6", from: "xhigh", to: "high" }],
		});
	});

	it("downgrades unsupported effort to nearest lower supported level", () => {
		const resolved = resolveReasoningEffort("xhigh", {
			sourceModel: "claude-sonnet-4-6",
			targetModel: "gpt-5.4-mini",
		});
		expect(resolved.effort).toBe("medium");
		expect(resolved.downgrades).toEqual([
			{
				model: "gpt-5.4-mini",
				from: "xhigh",
				to: "medium",
			},
		]);
	});

	it("clamps a dated gpt-5.4-mini snapshot instead of passing xhigh through", () => {
		const resolved = resolveReasoningEffort("xhigh", {
			targetModel: "gpt-5.4-mini-2026-01-01",
		});
		expect(resolved.effort).toBe("medium");
		expect(resolved.downgrades).toEqual([
			{
				model: "gpt-5.4-mini-2026-01-01",
				from: "xhigh",
				to: "medium",
			},
		]);
	});

	it("drops the effort for a model that rejects the parameter", () => {
		expect(
			resolveReasoningEffort("high", { targetModel: "claude-haiku-4-5" }),
		).toEqual({ effort: undefined, downgrades: [] });
		expect(
			resolveReasoningEffort("max", { targetModel: "claude-sonnet-4-5" }),
		).toEqual({ effort: undefined, downgrades: [] });
	});

	it("rejects unsupported reasoning effort values", () => {
		expect(() =>
			validateReasoningEffort("extreme", {
				sourceModel: "claude-sonnet-4-6",
				targetModel: "gpt-5.3-codex",
			}),
		).toThrow(
			"reasoning.effort must be one of: minimal, low, medium, high, xhigh, max",
		);
	});

	it("passes through effort unchanged when target model is unknown", () => {
		const resolved = resolveReasoningEffort("xhigh", {
			sourceModel: "claude-sonnet-4-6",
			targetModel: "unknown-model-xyz",
		});
		expect(resolved.effort).toBe("xhigh");
		expect(resolved.downgrades).toEqual([]);
	});

	it("passes through effort unchanged when source model is unknown", () => {
		const resolved = resolveReasoningEffort("xhigh", {
			sourceModel: "claude-future-model-99",
			targetModel: "gpt-5.3-codex",
		});
		expect(resolved.effort).toBe("xhigh");
		expect(resolved.downgrades).toEqual([]);
	});
});
