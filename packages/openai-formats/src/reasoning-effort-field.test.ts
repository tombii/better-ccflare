import { afterEach, describe, expect, it } from "bun:test";
import { convertAnthropicRequestToOpenAI } from "./converters";
import {
	readClientReasoningEffort,
	setReasoningEffortOverrides,
} from "./reasoning";
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

function nativeRequest(
	outputConfig: Record<string, unknown>,
	extra: Record<string, unknown> = {},
	model = "grok-4.7-build-fast",
) {
	return {
		model,
		max_tokens: 100,
		messages: [{ role: "user", content: "hi" }],
		output_config: outputConfig,
		...extra,
	} as unknown as AnthropicRequest;
}

describe("convertAnthropicRequestToOpenAI with a client-native output_config.effort", () => {
	afterEach(() => {
		setReasoningEffortOverrides(null);
	});

	it("carries Claude's native output_config.effort into reasoning_effort", () => {
		const out = convertAnthropicRequestToOpenAI(
			nativeRequest({ effort: "high" }),
		) as unknown as Record<string, unknown>;
		expect(out.reasoning_effort).toBe("high");
		expect(out.output_config).toBeUndefined();
	});

	it("carries it into reasoning: { effort } for OpenRouter-shaped upstreams", () => {
		const out = convertAnthropicRequestToOpenAI(
			nativeRequest({ effort: "high" }),
			undefined,
			{ reasoningEffortField: "reasoning" },
		) as unknown as Record<string, unknown>;
		expect(out.reasoning).toEqual({ effort: "high" });
		expect(out.reasoning_effort).toBeUndefined();
	});

	it("prefers the internal reasoning.effort when the client sent both", () => {
		const out = convertAnthropicRequestToOpenAI(
			nativeRequest({ effort: "low" }, { reasoning: { effort: "high" } }),
		) as unknown as Record<string, unknown>;
		expect(out.reasoning_effort).toBe("high");
	});

	it("ignores an output_config that carries no effort", () => {
		const out = convertAnthropicRequestToOpenAI(
			nativeRequest({ format: { type: "text" } }),
		) as unknown as Record<string, unknown>;
		expect(out.reasoning_effort).toBeUndefined();
		expect(out.reasoning).toBeUndefined();
	});

	it("clamps a native effort to the operator override for the target model", () => {
		setReasoningEffortOverrides({
			"grok-4.7-build-fast": ["low", "medium", "high", "xhigh"],
		});
		const out = convertAnthropicRequestToOpenAI(
			nativeRequest({ effort: "max" }),
		) as unknown as Record<string, unknown>;
		expect(out.reasoning_effort).toBe("xhigh");
	});

	it("rejects an invalid native effort", () => {
		expect(() =>
			convertAnthropicRequestToOpenAI(nativeRequest({ effort: "extreme" })),
		).toThrow("must be one of");
	});
});

describe("readClientReasoningEffort", () => {
	it("returns the internal reasoning.effort first", () => {
		expect(
			readClientReasoningEffort({
				reasoning: { effort: "high" },
				output_config: { effort: "low" },
			}),
		).toBe("high");
	});

	it("falls back to Claude's native output_config.effort", () => {
		expect(
			readClientReasoningEffort({ output_config: { effort: "low" } }),
		).toBe("low");
	});

	it("returns undefined when neither carries an effort", () => {
		expect(readClientReasoningEffort({})).toBeUndefined();
		expect(
			readClientReasoningEffort({
				reasoning: "high",
				output_config: [{ effort: "low" }],
			}),
		).toBeUndefined();
		expect(readClientReasoningEffort(null)).toBeUndefined();
	});
});
