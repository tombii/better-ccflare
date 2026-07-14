import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodexProvider } from "./provider";
import { CODEX_TRACE_DIR_ENV, CODEX_TRACE_FULL_ENV } from "./trace";

function messagesRequest(
	body: unknown,
	requestId?: string,
	internalHeaders?: Record<string, string>,
): Request {
	const headers = new Headers({
		"content-type": "application/json",
		...internalHeaders,
	});
	if (requestId) headers.set("x-better-ccflare-request-id", requestId);
	return new Request("https://example.com/v1/messages", {
		method: "POST",
		headers,
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

	test("transformRequestBody traces and strips the internal request id", async () => {
		process.env[CODEX_TRACE_DIR_ENV] = dir;
		const transformed = await new CodexProvider().transformRequestBody(
			messagesRequest(SAMPLE, "req_trace_1"),
			undefined,
		);

		const files = readdirSync(dir).filter((f) => f.endsWith(".jsonl"));
		expect(files.length).toBe(1);
		const rec = JSON.parse(readFileSync(join(dir, files[0]), "utf8").trim());
		expect(rec.trace_schema_version).toBe(4);
		expect(rec.phase).toBe("request");
		expect(rec.request_id).toBe("req_trace_1");
		// Cache-key experiment is off by default in this test environment.
		expect(rec.prompt_cache_key_set).toBe(false);
		expect(rec.prompt_cache_key_id).toBeNull();
		expect(rec.cache_key_mode).toBeNull();
		expect(rec.model_in).toBe("claude-opus-4-8");
		expect(rec.input_bytes).toBeGreaterThan(0);
		expect(rec.input_hmac).toBeNull();
		expect(rec.instructions_bytes).toBeGreaterThan(0);
		expect(rec.instructions_hmac).toBeNull();
		expect(rec.history_function_call_count).toBe(1);
		expect(rec.history_tool_use_by_name).toEqual({ Task: 1 });
		expect(transformed.headers.get("x-better-ccflare-request-id")).toBeNull();
		// full bodies must be absent unless FULL is set
		expect(rec.anthropic_request).toBeUndefined();
	});

	test("traces canary arm and cohort digest, then strips both headers", async () => {
		process.env[CODEX_TRACE_DIR_ENV] = dir;
		const transformed = await new CodexProvider().transformRequestBody(
			messagesRequest(SAMPLE, "req_canary", {
				"x-better-ccflare-pacing-canary": "bypass",
				"x-better-ccflare-pacing-cohort-id": "0123456789abcdef",
			}),
			undefined,
		);
		const file = readdirSync(dir).find((f) => f.endsWith(".jsonl")) as string;
		const rec = JSON.parse(readFileSync(join(dir, file), "utf8").trim());
		expect(rec.pacing_canary).toBe("bypass");
		expect(rec.pacing_cohort_id).toBe("0123456789abcdef");
		expect(
			transformed.headers.get("x-better-ccflare-pacing-canary"),
		).toBeNull();
		expect(
			transformed.headers.get("x-better-ccflare-pacing-cohort-id"),
		).toBeNull();
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
