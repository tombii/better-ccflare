import { describe, expect, test } from "bun:test";
import { analyzeCodexTrace, parseTraceJsonl } from "./analyze-trace";

describe("analyzeCodexTrace", () => {
	test("aggregates fan-out, nudges, and empties across requests", () => {
		const report = analyzeCodexTrace([
			{
				ts: "2026-07-09T16:07:31Z",
				function_call_count: 3,
				nudge_count: 1,
				empty_output_count: 0,
				input_item_count: 40,
				tool_use_by_name: { Task: 3 },
			},
			{
				ts: "2026-07-09T16:07:36Z",
				function_call_count: 1,
				nudge_count: 0,
				empty_output_count: 1,
				input_item_count: 44,
				tool_use_by_name: { Task: 1 },
			},
		]);
		expect(report.requests).toBe(2);
		expect(report.totalToolCalls).toBe(4);
		expect(report.totalNudges).toBe(1);
		expect(report.totalEmptyOutputs).toBe(1);
		expect(report.maxFanOut).toBe(3);
		expect(report.maxInputItems).toBe(44);
		expect(report.toolUseByName).toEqual({ Task: 4 });
		expect(report.span).toEqual({
			first: "2026-07-09T16:07:31Z",
			last: "2026-07-09T16:07:36Z",
		});
	});

	test("flags within-request duplicate dispatch as a re-spawn", () => {
		const report = analyzeCodexTrace([
			{
				request_id: "req-1",
				function_call_count: 3,
				tool_calls: [
					{ name: "Task", arg_preview: '{"prompt":"review auth"}' },
					{ name: "Task", arg_preview: '{"prompt":"review db"}' },
					{ name: "Task", arg_preview: '{"prompt":"review auth"}' }, // duplicate -> re-spawn
				],
			},
		]);
		expect(report.respawnRequests).toBe(1);
		expect(report.worstRespawns[0]).toEqual({
			request_id: "req-1",
			tool: 'Task::{"prompt":"review auth"}',
			count: 2,
		});
	});

	test("distinct parallel fan-out is NOT flagged as re-spawn", () => {
		const report = analyzeCodexTrace([
			{
				request_id: "req-1",
				function_call_count: 3,
				tool_calls: [
					{ name: "Task", arg_preview: "a" },
					{ name: "Task", arg_preview: "b" },
					{ name: "Task", arg_preview: "c" },
				],
			},
		]);
		expect(report.respawnRequests).toBe(0);
		expect(report.worstRespawns).toEqual([]);
	});

	test("parseTraceJsonl skips blank and malformed lines", () => {
		const recs = parseTraceJsonl(
			'{"function_call_count":2}\n\nnot-json\n{"function_call_count":1}\n',
		);
		expect(recs.length).toBe(2);
	});
});
