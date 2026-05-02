import { describe, expect, it } from "bun:test";
import {
	convertAnthropicRequestToOpenAI,
	convertOpenAIResponseToAnthropic,
	safeParseJSON,
} from "../converters";
import type {
	AnthropicRequest,
	AnthropicResponse,
	OpenAIResponse,
	OpenAIToolChoice,
} from "../types";

// ── Fixtures ─────────────────────────────────────────────────────────────────

function anthropicRequest(
	overrides: Partial<AnthropicRequest> = {},
): AnthropicRequest {
	return {
		model: "claude-sonnet-4-5",
		messages: [{ role: "user", content: "Hello" }],
		max_tokens: 100,
		...overrides,
	};
}

function openaiTextResponse(
	overrides: Partial<OpenAIResponse> = {},
): OpenAIResponse {
	return {
		id: "chatcmpl-abc123",
		object: "chat.completion",
		model: "gpt-4",
		choices: [
			{
				index: 0,
				message: { role: "assistant", content: "Hello back!" },
				finish_reason: "stop",
			},
		],
		usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
		...overrides,
	};
}

// ── safeParseJSON ─────────────────────────────────────────────────────────────

describe("safeParseJSON", () => {
	it("parses valid JSON", () => {
		expect(safeParseJSON('{"key":"value"}')).toEqual({ key: "value" });
	});

	it("returns empty object on invalid JSON", () => {
		expect(safeParseJSON("{invalid")).toEqual({});
	});

	it("parses arrays", () => {
		expect(safeParseJSON("[1,2,3]")).toEqual([1, 2, 3]);
	});

	it("parses primitives", () => {
		expect(safeParseJSON('"hello"')).toBe("hello");
		expect(safeParseJSON("42")).toBe(42);
		expect(safeParseJSON("true")).toBe(true);
	});

	it("returns empty object on empty string", () => {
		expect(safeParseJSON("")).toEqual({});
	});
});

// ── convertAnthropicRequestToOpenAI ──────────────────────────────────────────

describe("convertAnthropicRequestToOpenAI — basic fields", () => {
	it("copies model through unchanged when no account", () => {
		const req = anthropicRequest({ model: "claude-opus-4-5" });
		const result = convertAnthropicRequestToOpenAI(req);
		expect(result.model).toBe("claude-opus-4-5");
	});

	it("passes max_tokens through", () => {
		const result = convertAnthropicRequestToOpenAI(
			anthropicRequest({ max_tokens: 512 }),
		);
		expect(result.max_tokens).toBe(512);
		expect(result.max_completion_tokens).toBeUndefined();
	});

	it("passes temperature through", () => {
		const result = convertAnthropicRequestToOpenAI(
			anthropicRequest({ temperature: 0.7 }),
		);
		expect(result.temperature).toBe(0.7);
	});

	it("passes top_p through", () => {
		const result = convertAnthropicRequestToOpenAI(
			anthropicRequest({ top_p: 0.9 }),
		);
		expect(result.top_p).toBe(0.9);
	});

	it("maps stop_sequences → stop", () => {
		const result = convertAnthropicRequestToOpenAI(
			anthropicRequest({ stop_sequences: ["STOP", "END"] }),
		);
		expect(result.stop).toEqual(["STOP", "END"]);
	});

	it("enables stream_options.include_usage when stream: true", () => {
		const result = convertAnthropicRequestToOpenAI(
			anthropicRequest({ stream: true }),
		);
		expect(result.stream).toBe(true);
		expect(result.stream_options).toEqual({ include_usage: true });
	});

	it("does not add stream_options when stream: false", () => {
		const result = convertAnthropicRequestToOpenAI(
			anthropicRequest({ stream: false }),
		);
		expect(result.stream).toBe(false);
		expect(result.stream_options).toBeUndefined();
	});
});

describe("convertAnthropicRequestToOpenAI — system message", () => {
	it("converts string system to system message", () => {
		const result = convertAnthropicRequestToOpenAI(
			anthropicRequest({ system: "You are a helper." }),
		);
		expect(result.messages[0]).toEqual({
			role: "system",
			content: "You are a helper.",
		});
	});

	it("converts array system, joining text blocks", () => {
		const result = convertAnthropicRequestToOpenAI(
			anthropicRequest({
				system: [
					{ type: "text", text: "First." },
					{ type: "text", text: "Second." },
				],
			}),
		);
		const sys = result.messages[0];
		expect(sys?.role).toBe("system");
		// Array form: preserves blocks structure
		expect(Array.isArray(sys?.content)).toBe(true);
	});

	it("preserves cache_control on array system blocks", () => {
		const result = convertAnthropicRequestToOpenAI(
			anthropicRequest({
				system: [
					{
						type: "text",
						text: "Cached system prompt.",
						cache_control: { type: "ephemeral" },
					},
				],
			}),
		);
		const sys = result.messages[0];
		const blocks = sys?.content as Array<{ cache_control?: { type: string } }>;
		expect(blocks[0]?.cache_control).toEqual({ type: "ephemeral" });
	});

	it("filters out non-text system blocks", () => {
		const result = convertAnthropicRequestToOpenAI(
			anthropicRequest({
				system: [
					{
						type: "image",
						source: { type: "base64", media_type: "image/png", data: "abc" },
					} as any,
					{ type: "text", text: "Only text." },
				],
			}),
		);
		const sys = result.messages[0];
		const blocks = sys?.content as Array<{ text: string }>;
		expect(blocks).toHaveLength(1);
		expect(blocks[0]?.text).toBe("Only text.");
	});
});

describe("convertAnthropicRequestToOpenAI — messages conversion", () => {
	it("converts simple string content messages", () => {
		const result = convertAnthropicRequestToOpenAI(
			anthropicRequest({
				messages: [
					{ role: "user", content: "Hi" },
					{ role: "assistant", content: "Hello" },
				],
			}),
		);
		expect(result.messages).toContainEqual({ role: "user", content: "Hi" });
		expect(result.messages).toContainEqual({
			role: "assistant",
			content: "Hello",
		});
	});

	it("converts content array with text blocks to joined string", () => {
		const result = convertAnthropicRequestToOpenAI(
			anthropicRequest({
				messages: [
					{
						role: "user",
						content: [
							{ type: "text", text: "Hello " },
							{ type: "text", text: "world" },
						],
					},
				],
			}),
		);
		const userMsg = result.messages.find((m) => m.role === "user");
		expect(userMsg?.content).toBe("Hello world");
	});

	it("preserves cache_control in content array as structured blocks", () => {
		const result = convertAnthropicRequestToOpenAI(
			anthropicRequest({
				messages: [
					{
						role: "user",
						content: [
							{
								type: "text",
								text: "Cached prompt",
								cache_control: { type: "ephemeral" },
							},
						],
					},
				],
			}),
		);
		const userMsg = result.messages.find((m) => m.role === "user");
		expect(Array.isArray(userMsg?.content)).toBe(true);
		const blocks = userMsg?.content as Array<{
			cache_control?: { type: string };
		}>;
		expect(blocks[0]?.cache_control).toEqual({ type: "ephemeral" });
	});

	it("converts tool_use blocks to OpenAI tool_calls", () => {
		const result = convertAnthropicRequestToOpenAI(
			anthropicRequest({
				messages: [
					{
						role: "assistant",
						content: [
							{
								type: "tool_use",
								id: "tool_1",
								name: "get_weather",
								input: { city: "Paris" },
							},
						],
					},
				],
			}),
		);
		const assistantMsg = result.messages.find((m) => m.role === "assistant");
		expect(assistantMsg?.tool_calls).toHaveLength(1);
		expect(assistantMsg?.tool_calls?.[0]).toMatchObject({
			id: "tool_1",
			type: "function",
			function: {
				name: "get_weather",
				arguments: JSON.stringify({ city: "Paris" }),
			},
		});
	});

	it("converts tool_result blocks to OpenAI tool role messages", () => {
		const result = convertAnthropicRequestToOpenAI(
			anthropicRequest({
				messages: [
					{
						role: "user",
						content: [
							{
								type: "tool_result",
								tool_use_id: "tool_1",
								content: "Sunny, 22°C",
							},
						],
					},
				],
			}),
		);
		const toolMsg = result.messages.find((m) => m.role === "tool");
		expect(toolMsg).toBeDefined();
		expect(toolMsg?.tool_call_id).toBe("tool_1");
		expect(toolMsg?.content).toBe("Sunny, 22°C");
	});

	it("sets reasoning_content from a single thinking block", () => {
		const result = convertAnthropicRequestToOpenAI(
			anthropicRequest({
				messages: [
					{
						role: "assistant",
						content: [
							{ type: "thinking", thinking: "Let me reason about this." },
							{ type: "text", text: "The answer is 42." },
						],
					},
				],
			}),
		);
		const assistantMsg = result.messages.find((m) => m.role === "assistant");
		expect(assistantMsg?.reasoning_content).toBe("Let me reason about this.");
		expect(assistantMsg?.content).toBe("The answer is 42.");
	});

	it("concatenates multiple thinking blocks into reasoning_content", () => {
		const result = convertAnthropicRequestToOpenAI(
			anthropicRequest({
				messages: [
					{
						role: "assistant",
						content: [
							{ type: "thinking", thinking: "Step one." },
							{ type: "thinking", thinking: " Step two." },
							{ type: "text", text: "Done." },
						],
					},
				],
			}),
		);
		const assistantMsg = result.messages.find((m) => m.role === "assistant");
		expect(assistantMsg?.reasoning_content).toBe("Step one. Step two.");
	});

	it("omits reasoning_content when no thinking blocks present", () => {
		const result = convertAnthropicRequestToOpenAI(
			anthropicRequest({
				messages: [
					{
						role: "assistant",
						content: [{ type: "text", text: "Plain answer." }],
					},
				],
			}),
		);
		const assistantMsg = result.messages.find((m) => m.role === "assistant");
		expect(assistantMsg?.reasoning_content).toBeUndefined();
	});

	it("preserves thinking-only assistant message with empty content", () => {
		const result = convertAnthropicRequestToOpenAI(
			anthropicRequest({
				messages: [
					{
						role: "assistant",
						content: [
							{ type: "thinking", thinking: "Only thinking, no text." },
						],
					},
				],
			}),
		);
		const assistantMsgs = result.messages.filter((m) => m.role === "assistant");
		expect(assistantMsgs).toHaveLength(1);
		expect(assistantMsgs[0]?.content).toBe("");
		expect(assistantMsgs[0]?.reasoning_content).toBe("Only thinking, no text.");
	});

	it("sets reasoning_content alongside tool_calls when both are present", () => {
		const result = convertAnthropicRequestToOpenAI(
			anthropicRequest({
				messages: [
					{
						role: "assistant",
						content: [
							{ type: "thinking", thinking: "I should call the tool." },
							{
								type: "tool_use",
								id: "tool_2",
								name: "calculator",
								input: { expr: "2+2" },
							},
						],
					},
				],
			}),
		);
		const assistantMsg = result.messages.find((m) => m.role === "assistant");
		expect(assistantMsg?.reasoning_content).toBe("I should call the tool.");
		expect(assistantMsg?.tool_calls).toHaveLength(1);
		expect(assistantMsg?.tool_calls?.[0]?.function.name).toBe("calculator");
	});
});

describe("convertAnthropicRequestToOpenAI — tools", () => {
	it("converts tools array to OpenAI function format", () => {
		const result = convertAnthropicRequestToOpenAI(
			anthropicRequest({
				tools: [
					{
						name: "get_weather",
						description: "Get weather for a city",
						input_schema: {
							type: "object",
							properties: { city: { type: "string" } },
							required: ["city"],
						},
					},
				],
			}),
		);
		expect(result.tools).toHaveLength(1);
		expect(result.tools?.[0]).toMatchObject({
			type: "function",
			function: {
				name: "get_weather",
				description: "Get weather for a city",
			},
		});
	});

	it("strips $schema from tool input_schema", () => {
		const result = convertAnthropicRequestToOpenAI(
			anthropicRequest({
				tools: [
					{
						name: "my_tool",
						description: "A tool",
						input_schema: {
							$schema: "http://json-schema.org/draft-07/schema#",
							type: "object",
							properties: {},
						},
					},
				],
			}),
		);
		const params = result.tools?.[0]?.function?.parameters as Record<
			string,
			unknown
		>;
		expect(params).not.toHaveProperty("$schema");
	});

	it("strips format:uri from string properties", () => {
		const result = convertAnthropicRequestToOpenAI(
			anthropicRequest({
				tools: [
					{
						name: "open_url",
						description: "Open a URL",
						input_schema: {
							type: "object",
							properties: {
								url: { type: "string", format: "uri" },
							},
						},
					},
				],
			}),
		);
		const params = result.tools?.[0]?.function?.parameters as Record<
			string,
			unknown
		>;
		const props = params?.properties as Record<string, Record<string, unknown>>;
		expect(props?.url).not.toHaveProperty("format");
	});

	it("omits tools when array is empty (DashScope compatibility)", () => {
		const result = convertAnthropicRequestToOpenAI(
			anthropicRequest({ tools: [] }),
		);
		expect(result.tools).toBeUndefined();
	});
});

// ── convertAnthropicRequestToOpenAI — tool_choice ────────────────────────────

describe("convertAnthropicRequestToOpenAI — tool_choice", () => {
	const withTool = { tools: [{ name: "foo", description: "a tool" }] };

	it('maps {type:"auto"} → "auto"', () => {
		const result = convertAnthropicRequestToOpenAI(
			anthropicRequest({ ...withTool, tool_choice: { type: "auto" } }),
		);
		expect(result.tool_choice).toBe("auto");
	});

	it('maps {type:"any"} → "required"', () => {
		const result = convertAnthropicRequestToOpenAI(
			anthropicRequest({ ...withTool, tool_choice: { type: "any" } }),
		);
		expect(result.tool_choice).toBe("required");
	});

	it('maps {type:"none"} → "none"', () => {
		const result = convertAnthropicRequestToOpenAI(
			anthropicRequest({ ...withTool, tool_choice: { type: "none" } }),
		);
		expect(result.tool_choice).toBe("none");
	});

	it('maps {type:"tool",name:"foo"} → {type:"function",function:{name:"foo"}}', () => {
		const result = convertAnthropicRequestToOpenAI(
			anthropicRequest({
				...withTool,
				tool_choice: { type: "tool", name: "foo" },
			}),
		);
		expect(result.tool_choice).toEqual({
			type: "function",
			function: { name: "foo" },
		} satisfies OpenAIToolChoice);
	});

	it("omits tool_choice when not set", () => {
		const result = convertAnthropicRequestToOpenAI(anthropicRequest());
		expect(result.tool_choice).toBeUndefined();
	});

	it("omits tool_choice when tools array absent", () => {
		const result = convertAnthropicRequestToOpenAI(
			anthropicRequest({ tool_choice: { type: "any" } }),
		);
		expect(result.tool_choice).toBeUndefined();
	});
});

// ── convertAnthropicRequestToOpenAI — multi-content tool results ──────────────

describe("convertAnthropicRequestToOpenAI — multi-content tool results", () => {
	it("passes through string tool result content unchanged", () => {
		const result = convertAnthropicRequestToOpenAI(
			anthropicRequest({
				messages: [
					{
						role: "user",
						content: [
							{
								type: "tool_result",
								tool_use_id: "tool_1",
								content: "plain string result",
							},
						],
					},
				],
			}),
		);
		const toolMsg = result.messages.find((m) => m.role === "tool");
		expect(toolMsg?.content).toBe("plain string result");
	});

	it("joins multiple text blocks in array tool result", () => {
		const result = convertAnthropicRequestToOpenAI(
			anthropicRequest({
				messages: [
					{
						role: "user",
						content: [
							{
								type: "tool_result",
								tool_use_id: "tool_1",
								content: [
									{ type: "text", text: "First line." },
									{ type: "text", text: "Second line." },
								],
							},
						],
					},
				],
			}),
		);
		const toolMsg = result.messages.find((m) => m.role === "tool");
		expect(toolMsg?.content).toBe("First line.\nSecond line.");
	});

	it("replaces image blocks with placeholder text", () => {
		const result = convertAnthropicRequestToOpenAI(
			anthropicRequest({
				messages: [
					{
						role: "user",
						content: [
							{
								type: "tool_result",
								tool_use_id: "tool_1",
								content: [
									{ type: "text", text: "Here is the image:" },
									{
										type: "image",
										source: {
											type: "base64",
											media_type: "image/png",
											data: "abc123",
										},
									},
								],
							},
						],
					},
				],
			}),
		);
		const toolMsg = result.messages.find((m) => m.role === "tool");
		expect(toolMsg?.content).toContain("Here is the image:");
		expect(toolMsg?.content).toContain(
			"[image content not supported in OpenAI tool results]",
		);
	});

	it("handles array with only an image block", () => {
		const result = convertAnthropicRequestToOpenAI(
			anthropicRequest({
				messages: [
					{
						role: "user",
						content: [
							{
								type: "tool_result",
								tool_use_id: "tool_2",
								content: [
									{
										type: "image",
										source: {
											type: "base64",
											media_type: "image/jpeg",
											data: "xyz",
										},
									},
								],
							},
						],
					},
				],
			}),
		);
		const toolMsg = result.messages.find((m) => m.role === "tool");
		expect(toolMsg?.content).toBe(
			"[image content not supported in OpenAI tool results]",
		);
		expect(toolMsg?.tool_call_id).toBe("tool_2");
	});
});

// ── convertOpenAIResponseToAnthropic ─────────────────────────────────────────

describe("convertOpenAIResponseToAnthropic — success cases", () => {
	it("converts a basic text response", () => {
		const result = convertOpenAIResponseToAnthropic(openaiTextResponse());
		expect(result.type).toBe("message");
		expect(result.role).toBe("assistant");
		const content = (
			result as AnthropicResponse & {
				content: Array<{ type: string; text: string }>;
			}
		).content;
		expect(content).toHaveLength(1);
		expect(content[0]).toEqual({ type: "text", text: "Hello back!" });
	});

	it("maps finish_reason stop → end_turn", () => {
		const result = convertOpenAIResponseToAnthropic(openaiTextResponse());
		expect(result.stop_reason).toBe("end_turn");
	});

	it("maps finish_reason length → max_tokens", () => {
		const result = convertOpenAIResponseToAnthropic(
			openaiTextResponse({
				choices: [
					{
						index: 0,
						message: { role: "assistant", content: "..." },
						finish_reason: "length",
					},
				],
			}),
		);
		expect(result.stop_reason).toBe("max_tokens");
	});

	it("maps finish_reason tool_calls → tool_use", () => {
		const result = convertOpenAIResponseToAnthropic(
			openaiTextResponse({
				choices: [
					{
						index: 0,
						message: {
							role: "assistant",
							content: null,
							tool_calls: [
								{
									id: "call_1",
									type: "function",
									function: { name: "search", arguments: '{"q":"bun"}' },
								},
							],
						},
						finish_reason: "tool_calls",
					},
				],
			}),
		);
		expect(result.stop_reason).toBe("tool_use");
		const content = (result as any).content as Array<{
			type: string;
			id: string;
			name: string;
			input: unknown;
		}>;
		const toolBlock = content.find((c) => c.type === "tool_use");
		expect(toolBlock).toBeDefined();
		expect(toolBlock?.name).toBe("search");
		expect(toolBlock?.input).toEqual({ q: "bun" });
	});

	it("maps finish_reason content_filter → end_turn", () => {
		const result = convertOpenAIResponseToAnthropic(
			openaiTextResponse({
				choices: [
					{
						index: 0,
						message: { role: "assistant", content: "Filtered" },
						finish_reason: "content_filter",
					},
				],
			}),
		);
		expect(result.stop_reason).toBe("end_turn");
	});

	it("maps token usage to input_tokens / output_tokens", () => {
		const result = convertOpenAIResponseToAnthropic(
			openaiTextResponse(),
		) as any;
		expect(result.usage.input_tokens).toBe(10);
		expect(result.usage.output_tokens).toBe(5);
	});

	it("passes through the response id", () => {
		const result = convertOpenAIResponseToAnthropic(
			openaiTextResponse({ id: "chatcmpl-xyz" }),
		) as any;
		expect(result.id).toBe("chatcmpl-xyz");
	});

	it("includes both text and tool_calls in content array", () => {
		const result = convertOpenAIResponseToAnthropic(
			openaiTextResponse({
				choices: [
					{
						index: 0,
						message: {
							role: "assistant",
							content: "Let me search for that.",
							tool_calls: [
								{
									id: "call_2",
									type: "function",
									function: { name: "search", arguments: '{"q":"test"}' },
								},
							],
						},
						finish_reason: "tool_calls",
					},
				],
			}),
		) as any;
		const content = result.content as Array<{ type: string }>;
		expect(content.some((c) => c.type === "text")).toBe(true);
		expect(content.some((c) => c.type === "tool_use")).toBe(true);
	});
});

describe("convertOpenAIResponseToAnthropic — error cases", () => {
	it("returns error type when response has error field", () => {
		const result = convertOpenAIResponseToAnthropic({
			error: { type: "invalid_request_error", message: "Bad request" },
		} as any) as any;
		expect(result.type).toBe("error");
		expect(result.error.message).toBe("Bad request");
	});

	it("returns error when choices array is missing", () => {
		const result = convertOpenAIResponseToAnthropic({
			id: "xyz",
			choices: [],
		} as any) as any;
		expect(result.type).toBe("error");
		expect(result.error.type).toBe("invalid_response");
	});

	it("handles malformed tool call arguments gracefully via safeParseJSON", () => {
		const result = convertOpenAIResponseToAnthropic(
			openaiTextResponse({
				choices: [
					{
						index: 0,
						message: {
							role: "assistant",
							content: null,
							tool_calls: [
								{
									id: "call_bad",
									type: "function",
									function: { name: "broken", arguments: "{invalid json" },
								},
							],
						},
						finish_reason: "tool_calls",
					},
				],
			}),
		) as any;
		// Should not throw — safeParseJSON returns {}
		const toolBlock = result.content?.find((c: any) => c.type === "tool_use");
		expect(toolBlock?.input).toEqual({});
	});
});
