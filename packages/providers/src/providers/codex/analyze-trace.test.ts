import { describe, expect, test } from "bun:test";
import { analyzeCodexTrace, parseTraceJsonl } from "./analyze-trace";

describe("analyzeCodexTrace", () => {
	test("separates request history load from response new fan-out", () => {
		const report = analyzeCodexTrace([
			{
				phase: "request",
				ts: "2026-07-10T00:00:01Z",
				history_function_call_count: 171,
				input_item_count: 412,
				approx_input_chars: 573629,
				nudge_count: 0,
			},
			{
				phase: "response",
				ts: "2026-07-10T00:00:02Z",
				new_tool_call_count: 2,
				new_tool_use_by_name: { Task: 2 },
				new_tool_calls: [
					{ name: "Task", arg_preview: "a" },
					{ name: "Task", arg_preview: "b" },
				],
				stop_reason: "tool_use",
				input_tokens: 300,
				cache_read_input_tokens: 700,
				cache_hit_pct: 70,
			},
		]);

		expect(report.requests).toBe(1);
		expect(report.responses).toBe(1);
		// history bloat is large but is NOT counted as new fan-out
		expect(report.request.maxHistoryToolCalls).toBe(171);
		expect(report.response.maxNewFanOut).toBe(2);
		expect(report.response.totalNewToolCalls).toBe(2);
		expect(report.response.newToolUseByName).toEqual({ Task: 2 });
		expect(report.response.cacheHitPctAvg).toBe(70);
		expect(report.response.respawnResponses).toBe(0);
	});

	test("flags within-response duplicate new tool call as a true re-spawn", () => {
		const report = analyzeCodexTrace([
			{
				phase: "response",
				request_id: "r1",
				new_tool_call_count: 3,
				new_tool_calls: [
					{ name: "Task", arg_preview: "review auth" },
					{ name: "Task", arg_preview: "review db" },
					{ name: "Task", arg_preview: "review auth" },
				],
			},
		]);
		expect(report.response.respawnResponses).toBe(1);
		expect(report.response.worstRespawns[0]).toEqual({
			request_id: "r1",
			tool: "Task::review auth",
			count: 2,
		});
	});

	test("counts text-only responses and upstream errors", () => {
		const report = analyzeCodexTrace([
			{ phase: "response", new_tool_call_count: 0, stop_reason: "end_turn" },
			{ phase: "response", new_tool_call_count: 0, stop_reason: "end_turn" },
			{
				phase: "response",
				new_tool_call_count: 0,
				stop_reason: "error",
				error_type: "rate_limit_error",
			},
		]);
		expect(report.response.textOnlyResponses).toBe(2);
		expect(report.response.stopReasons).toEqual({ end_turn: 2, error: 1 });
		expect(report.response.errors).toEqual({ rate_limit_error: 1 });
	});

	test("treats records without a phase as request (back-compat)", () => {
		const report = analyzeCodexTrace([
			{ history_function_call_count: 5, input_item_count: 9 },
		]);
		expect(report.requests).toBe(1);
		expect(report.request.maxHistoryToolCalls).toBe(5);
	});

	test("parseTraceJsonl skips blank and malformed lines", () => {
		const recs = parseTraceJsonl(
			'{"phase":"request"}\n\nnot-json\n{"phase":"response"}\n',
		);
		expect(recs.length).toBe(2);
	});
});
