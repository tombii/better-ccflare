import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodexProvider } from "./provider";
import { CODEX_TRACE_DIR_ENV, CODEX_TRACE_FULL_ENV } from "./trace";

function messagesRequest(body: unknown): Request {
	return new Request("https://example.com/v1/messages", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
}

const SAMPLE = {
	model: "claude-opus-4-8",
	max_tokens: 10,
	messages: [
		{ role: "user", content: "review" },
		{
			role: "assistant",
			content: [
				{ type: "tool_use", id: "t1", name: "Task", input: { prompt: "a" } },
			],
		},
		{
			role: "user",
			content: [
				{
					type: "tool_result",
					tool_use_id: "t1",
					content: [{ type: "text", text: "done" }],
				},
			],
		},
	],
};

describe("Codex trace wiring (integration)", () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "codex-trace-"));
	});
	afterEach(() => {
		delete process.env[CODEX_TRACE_DIR_ENV];
		delete process.env[CODEX_TRACE_FULL_ENV];
		rmSync(dir, { recursive: true, force: true });
	});

	test("transformRequestBody writes a JSONL record when enabled (summary only)", async () => {
		process.env[CODEX_TRACE_DIR_ENV] = dir;
		await new CodexProvider().transformRequestBody(
			messagesRequest(SAMPLE),
			undefined,
		);

		const files = readdirSync(dir).filter((f) => f.endsWith(".jsonl"));
		expect(files.length).toBe(1);
		const rec = JSON.parse(readFileSync(join(dir, files[0]), "utf8").trim());
		expect(rec.phase).toBe("request");
		expect(rec.model_in).toBe("claude-opus-4-8");
		expect(rec.history_function_call_count).toBe(1);
		expect(rec.history_tool_use_by_name).toEqual({ Task: 1 });
		// full bodies must be absent unless FULL is set
		expect(rec.anthropic_request).toBeUndefined();
	});

	test("embeds full bodies only when CCFLARE_CODEX_TRACE_FULL=1", async () => {
		process.env[CODEX_TRACE_DIR_ENV] = dir;
		process.env[CODEX_TRACE_FULL_ENV] = "1";
		await new CodexProvider().transformRequestBody(
			messagesRequest(SAMPLE),
			undefined,
		);

		const file = readdirSync(dir).find((f) => f.endsWith(".jsonl")) as string;
		const rec = JSON.parse(readFileSync(join(dir, file), "utf8").trim());
		expect(rec.anthropic_request).toBeDefined();
		expect(rec.codex_request).toBeDefined();
	});

	test("writes nothing when the trace dir env is unset", async () => {
		await new CodexProvider().transformRequestBody(
			messagesRequest(SAMPLE),
			undefined,
		);
		expect(readdirSync(dir).length).toBe(0);
	});
});
