/*
 * Copyright (c) 2026 Gili Tzabari. All rights reserved.
 *
 * Licensed under the CAT Commercial License.
 * See LICENSE.md in the project root for license terms.
 */
import { describe, expect, it } from "bun:test";
import {
	getSupportedReasoningEfforts,
	validateReasoningEffort,
} from "./reasoning";

describe("reasoning effort support", () => {
	it("exposes supported Claude and Codex effort matrices", () => {
		expect(getSupportedReasoningEfforts("claude-sonnet-4-6")).toEqual([
			"low",
			"medium",
			"high",
		]);
		expect(getSupportedReasoningEfforts("claude-haiku-4-5")).toEqual([
			"low",
			"medium",
		]);
		expect(getSupportedReasoningEfforts("gpt-5.3-codex")).toEqual([
			"low",
			"medium",
			"high",
		]);
		expect(getSupportedReasoningEfforts("gpt-5.4-mini")).toEqual([
			"low",
			"medium",
		]);
	});

	it("accepts valid reasoning effort for supported Claude and Codex models", () => {
		expect(
			validateReasoningEffort("high", {
				sourceModel: "claude-sonnet-4-6",
				targetModel: "gpt-5.3-codex",
			}),
		).toBe("high");
	});

	it("rejects unsupported reasoning effort values", () => {
		expect(() =>
			validateReasoningEffort("extreme", {
				sourceModel: "claude-sonnet-4-6",
				targetModel: "gpt-5.3-codex",
			}),
		).toThrow("reasoning.effort must be one of: low, medium, high");
	});

	it("rejects reasoning effort unsupported by the selected target model", () => {
		expect(() =>
			validateReasoningEffort("high", {
				sourceModel: "claude-sonnet-4-6",
				targetModel: "gpt-5.4-mini",
			}),
		).toThrow("reasoning.effort 'high' is not supported for model gpt-5.4-mini");
	});
});
