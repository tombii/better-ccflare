/**
 * Analyze a codex-trace JSONL file (produced by CCFLARE_CODEX_TRACE_DIR) for the
 * subagent-storm signature.
 *
 *   bun run packages/providers/src/providers/codex/analyze-trace.ts <codex-trace-YYYY-MM-DD.jsonl>
 *
 * The key re-spawn signal is WITHIN-request duplicate dispatches: the same tool
 * call (name + argument preview) appearing more than once in a single request's
 * input means the model re-dispatched a task whose result it should already have.
 * (Cross-request recurrence is NOT a signal on its own — every turn replays the
 * full conversation, so a past tool call legitimately reappears each turn.)
 */
import { readFileSync } from "node:fs";

export interface TraceRecord {
	ts?: string;
	request_id?: string | null;
	model_out?: string | null;
	input_item_count?: number;
	function_call_count?: number;
	empty_output_count?: number;
	nudge_count?: number;
	tool_use_by_name?: Record<string, number>;
	tool_calls?: Array<{ name: string; arg_preview: string }>;
}

export interface TraceReport {
	requests: number;
	span: { first?: string; last?: string };
	totalToolCalls: number;
	totalNudges: number;
	totalEmptyOutputs: number;
	maxFanOut: number;
	maxInputItems: number;
	fanOutHistogram: Record<string, number>;
	toolUseByName: Record<string, number>;
	/** requests where the same (name+arg) tool call is dispatched >1x within one request */
	respawnRequests: number;
	worstRespawns: Array<{
		request_id: string | null;
		tool: string;
		count: number;
	}>;
}

function keyOf(c: { name: string; arg_preview: string }): string {
	return `${c.name}::${c.arg_preview}`;
}

export function analyzeCodexTrace(
	records: readonly TraceRecord[],
): TraceReport {
	let totalToolCalls = 0;
	let totalNudges = 0;
	let totalEmptyOutputs = 0;
	let maxFanOut = 0;
	let maxInputItems = 0;
	let respawnRequests = 0;
	const fanOutHistogram: Record<string, number> = {};
	const toolUseByName: Record<string, number> = {};
	const worstRespawns: TraceReport["worstRespawns"] = [];
	const timestamps: string[] = [];

	for (const r of records) {
		if (r.ts) timestamps.push(r.ts);
		const fanOut = r.function_call_count ?? 0;
		totalToolCalls += fanOut;
		totalNudges += r.nudge_count ?? 0;
		totalEmptyOutputs += r.empty_output_count ?? 0;
		maxFanOut = Math.max(maxFanOut, fanOut);
		maxInputItems = Math.max(maxInputItems, r.input_item_count ?? 0);
		fanOutHistogram[String(fanOut)] =
			(fanOutHistogram[String(fanOut)] ?? 0) + 1;
		for (const [name, n] of Object.entries(r.tool_use_by_name ?? {})) {
			toolUseByName[name] = (toolUseByName[name] ?? 0) + n;
		}

		// within-request duplicate detection
		const counts = new Map<string, number>();
		for (const c of r.tool_calls ?? []) {
			counts.set(keyOf(c), (counts.get(keyOf(c)) ?? 0) + 1);
		}
		let requestHasRespawn = false;
		for (const [key, count] of counts) {
			if (count > 1) {
				requestHasRespawn = true;
				worstRespawns.push({
					request_id: r.request_id ?? null,
					tool: key,
					count,
				});
			}
		}
		if (requestHasRespawn) respawnRequests++;
	}

	timestamps.sort();
	worstRespawns.sort((a, b) => b.count - a.count);

	return {
		requests: records.length,
		span: { first: timestamps[0], last: timestamps[timestamps.length - 1] },
		totalToolCalls,
		totalNudges,
		totalEmptyOutputs,
		maxFanOut,
		maxInputItems,
		fanOutHistogram,
		toolUseByName,
		respawnRequests,
		worstRespawns: worstRespawns.slice(0, 15),
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
	lines.push(`requests traced : ${report.requests}`);
	lines.push(
		`span            : ${report.span.first ?? "?"} -> ${report.span.last ?? "?"}`,
	);
	lines.push(`total tool calls: ${report.totalToolCalls}`);
	lines.push(`max fan-out/req : ${report.maxFanOut}`);
	lines.push(`max input items : ${report.maxInputItems}`);
	lines.push(`nudges injected : ${report.totalNudges}`);
	lines.push(`empty outputs   : ${report.totalEmptyOutputs}`);
	lines.push(
		`RE-SPAWN reqs   : ${report.respawnRequests}  (same task dispatched >1x within one request)`,
	);
	lines.push(`tool use by name: ${JSON.stringify(report.toolUseByName)}`);
	lines.push(
		`fan-out histogram (calls/req -> #reqs): ${JSON.stringify(report.fanOutHistogram)}`,
	);
	if (report.worstRespawns.length > 0) {
		lines.push("worst within-request re-spawns:");
		for (const w of report.worstRespawns) {
			lines.push(`  x${w.count}  req=${w.request_id ?? "?"}  ${w.tool}`);
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
