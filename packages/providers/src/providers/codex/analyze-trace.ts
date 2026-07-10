/**
 * Analyze a codex-trace JSONL file (produced by CCFLARE_CODEX_TRACE_DIR) for the
 * subagent-storm signature.
 *
 *   bun run packages/providers/src/providers/codex/analyze-trace.ts <codex-trace-YYYY-MM-DD.jsonl>
 *
 * Records come in two phases:
 *   phase="request"  -> HISTORICAL tool-call load replayed into Codex (context
 *                       bloat; every turn re-ships the whole transcript).
 *   phase="response" -> NEWLY emitted tool calls from that Codex response. This
 *                       is the real fresh-fan-out signal, plus stop_reason,
 *                       cache hit rate, and upstream errors.
 *
 * The honest "did the model actually spawn N new subagents" number is the
 * response phase max_new_fan_out, NOT the request phase history counts.
 */
import { readFileSync } from "node:fs";

interface ToolCall {
	name: string;
	arg_preview: string;
}

export interface TraceRecord {
	phase?: "request" | "response";
	ts?: string;
	request_id?: string | null;
	model_in?: string | null;
	model_out?: string | null;
	// request phase
	input_item_count?: number;
	approx_input_chars?: number;
	history_function_call_count?: number;
	history_empty_output_count?: number;
	nudge_count?: number;
	history_tool_use_by_name?: Record<string, number>;
	// response phase
	new_tool_call_count?: number;
	new_tool_use_by_name?: Record<string, number>;
	new_tool_calls?: ToolCall[];
	stop_reason?: "tool_use" | "end_turn" | "error";
	input_tokens?: number;
	cache_read_input_tokens?: number;
	cache_hit_pct?: number | null;
	error_type?: string;
}

export interface TraceReport {
	requests: number;
	responses: number;
	span: { first?: string; last?: string };
	request: {
		maxHistoryToolCalls: number;
		maxInputItems: number;
		maxApproxInputChars: number;
		totalNudges: number;
	};
	response: {
		totalNewToolCalls: number;
		maxNewFanOut: number;
		newFanOutHistogram: Record<string, number>;
		newToolUseByName: Record<string, number>;
		stopReasons: Record<string, number>;
		/** responses that ended as text with zero new tool calls (possible tool/schema non-compliance) */
		textOnlyResponses: number;
		errors: Record<string, number>;
		cacheHitPctAvg: number | null;
		/** responses where the same new tool call (name+arg) is emitted >1x (true re-spawn) */
		respawnResponses: number;
		worstRespawns: Array<{
			request_id: string | null;
			tool: string;
			count: number;
		}>;
	};
}

function keyOf(c: ToolCall): string {
	return `${c.name}::${c.arg_preview}`;
}

export function analyzeCodexTrace(
	records: readonly TraceRecord[],
): TraceReport {
	const timestamps: string[] = [];
	let requests = 0;
	let responses = 0;

	// request phase
	let maxHistoryToolCalls = 0;
	let maxInputItems = 0;
	let maxApproxInputChars = 0;
	let totalNudges = 0;

	// response phase
	let totalNewToolCalls = 0;
	let maxNewFanOut = 0;
	let textOnlyResponses = 0;
	let respawnResponses = 0;
	const newFanOutHistogram: Record<string, number> = {};
	const newToolUseByName: Record<string, number> = {};
	const stopReasons: Record<string, number> = {};
	const errors: Record<string, number> = {};
	const worstRespawns: TraceReport["response"]["worstRespawns"] = [];
	const cacheHitPcts: number[] = [];

	for (const r of records) {
		if (r.ts) timestamps.push(r.ts);
		const phase = r.phase ?? "request";

		if (phase === "request") {
			requests++;
			maxHistoryToolCalls = Math.max(
				maxHistoryToolCalls,
				r.history_function_call_count ?? 0,
			);
			maxInputItems = Math.max(maxInputItems, r.input_item_count ?? 0);
			maxApproxInputChars = Math.max(
				maxApproxInputChars,
				r.approx_input_chars ?? 0,
			);
			totalNudges += r.nudge_count ?? 0;
			continue;
		}

		responses++;
		const newCalls = r.new_tool_call_count ?? 0;
		totalNewToolCalls += newCalls;
		maxNewFanOut = Math.max(maxNewFanOut, newCalls);
		newFanOutHistogram[String(newCalls)] =
			(newFanOutHistogram[String(newCalls)] ?? 0) + 1;
		for (const [name, n] of Object.entries(r.new_tool_use_by_name ?? {})) {
			newToolUseByName[name] = (newToolUseByName[name] ?? 0) + n;
		}
		const stop = r.stop_reason ?? "unknown";
		stopReasons[stop] = (stopReasons[stop] ?? 0) + 1;
		if (stop === "end_turn" && newCalls === 0) textOnlyResponses++;
		if (r.error_type) errors[r.error_type] = (errors[r.error_type] ?? 0) + 1;
		if (typeof r.cache_hit_pct === "number") cacheHitPcts.push(r.cache_hit_pct);

		// within-response duplicate new tool calls -> true re-spawn
		const counts = new Map<string, number>();
		for (const c of r.new_tool_calls ?? []) {
			counts.set(keyOf(c), (counts.get(keyOf(c)) ?? 0) + 1);
		}
		let hasRespawn = false;
		for (const [key, count] of counts) {
			if (count > 1) {
				hasRespawn = true;
				worstRespawns.push({
					request_id: r.request_id ?? null,
					tool: key,
					count,
				});
			}
		}
		if (hasRespawn) respawnResponses++;
	}

	timestamps.sort();
	worstRespawns.sort((a, b) => b.count - a.count);

	return {
		requests,
		responses,
		span: { first: timestamps[0], last: timestamps[timestamps.length - 1] },
		request: {
			maxHistoryToolCalls,
			maxInputItems,
			maxApproxInputChars,
			totalNudges,
		},
		response: {
			totalNewToolCalls,
			maxNewFanOut,
			newFanOutHistogram,
			newToolUseByName,
			stopReasons,
			textOnlyResponses,
			errors,
			cacheHitPctAvg:
				cacheHitPcts.length > 0
					? Math.round(
							(10 * cacheHitPcts.reduce((a, b) => a + b, 0)) /
								cacheHitPcts.length,
						) / 10
					: null,
			respawnResponses,
			worstRespawns: worstRespawns.slice(0, 15),
		},
	};
}

export function parseTraceJsonl(text: string): TraceRecord[] {
	const records: TraceRecord[] = [];
	for (const line of text.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		try {
			records.push(JSON.parse(trimmed) as TraceRecord);
		} catch {
			// skip malformed lines
		}
	}
	return records;
}

function formatReport(report: TraceReport): string {
	const lines: string[] = [];
	lines.push(
		`span              : ${report.span.first ?? "?"} -> ${report.span.last ?? "?"}`,
	);
	lines.push(`request records   : ${report.requests}`);
	lines.push(`response records  : ${report.responses}`);
	lines.push("");
	lines.push(
		"REQUEST (historical replay load — context bloat, NOT new fan-out):",
	);
	lines.push(
		`  max history tool calls/req : ${report.request.maxHistoryToolCalls}`,
	);
	lines.push(`  max input items/req        : ${report.request.maxInputItems}`);
	lines.push(
		`  max approx input chars/req : ${report.request.maxApproxInputChars}`,
	);
	lines.push(`  nudges injected            : ${report.request.totalNudges}`);
	lines.push("");
	lines.push("RESPONSE (newly emitted this turn — the real fan-out signal):");
	lines.push(
		`  total new tool calls       : ${report.response.totalNewToolCalls}`,
	);
	lines.push(`  max NEW fan-out / response  : ${report.response.maxNewFanOut}`);
	lines.push(
		`  new fan-out histogram      : ${JSON.stringify(report.response.newFanOutHistogram)}`,
	);
	lines.push(
		`  new tool use by name       : ${JSON.stringify(report.response.newToolUseByName)}`,
	);
	lines.push(
		`  stop_reason distribution   : ${JSON.stringify(report.response.stopReasons)}`,
	);
	lines.push(
		`  text-only responses        : ${report.response.textOnlyResponses}  (end_turn with 0 new tool calls; possible schema/tool non-compliance)`,
	);
	lines.push(
		`  upstream errors            : ${JSON.stringify(report.response.errors)}`,
	);
	lines.push(
		`  avg cache hit %            : ${report.response.cacheHitPctAvg ?? "n/a"}`,
	);
	lines.push(
		`  RE-SPAWN responses         : ${report.response.respawnResponses}  (same new tool call emitted >1x in one response)`,
	);
	if (report.response.worstRespawns.length > 0) {
		lines.push("  worst within-response re-spawns:");
		for (const w of report.response.worstRespawns) {
			lines.push(`    x${w.count}  req=${w.request_id ?? "?"}  ${w.tool}`);
		}
	}
	return lines.join("\n");
}

if (import.meta.main) {
	const file = process.argv[2];
	if (!file) {
		console.error("usage: bun run analyze-trace.ts <codex-trace.jsonl>");
		process.exit(1);
	}
	const report = analyzeCodexTrace(parseTraceJsonl(readFileSync(file, "utf8")));
	console.log(formatReport(report));
}
