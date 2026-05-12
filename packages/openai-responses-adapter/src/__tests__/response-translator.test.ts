import { describe, expect, test } from "bun:test";
import { translateAnthropicResponseToResponses } from "../response-translator";
import type { AnthropicResponse } from "../types";

function makeBaseResponse(
	overrides: Partial<AnthropicResponse> = {},
): AnthropicResponse {
	return {
		id: "msg_base",
		type: "message",
		role: "assistant",
		model: "claude-3-5-sonnet-20241022",
		content: [],
		stop_reason: "end_turn",
		stop_sequence: null,
		usage: { input_tokens: 10, output_tokens: 20 },
		...overrides,
	};
}

describe("translateAnthropicResponseToResponses", () => {
	test("text-only response → single OutputMessageItem in output[]", () => {
		const resp = makeBaseResponse({
			content: [{ type: "text", text: "Hello world" }],
		});
		const result = translateAnthropicResponseToResponses(
			resp,
			"resp_001",
			"claude-3-5-sonnet-20241022",
		);

		expect(result.output).toHaveLength(1);
		const item = result.output[0];
		expect(item.type).toBe("message");
		if (item.type === "message") {
			expect(item.id).toBe("resp_001_msg");
			expect(item.role).toBe("assistant");
			expect(item.status).toBe("completed");
			expect(item.content).toHaveLength(1);
			expect(item.content[0].type).toBe("output_text");
			if (item.content[0].type === "output_text") {
				expect(item.content[0].text).toBe("Hello world");
			}
		}
	});

	test("tool use response → single OutputFunctionCallItem, arguments is valid JSON string", () => {
		const resp = makeBaseResponse({
			content: [
				{
					type: "tool_use",
					id: "toolu_abc",
					name: "get_weather",
					input: { city: "London" },
				},
			],
		});
		const result = translateAnthropicResponseToResponses(
			resp,
			"resp_002",
			"claude-3-5-sonnet-20241022",
		);

		expect(result.output).toHaveLength(1);
		const item = result.output[0];
		expect(item.type).toBe("function_call");
		if (item.type === "function_call") {
			expect(item.id).toBe("resp_002_fc_0");
			expect(item.call_id).toBe("toolu_abc");
			expect(item.name).toBe("get_weather");
			expect(item.status).toBe("completed");
			expect(() => JSON.parse(item.arguments)).not.toThrow();
			expect(JSON.parse(item.arguments)).toEqual({ city: "London" });
		}
	});

	test("mixed response (text + tool) → two items, message first", () => {
		const resp = makeBaseResponse({
			content: [
				{ type: "text", text: "Sure, let me check." },
				{
					type: "tool_use",
					id: "toolu_xyz",
					name: "search",
					input: { query: "weather" },
				},
			],
		});
		const result = translateAnthropicResponseToResponses(
			resp,
			"resp_003",
			"claude-3-5-sonnet-20241022",
		);

		expect(result.output).toHaveLength(2);
		expect(result.output[0].type).toBe("message");
		expect(result.output[1].type).toBe("function_call");

		const msg = result.output[0];
		if (msg.type === "message") {
			expect(msg.content[0].type === "output_text" && msg.content[0].text).toBe(
				"Sure, let me check.",
			);
		}

		const fc = result.output[1];
		if (fc.type === "function_call") {
			expect(fc.call_id).toBe("toolu_xyz");
			expect(fc.name).toBe("search");
		}
	});

	test("multiple tool_use blocks → multiple OutputFunctionCallItem entries", () => {
		const resp = makeBaseResponse({
			content: [
				{
					type: "tool_use",
					id: "toolu_1",
					name: "tool_a",
					input: { x: 1 },
				},
				{
					type: "tool_use",
					id: "toolu_2",
					name: "tool_b",
					input: { y: 2 },
				},
			],
		});
		const result = translateAnthropicResponseToResponses(
			resp,
			"resp_004",
			"claude-3-5-sonnet-20241022",
		);

		expect(result.output).toHaveLength(2);
		expect(result.output[0].type).toBe("function_call");
		expect(result.output[1].type).toBe("function_call");

		const fc0 = result.output[0];
		const fc1 = result.output[1];
		if (fc0.type === "function_call") {
			expect(fc0.id).toBe("resp_004_fc_0");
			expect(fc0.call_id).toBe("toolu_1");
			expect(fc0.name).toBe("tool_a");
		}
		if (fc1.type === "function_call") {
			expect(fc1.id).toBe("resp_004_fc_1");
			expect(fc1.call_id).toBe("toolu_2");
			expect(fc1.name).toBe("tool_b");
		}
	});

	test("usage fields map correctly (input_tokens, output_tokens, total = sum)", () => {
		const resp = makeBaseResponse({
			content: [{ type: "text", text: "hi" }],
			usage: { input_tokens: 42, output_tokens: 17 },
		});
		const result = translateAnthropicResponseToResponses(
			resp,
			"resp_005",
			"claude-3-5-sonnet-20241022",
		);

		expect(result.usage).toBeDefined();
		expect(result.usage?.input_tokens).toBe(42);
		expect(result.usage?.output_tokens).toBe(17);
		expect(result.usage?.total_tokens).toBe(59);
	});

	test("response id, object, status fields are present and correct", () => {
		const resp = makeBaseResponse({
			content: [{ type: "text", text: "ok" }],
		});
		const result = translateAnthropicResponseToResponses(
			resp,
			"resp_006",
			"my-model",
		);

		expect(result.id).toBe("resp_006");
		expect(result.object).toBe("response");
		expect(result.status).toBe("completed");
		expect(result.model).toBe("my-model");
		expect(typeof result.created_at).toBe("number");
		expect(result.created_at).toBeGreaterThan(0);
	});

	test("multiple text blocks → concatenated into single output_text", () => {
		const resp = makeBaseResponse({
			content: [
				{ type: "text", text: "Hello " },
				{ type: "text", text: "world" },
			],
		});
		const result = translateAnthropicResponseToResponses(
			resp,
			"resp_007",
			"claude-3-5-sonnet-20241022",
		);

		expect(result.output).toHaveLength(1);
		const item = result.output[0];
		if (item.type === "message") {
			expect(
				item.content[0].type === "output_text" && item.content[0].text,
			).toBe("Hello world");
		}
	});
});
