import { afterEach, describe, expect, it } from "bun:test";
import { convertAnthropicRequestToOpenAI } from "./converters";
import { setReasoningEffortOverrides } from "./reasoning";
import type { AnthropicRequest } from "./types";

function request(effort?: string, model = "grok-4.7-build-fast") {
	return {
		model,
		max_tokens: 100,
		messages: [{ role: "user", content: "hi" }],
		...(effort === undefined ? {} : { reasoning: { effort } }),
	} as unknown as AnthropicRequest;
}

describe("convertAnthropicRequestToOpenAI reasoning effort field", () => {
	afterEach(() => {
		setReasoningEffortOverrides(null);
	});

	it("emits the standard Chat Completions reasoning_effort by default", () => {
		const out = convertAnthropicRequestToOpenAI(
			request("high"),
		) as unknown as Record<string, unknown>;
		expect(out.reasoning_effort).toBe("high");
		expect(out.reasoning).toBeUndefined();
	});

	it("emits reasoning: { effort } for OpenRouter-shaped upstreams", () => {
		const out = convertAnthropicRequestToOpenAI(request("high"), undefined, {
			reasoningEffortField: "reasoning",
		}) as unknown as Record<string, unknown>;
		expect(out.reasoning).toEqual({ effort: "high" });
		expect(out.reasoning_effort).toBeUndefined();
	});

	it("never invents an effort when the client sent none", () => {
		for (const field of ["reasoning", "reasoning_effort"] as const) {
			const out = convertAnthropicRequestToOpenAI(request(), undefined, {
				reasoningEffortField: field,
			}) as unknown as Record<string, unknown>;
			expect(out.reasoning).toBeUndefined();
			expect(out.reasoning_effort).toBeUndefined();
		}
	});

	it("clamps to the operator override for the target model", () => {
		setReasoningEffortOverrides({
			"grok-4.7-build-fast": ["low", "medium", "high", "xhigh"],
		});
		const out = convertAnthropicRequestToOpenAI(
			request("max"),
		) as unknown as Record<string, unknown>;
		expect(out.reasoning_effort).toBe("xhigh");
	});

	it("rejects an invalid effort", () => {
		expect(() => convertAnthropicRequestToOpenAI(request("extreme"))).toThrow(
			"reasoning.effort must be one of",
		);
	});
});
