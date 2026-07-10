import { afterEach, describe, expect, test } from "bun:test";
import {
	CODEX_TRACE_HMAC_KEY_ENV,
	summarizeCodexResponse,
	summarizeCodexTransform,
} from "./trace";

afterEach(() => {
	delete process.env[CODEX_TRACE_HMAC_KEY_ENV];
});

describe("summarizeCodexTransform (request/history phase)", () => {
	test("counts historical tool calls, outputs, empties, and nudges", () => {
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

		expect(s.history_function_call_count).toBe(3);
		expect(s.history_function_call_output_count).toBe(2);
		expect(s.history_empty_output_count).toBe(1);
		expect(s.nudge_count).toBe(1);
		expect(s.history_tool_use_by_name).toEqual({ Task: 2, Skill: 1 });
	});

	test("captures per-call argument previews, truncated to 120 chars", () => {
		const longArg = `{"prompt":"${"x".repeat(500)}"}`;
		const s = summarizeCodexTransform([
			{
				type: "function_call",
				call_id: "t1",
				name: "Task",
				arguments: longArg,
			},
		]);
		expect(s.history_tool_calls[0].arg_preview.length).toBe(120);
	});

	test("ignores malformed items without throwing", () => {
		const s = summarizeCodexTransform([null, undefined, 42, "str", {}]);
		expect(s.history_function_call_count).toBe(0);
		expect(s.input_item_count).toBe(5);
	});

	test("records byte sizes but no fingerprints without an HMAC key", () => {
		const s = summarizeCodexTransform([{ role: "user", content: "héllo" }]);
		expect(s.input_bytes).toBeGreaterThan(0);
		expect(s.input_hmac).toBeNull();
		expect(s.input_first_item_bytes).toBeGreaterThan(0);
		expect(s.input_first_item_hmac).toBeNull();
		expect(s.input_except_last_item_bytes).toBeNull();
		expect(s.input_except_last_item_hmac).toBeNull();
	});

	test("creates deterministic HMAC fingerprints for full input and structural slices", () => {
		process.env[CODEX_TRACE_HMAC_KEY_ENV] = "test-only-key";
		const input = [
			{ role: "user", content: "first" },
			{ role: "assistant", content: "second" },
		];
		const first = summarizeCodexTransform(input);
		const second = summarizeCodexTransform(input);
		const changed = summarizeCodexTransform([
			input[0],
			{ role: "assistant", content: "changed" },
		]);

		expect(first.input_hmac).toHaveLength(64);
		expect(first.input_hmac).toBe(second.input_hmac);
		expect(first.input_except_last_item_hmac).toBe(
			changed.input_except_last_item_hmac,
		);
		expect(first.input_hmac).not.toBe(changed.input_hmac);
		expect(first.input_first_item_hmac).toBe(changed.input_first_item_hmac);
	});
});

describe("summarizeCodexResponse (response phase)", () => {
	test("counts newly emitted tool calls and computes cache hit pct", () => {
		const s = summarizeCodexResponse(
			[
				{ name: "Task", arg_preview: '{"prompt":"a"}' },
				{ name: "Task", arg_preview: '{"prompt":"b"}' },
				{ name: "Bash", arg_preview: '{"command":"ls"}' },
			],
			{ input_tokens: 1_000, output_tokens: 50, cache_read_input_tokens: 700 },
			"tool_use",
		);
		expect(s.new_tool_call_count).toBe(3);
		expect(s.new_tool_use_by_name).toEqual({ Task: 2, Bash: 1 });
		expect(s.stop_reason).toBe("tool_use");
		// Cached tokens are a subset of total input tokens.
		expect(s.cache_hit_pct).toBe(70);
	});

	test("clamps malformed cached token counts to the total input", () => {
		const s = summarizeCodexResponse(
			[],
			{ input_tokens: 100, cache_read_input_tokens: 700 },
			"end_turn",
		);
		expect(s.cache_hit_pct).toBe(100);
	});

	test("null cache hit pct when no input tokens seen", () => {
		const s = summarizeCodexResponse([], {}, "end_turn");
		expect(s.new_tool_call_count).toBe(0);
		expect(s.cache_hit_pct).toBeNull();
	});

	test("carries upstream error type/message", () => {
		const s = summarizeCodexResponse([], { input_tokens: 10 }, "error", {
			type: "rate_limit_error",
			message: "429",
		});
		expect(s.stop_reason).toBe("error");
		expect(s.error_type).toBe("rate_limit_error");
		expect(s.error_message).toBe("429");
	});
});
