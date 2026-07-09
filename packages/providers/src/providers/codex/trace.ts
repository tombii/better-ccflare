/**
 * Codex transform trace — permanent, env-gated observability for the Codex
 * request translation.
 *
 * The Codex path can spawn far more subagent turns (and cache far worse) than
 * the native Anthropic path, and production payload capture is usually off. This
 * writes one JSONL record per translated request so a live session can be
 * inspected offline: per-turn tool-call fan-out, re-spawn signatures (identical
 * tool-call argument previews recurring across turns), continuation-nudge
 * injections, and empty tool outputs.
 *
 * Enable:
 *   CCFLARE_CODEX_TRACE_DIR=/path/to/dir     # summaries only (no prompt content)
 *   CCFLARE_CODEX_TRACE_FULL=1               # also embed full request bodies
 *
 * Tracing is best-effort and MUST never affect the request path: all I/O is
 * wrapped so a trace failure is swallowed.
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

export const CODEX_TRACE_DIR_ENV = "CCFLARE_CODEX_TRACE_DIR";
export const CODEX_TRACE_FULL_ENV = "CCFLARE_CODEX_TRACE_FULL";

const CONTINUATION_NUDGE_MARKER = "Continue the user's original request now";

export interface CodexTransformSummary {
	input_item_count: number;
	function_call_count: number;
	function_call_output_count: number;
	empty_output_count: number;
	nudge_count: number;
	tool_use_by_name: Record<string, number>;
	/** name + short argument preview per tool call — diff across turns to spot re-spawns. */
	tool_calls: Array<{ name: string; arg_preview: string }>;
}

/**
 * Pure summarizer over the Codex `input` array. No I/O, no env — unit-testable.
 */
export function summarizeCodexTransform(
	codexInput: readonly unknown[],
): CodexTransformSummary {
	let function_call_count = 0;
	let function_call_output_count = 0;
	let empty_output_count = 0;
	let nudge_count = 0;
	const tool_use_by_name: Record<string, number> = {};
	const tool_calls: Array<{ name: string; arg_preview: string }> = [];

	for (const item of codexInput) {
		if (!item || typeof item !== "object") continue;
		const it = item as Record<string, unknown>;

		if (it.type === "function_call") {
			function_call_count++;
			const name = typeof it.name === "string" ? it.name : "?";
			tool_use_by_name[name] = (tool_use_by_name[name] ?? 0) + 1;
			const args = typeof it.arguments === "string" ? it.arguments : "";
			tool_calls.push({ name, arg_preview: args.slice(0, 120) });
		} else if (it.type === "function_call_output") {
			function_call_output_count++;
			const output = typeof it.output === "string" ? it.output : "";
			if (output.length === 0) empty_output_count++;
		} else if (it.role === "user" && Array.isArray(it.content)) {
			const hasNudge = (it.content as Array<Record<string, unknown>>).some(
				(c) =>
					typeof c?.text === "string" &&
					(c.text as string).includes(CONTINUATION_NUDGE_MARKER),
			);
			if (hasNudge) nudge_count++;
		}
	}

	return {
		input_item_count: codexInput.length,
		function_call_count,
		function_call_output_count,
		empty_output_count,
		nudge_count,
		tool_use_by_name,
		tool_calls,
	};
}

export function codexTraceEnabled(): boolean {
	return Boolean(process.env[CODEX_TRACE_DIR_ENV]);
}

interface TraceInputs {
	requestId?: string;
	account?: string;
	modelIn?: string;
	modelOut?: string;
	messageCount?: number;
	instructionsLen?: number;
	codexInput: readonly unknown[];
	/** full bodies, only embedded when CCFLARE_CODEX_TRACE_FULL=1 */
	anthropicRequest?: unknown;
	codexRequest?: unknown;
}

/**
 * Append one JSONL trace record. No-op (and never throws) when disabled.
 */
export function writeCodexTrace(inputs: TraceInputs): void {
	const dir = process.env[CODEX_TRACE_DIR_ENV];
	if (!dir) return;
	try {
		mkdirSync(dir, { recursive: true });
		const record: Record<string, unknown> = {
			ts: new Date().toISOString(),
			request_id: inputs.requestId ?? null,
			account: inputs.account ?? null,
			model_in: inputs.modelIn ?? null,
			model_out: inputs.modelOut ?? null,
			message_count: inputs.messageCount ?? null,
			instructions_len: inputs.instructionsLen ?? null,
			approx_input_chars: safeLength(inputs.codexInput),
			...summarizeCodexTransform(inputs.codexInput),
		};
		if (process.env[CODEX_TRACE_FULL_ENV] === "1") {
			record.anthropic_request = inputs.anthropicRequest ?? null;
			record.codex_request = inputs.codexRequest ?? null;
		}
		const day = new Date().toISOString().slice(0, 10);
		appendFileSync(
			join(dir, `codex-trace-${day}.jsonl`),
			`${JSON.stringify(record)}\n`,
		);
	} catch {
		// best-effort: tracing must never break the request path
	}
}

function safeLength(value: unknown): number {
	try {
		return JSON.stringify(value)?.length ?? 0;
	} catch {
		return 0;
	}
}
