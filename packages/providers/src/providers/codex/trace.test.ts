import { describe, expect, test } from "bun:test";
import { summarizeCodexTransform } from "./trace";

describe("summarizeCodexTransform", () => {
	test("counts tool calls, outputs, empties, and nudges", () => {
		const s = summarizeCodexTransform([
			{ role: "user", content: [{ type: "input_text", text: "hi" }] },
			{
				type: "function_call",
				call_id: "t1",
				name: "Task",
				arguments: '{"prompt":"review a"}',
			},
			{
				type: "function_call",
				call_id: "t2",
				name: "Task",
				arguments: '{"prompt":"review b"}',
			},
			{
				type: "function_call",
				call_id: "s1",
				name: "Skill",
				arguments: '{"skill":"ce-plan"}',
			},
			{ type: "function_call_output", call_id: "t1", output: "finding a" },
			{ type: "function_call_output", call_id: "t2", output: "" },
			{
				role: "user",
				content: [
					{
						type: "input_text",
						text: "Continue the user's original request now, applying those instructions.",
					},
				],
			},
		]);

		expect(s.function_call_count).toBe(3);
		expect(s.function_call_output_count).toBe(2);
		expect(s.empty_output_count).toBe(1);
		expect(s.nudge_count).toBe(1);
		expect(s.tool_use_by_name).toEqual({ Task: 2, Skill: 1 });
	});

	test("captures per-call argument previews for cross-turn re-spawn diffing", () => {
		const s = summarizeCodexTransform([
			{
				type: "function_call",
				call_id: "t1",
				name: "Task",
				arguments: '{"prompt":"review the auth module"}',
			},
		]);
		expect(s.tool_calls).toEqual([
			{ name: "Task", arg_preview: '{"prompt":"review the auth module"}' },
		]);
	});

	test("truncates long argument previews to 120 chars", () => {
		const longArg = `{"prompt":"${"x".repeat(500)}"}`;
		const s = summarizeCodexTransform([
			{
				type: "function_call",
				call_id: "t1",
				name: "Task",
				arguments: longArg,
			},
		]);
		expect(s.tool_calls[0].arg_preview.length).toBe(120);
	});

	test("ignores malformed items without throwing", () => {
		const s = summarizeCodexTransform([null, undefined, 42, "str", {}]);
		expect(s.function_call_count).toBe(0);
		expect(s.input_item_count).toBe(5);
	});
});
