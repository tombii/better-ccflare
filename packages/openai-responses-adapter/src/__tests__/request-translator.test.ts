import { describe, expect, test } from "bun:test";
import { translateRequestToAnthropic } from "../request-translator";
import type { ResponsesRequest } from "../types";

describe("translateRequestToAnthropic", () => {
	test("simple user message → single messages entry", () => {
		const req: ResponsesRequest = {
			model: "claude-3-5-sonnet-20241022",
			input: [
				{
					type: "message",
					role: "user",
					content: [{ type: "input_text", text: "Hello" }],
				},
			],
		};
		const result = translateRequestToAnthropic(req);
		expect(result.messages).toHaveLength(1);
		expect(result.messages[0].role).toBe("user");
		expect(result.messages[0].content).toEqual([
			{ type: "text", text: "Hello" },
		]);
	});

	test("user + assistant exchange → two messages", () => {
		const req: ResponsesRequest = {
			model: "claude-3-5-sonnet-20241022",
			input: [
				{
					type: "message",
					role: "user",
					content: [{ type: "input_text", text: "Hi" }],
				},
				{
					type: "message",
					role: "assistant",
					content: [{ type: "output_text", text: "Hello!" }],
				},
			],
		};
		const result = translateRequestToAnthropic(req);
		expect(result.messages).toHaveLength(2);
		expect(result.messages[0].role).toBe("user");
		expect(result.messages[1].role).toBe("assistant");
		expect(result.messages[1].content).toEqual([
			{ type: "text", text: "Hello!" },
		]);
	});

	test("function_call item appended to assistant message", () => {
		const req: ResponsesRequest = {
			model: "claude-3-5-sonnet-20241022",
			input: [
				{
					type: "message",
					role: "assistant",
					content: [{ type: "output_text", text: "Using tool..." }],
				},
				{
					type: "function_call",
					call_id: "call_123",
					name: "my_tool",
					arguments: '{"key":"value"}',
				},
			],
		};
		const result = translateRequestToAnthropic(req);
		expect(result.messages).toHaveLength(1);
		expect(result.messages[0].role).toBe("assistant");
		expect(result.messages[0].content).toHaveLength(2);
		expect(result.messages[0].content[1]).toEqual({
			type: "tool_use",
			id: "call_123",
			name: "my_tool",
			input: { key: "value" },
		});
	});

	test("function_call_output → new user message with tool_result", () => {
		const req: ResponsesRequest = {
			model: "claude-3-5-sonnet-20241022",
			input: [
				{
					type: "function_call_output",
					call_id: "call_abc",
					output: "result data",
				},
			],
		};
		const result = translateRequestToAnthropic(req);
		expect(result.messages).toHaveLength(1);
		expect(result.messages[0].role).toBe("user");
		expect(result.messages[0].content).toEqual([
			{ type: "tool_result", tool_use_id: "call_abc", content: "result data" },
		]);
	});

	test("mixed conversation: user, assistant+function_call, function_call_output, user", () => {
		const req: ResponsesRequest = {
			model: "claude-3-5-sonnet-20241022",
			input: [
				{
					type: "message",
					role: "user",
					content: [{ type: "input_text", text: "Do the thing" }],
				},
				{
					type: "message",
					role: "assistant",
					content: [{ type: "output_text", text: "Calling tool..." }],
				},
				{
					type: "function_call",
					call_id: "call_1",
					name: "do_thing",
					arguments: "{}",
				},
				{
					type: "function_call_output",
					call_id: "call_1",
					output: "done",
				},
				{
					type: "message",
					role: "user",
					content: [{ type: "input_text", text: "Thanks" }],
				},
			],
		};
		const result = translateRequestToAnthropic(req);
		// Expected: [user, assistant(text+tool_use), user(tool_result+text)]
		expect(result.messages).toHaveLength(3);
		expect(result.messages[0].role).toBe("user");
		expect(result.messages[0].content).toHaveLength(1);
		expect(result.messages[1].role).toBe("assistant");
		expect(result.messages[1].content).toHaveLength(2);
		expect(result.messages[1].content[1]).toMatchObject({
			type: "tool_use",
			name: "do_thing",
		});
		expect(result.messages[2].role).toBe("user");
		expect(result.messages[2].content).toHaveLength(2);
		expect(result.messages[2].content[0]).toMatchObject({
			type: "tool_result",
			tool_use_id: "call_1",
		});
		expect(result.messages[2].content[1]).toEqual({
			type: "text",
			text: "Thanks",
		});
	});

	test("consecutive same-role messages get merged", () => {
		const req: ResponsesRequest = {
			model: "claude-3-5-sonnet-20241022",
			input: [
				{
					type: "message",
					role: "user",
					content: [{ type: "input_text", text: "First" }],
				},
				{
					type: "message",
					role: "user",
					content: [{ type: "input_text", text: "Second" }],
				},
			],
		};
		const result = translateRequestToAnthropic(req);
		expect(result.messages).toHaveLength(1);
		expect(result.messages[0].content).toHaveLength(2);
		expect(result.messages[0].content[0]).toEqual({
			type: "text",
			text: "First",
		});
		expect(result.messages[0].content[1]).toEqual({
			type: "text",
			text: "Second",
		});
	});

	test("instructions maps to system", () => {
		const req: ResponsesRequest = {
			model: "claude-3-5-sonnet-20241022",
			input: [],
			instructions: "You are a helpful assistant.",
		};
		const result = translateRequestToAnthropic(req);
		expect(result.system).toBe("You are a helpful assistant.");
	});

	test("max_output_tokens=100 → max_tokens=100", () => {
		const req: ResponsesRequest = {
			model: "claude-3-5-sonnet-20241022",
			input: [],
			max_output_tokens: 100,
		};
		const result = translateRequestToAnthropic(req);
		expect(result.max_tokens).toBe(100);
	});

	test("no max_output_tokens → max_tokens=8096", () => {
		const req: ResponsesRequest = {
			model: "claude-3-5-sonnet-20241022",
			input: [],
		};
		const result = translateRequestToAnthropic(req);
		expect(result.max_tokens).toBe(8096);
	});

	test('tool_choice "auto" → {type:"auto"}, "required" → {type:"any"}', () => {
		const req1: ResponsesRequest = {
			model: "claude-3-5-sonnet-20241022",
			input: [],
			tool_choice: "auto",
		};
		expect(translateRequestToAnthropic(req1).tool_choice).toEqual({
			type: "auto",
		});

		const req2: ResponsesRequest = {
			model: "claude-3-5-sonnet-20241022",
			input: [],
			tool_choice: "required",
		};
		expect(translateRequestToAnthropic(req2).tool_choice).toEqual({
			type: "any",
		});

		const req3: ResponsesRequest = {
			model: "claude-3-5-sonnet-20241022",
			input: [],
			tool_choice: "none",
		};
		expect(translateRequestToAnthropic(req3).tool_choice).toEqual({
			type: "none",
		});

		const req4: ResponsesRequest = {
			model: "claude-3-5-sonnet-20241022",
			input: [],
			tool_choice: { type: "function", name: "my_fn" },
		};
		expect(translateRequestToAnthropic(req4).tool_choice).toEqual({
			type: "tool",
			name: "my_fn",
		});

		const req5: ResponsesRequest = {
			model: "claude-3-5-sonnet-20241022",
			input: [],
		};
		expect(translateRequestToAnthropic(req5).tool_choice).toBeUndefined();
	});

	test("tool schema: parameters field becomes input_schema", () => {
		const req: ResponsesRequest = {
			model: "claude-3-5-sonnet-20241022",
			input: [],
			tools: [
				{
					type: "function",
					name: "my_tool",
					description: "Does something",
					parameters: { type: "object", properties: { x: { type: "string" } } },
				},
			],
		};
		const result = translateRequestToAnthropic(req);
		expect(result.tools).toHaveLength(1);
		expect(result.tools?.[0]).toEqual({
			name: "my_tool",
			description: "Does something",
			input_schema: { type: "object", properties: { x: { type: "string" } } },
		});
	});

	test("tool with no parameters → input_schema is empty object", () => {
		const req: ResponsesRequest = {
			model: "claude-3-5-sonnet-20241022",
			input: [],
			tools: [
				{
					type: "function",
					name: "simple_tool",
				},
			],
		};
		const result = translateRequestToAnthropic(req);
		expect(result.tools?.[0].input_schema).toEqual({});
	});

	test("refusal content maps to text", () => {
		const req: ResponsesRequest = {
			model: "claude-3-5-sonnet-20241022",
			input: [
				{
					type: "message",
					role: "assistant",
					content: [{ type: "refusal", refusal: "I cannot do that" }],
				},
			],
		};
		const result = translateRequestToAnthropic(req);
		expect(result.messages[0].content[0]).toEqual({
			type: "text",
			text: "I cannot do that",
		});
	});

	test("input_image URL maps to anthropic image url source", () => {
		const req: ResponsesRequest = {
			model: "claude-3-5-sonnet-20241022",
			input: [
				{
					type: "message",
					role: "user",
					content: [
						{
							type: "input_image",
							image_url: "https://example.com/image.png",
						},
					],
				},
			],
		};
		const result = translateRequestToAnthropic(req);
		expect(result.messages[0].content[0]).toEqual({
			type: "image",
			source: { type: "url", url: "https://example.com/image.png" },
		});
	});

	test("input_image data URL maps to anthropic base64 source", () => {
		const req: ResponsesRequest = {
			model: "claude-3-5-sonnet-20241022",
			input: [
				{
					type: "message",
					role: "user",
					content: [
						{
							type: "input_image",
							image_url: "data:image/png;base64,abc123",
						},
					],
				},
			],
		};
		const result = translateRequestToAnthropic(req);
		expect(result.messages[0].content[0]).toEqual({
			type: "image",
			source: {
				type: "base64",
				media_type: "image/png",
				data: "abc123",
			},
		});
	});

	test("input_image with only file_id maps to placeholder text", () => {
		const req: ResponsesRequest = {
			model: "claude-3-5-sonnet-20241022",
			input: [
				{
					type: "message",
					role: "user",
					content: [
						{
							type: "input_image",
							file_id: "file_123",
						},
					],
				},
			],
		};
		const result = translateRequestToAnthropic(req);
		expect(result.messages[0].content[0]).toEqual({
			type: "text",
			text: "[image file_id: file_123]",
		});
	});

	test("mixed text + input_image preserves content order", () => {
		const req: ResponsesRequest = {
			model: "claude-3-5-sonnet-20241022",
			input: [
				{
					type: "message",
					role: "user",
					content: [
						{ type: "input_text", text: "Before" },
						{ type: "input_image", image_url: "https://example.com/a.png" },
						{ type: "input_text", text: "After" },
					],
				},
			],
		};
		const result = translateRequestToAnthropic(req);
		expect(result.messages[0].content).toEqual([
			{ type: "text", text: "Before" },
			{
				type: "image",
				source: { type: "url", url: "https://example.com/a.png" },
			},
			{ type: "text", text: "After" },
		]);
	});

	test("function_call with invalid JSON arguments falls back to {}", () => {
		const req: ResponsesRequest = {
			model: "claude-3-5-sonnet-20241022",
			input: [
				{
					type: "function_call",
					call_id: "call_bad",
					name: "broken_tool",
					arguments: "not valid json",
				},
			],
		};
		const result = translateRequestToAnthropic(req);
		const toolUse = result.messages[0].content[0] as {
			type: string;
			input: unknown;
		};
		expect(toolUse.input).toEqual({});
	});

	test("custom_tool_call appended like function_call", () => {
		const req: ResponsesRequest = {
			model: "claude-3-5-sonnet-20241022",
			input: [
				{
					type: "custom_tool_call",
					call_id: "call_custom",
					name: "custom_fn",
					arguments: '{"a":1}',
				},
			],
		};
		const result = translateRequestToAnthropic(req);
		expect(result.messages[0].content[0]).toEqual({
			type: "tool_use",
			id: "call_custom",
			name: "custom_fn",
			input: { a: 1 },
		});
	});

	test("custom_tool_call_output → user message with tool_result", () => {
		const req: ResponsesRequest = {
			model: "claude-3-5-sonnet-20241022",
			input: [
				{
					type: "custom_tool_call_output",
					call_id: "call_custom",
					output: "custom result",
				},
			],
		};
		const result = translateRequestToAnthropic(req);
		expect(result.messages[0].content[0]).toEqual({
			type: "tool_result",
			tool_use_id: "call_custom",
			content: "custom result",
		});
	});

	test("model passthrough", () => {
		const req: ResponsesRequest = {
			model: "claude-opus-4-5",
			input: [],
		};
		expect(translateRequestToAnthropic(req).model).toBe("claude-opus-4-5");
	});

	test("stream passthrough", () => {
		const req: ResponsesRequest = {
			model: "claude-3-5-sonnet-20241022",
			input: [],
			stream: true,
		};
		expect(translateRequestToAnthropic(req).stream).toBe(true);
	});
});
