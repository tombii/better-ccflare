/**
 * Fidelity tests for the Codex request transform: these assert DESIRED
 * behavior for the translation-parity gaps identified in the 2026-07 fan-out
 * incident review. A failing test here is a confirmed defect; once fixed,
 * these serve as permanent regressions.
 *
 * Covered dimensions:
 *  - tool_result content robustness (missing/null/non-array content)
 *  - source-order preservation of blocks within a message
 *  - disable_parallel_tool_use mapping
 *  - Skill continuation nudge in mixed parallel final turns
 *  - prompt_cache_key hygiene (length, casing, modern UUID versions)
 *  - bounded serialization of oversized structured blocks
 *  - tool_choice strictness (unknown variants, missing tools)
 *  - is_error signal preservation
 */
import { afterEach, describe, expect, test } from "bun:test";
import { CODEX_PROMPT_CACHE_KEY_ENV, CodexProvider } from "./provider";

const CONTINUATION_NUDGE = "Continue the user's original request now";

interface CodexBody {
	model: string;
	input: Array<Record<string, unknown>>;
	store: boolean;
	instructions?: string;
	tools?: Array<Record<string, unknown>>;
	tool_choice?: unknown;
	parallel_tool_calls?: boolean;
	prompt_cache_key?: string;
}

function makeRequest(body: unknown): Request {
	return new Request("https://example.com/v1/messages", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
}

async function transform(body: unknown): Promise<CodexBody> {
	const provider = new CodexProvider();
	const out = await provider.transformRequestBody(makeRequest(body), undefined);
	return (await out.json()) as CodexBody;
}

const outputs = (input: CodexBody["input"]) =>
	input.filter((it) => it.type === "function_call_output");

function nudges(input: CodexBody["input"]): number {
	return input.filter(
		(it) =>
			it.role === "user" &&
			Array.isArray(it.content) &&
			(it.content as Array<Record<string, unknown>>).some(
				(c) =>
					typeof c.text === "string" && c.text.includes(CONTINUATION_NUDGE),
			),
	).length;
}

/** Minimal valid history: one Task call awaiting its result. */
function taskTurn(
	resultContent: unknown,
	extra: Record<string, unknown> = {},
): unknown {
	return {
		model: "claude-opus-4-8",
		max_tokens: 10,
		messages: [
			{ role: "user", content: "run it" },
			{
				role: "assistant",
				content: [{ type: "tool_use", id: "t1", name: "Task", input: {} }],
			},
			{
				role: "user",
				content: [
					{
						type: "tool_result",
						tool_use_id: "t1",
						...(resultContent === "__omit__" ? {} : { content: resultContent }),
						...extra,
					},
				],
			},
		],
	};
}

afterEach(() => {
	delete process.env[CODEX_PROMPT_CACHE_KEY_ENV];
});

describe("Codex transform, tool_result content robustness", () => {
	test("missing content field degrades to empty output, not a dropped translation", async () => {
		const body = await transform(taskTurn("__omit__"));
		// A throw here is swallowed upstream and the RAW Anthropic body is
		// forwarded to Codex; body.input would be undefined in that case.
		expect(Array.isArray(body.input)).toBe(true);
		expect(outputs(body.input)[0]?.output).toBe("");
	});

	test("null content degrades to empty output", async () => {
		const body = await transform(taskTurn(null));
		expect(Array.isArray(body.input)).toBe(true);
		expect(outputs(body.input)[0]?.output).toBe("");
	});

	test("non-array object content degrades to empty output", async () => {
		const body = await transform(taskTurn({ oops: true }));
		expect(Array.isArray(body.input)).toBe(true);
		expect(outputs(body.input)[0]?.output).toBe("");
	});

	test("null elements inside a content array are skipped, text survives", async () => {
		const body = await transform(
			taskTurn([null, { type: "text", text: "ok" }]),
		);
		expect(Array.isArray(body.input)).toBe(true);
		expect(outputs(body.input)[0]?.output).toBe("ok");
	});
});

describe("Codex transform, source-order preservation", () => {
	test("user message with tool_result then text keeps the result before the text", async () => {
		const body = await transform({
			model: "claude-opus-4-8",
			max_tokens: 10,
			messages: [
				{ role: "user", content: "run it" },
				{
					role: "assistant",
					content: [{ type: "tool_use", id: "t1", name: "Task", input: {} }],
				},
				{
					role: "user",
					content: [
						{
							type: "tool_result",
							tool_use_id: "t1",
							content: [{ type: "text", text: "finding" }],
						},
						{ type: "text", text: "now summarize the finding" },
					],
				},
			],
		});
		const outputIdx = body.input.findIndex(
			(it) => it.type === "function_call_output",
		);
		const followupIdx = body.input.findIndex(
			(it) =>
				it.role === "user" &&
				Array.isArray(it.content) &&
				(it.content as Array<Record<string, unknown>>).some(
					(c) => c.text === "now summarize the finding",
				),
		);
		expect(outputIdx).toBeGreaterThanOrEqual(0);
		expect(followupIdx).toBeGreaterThanOrEqual(0);
		expect(outputIdx).toBeLessThan(followupIdx);
	});

	test("assistant message with tool_use then text keeps the call before the text", async () => {
		const body = await transform({
			model: "claude-opus-4-8",
			max_tokens: 10,
			messages: [
				{ role: "user", content: "go" },
				{
					role: "assistant",
					content: [
						{ type: "tool_use", id: "t1", name: "Bash", input: {} },
						{ type: "text", text: "dispatched, waiting" },
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
		});
		const callIdx = body.input.findIndex((it) => it.type === "function_call");
		const textIdx = body.input.findIndex(
			(it) =>
				it.role === "assistant" &&
				Array.isArray(it.content) &&
				(it.content as Array<Record<string, unknown>>).some(
					(c) => c.text === "dispatched, waiting",
				),
		);
		expect(callIdx).toBeGreaterThanOrEqual(0);
		expect(textIdx).toBeGreaterThanOrEqual(0);
		expect(callIdx).toBeLessThan(textIdx);
	});
});

describe("Codex transform, disable_parallel_tool_use mapping", () => {
	const base = {
		model: "claude-opus-4-8",
		max_tokens: 10,
		messages: [{ role: "user", content: "hi" }],
		tools: [{ name: "Read", input_schema: { type: "object" } }],
	};

	test("auto + disable_parallel_tool_use maps to parallel_tool_calls false", async () => {
		const body = await transform({
			...base,
			tool_choice: { type: "auto", disable_parallel_tool_use: true },
		});
		expect(body.tool_choice).toBe("auto");
		expect(body.parallel_tool_calls).toBe(false);
	});

	test("any + disable_parallel_tool_use maps to required + parallel_tool_calls false", async () => {
		const body = await transform({
			...base,
			tool_choice: { type: "any", disable_parallel_tool_use: true },
		});
		expect(body.tool_choice).toBe("required");
		expect(body.parallel_tool_calls).toBe(false);
	});

	test("absent flag leaves parallel_tool_calls unset", async () => {
		const body = await transform({
			...base,
			tool_choice: { type: "auto" },
		});
		expect(body.parallel_tool_calls).toBeUndefined();
	});
});

describe("Codex transform, Skill nudge in mixed parallel final turns", () => {
	function skillPlusTaskTurn(order: "skill-first" | "skill-last"): unknown {
		const skillResult = {
			type: "tool_result",
			tool_use_id: "s1",
			content: [{ type: "text", text: "skill loaded" }],
		};
		const taskResult = {
			type: "tool_result",
			tool_use_id: "t1",
			content: [{ type: "text", text: "task done" }],
		};
		return {
			model: "claude-opus-4-8",
			max_tokens: 10,
			messages: [
				{ role: "user", content: "go" },
				{
					role: "assistant",
					content: [
						{ type: "tool_use", id: "s1", name: "Skill", input: {} },
						{ type: "tool_use", id: "t1", name: "Task", input: {} },
					],
				},
				{
					role: "user",
					content:
						order === "skill-first"
							? [skillResult, taskResult]
							: [taskResult, skillResult],
				},
			],
		};
	}

	test("skill result followed by a task result still nudges exactly once", async () => {
		const body = await transform(skillPlusTaskTurn("skill-first"));
		expect(nudges(body.input)).toBe(1);
	});

	test("skill result as the last of mixed results nudges exactly once", async () => {
		const body = await transform(skillPlusTaskTurn("skill-last"));
		expect(nudges(body.input)).toBe(1);
	});

	test("nudge lands at the tail so the cached prefix stays stable", async () => {
		const body = await transform(skillPlusTaskTurn("skill-first"));
		expect(nudges([body.input[body.input.length - 1]])).toBe(1);
	});
});

describe("Codex transform, prompt_cache_key hygiene", () => {
	function withSession(sessionId: string): unknown {
		return {
			model: "claude-opus-4-8",
			max_tokens: 10,
			messages: [{ role: "user", content: "hi" }],
			metadata: { user_id: JSON.stringify({ session_id: sessionId }) },
		};
	}

	test("generated key fits the 64-char API bound", async () => {
		process.env[CODEX_PROMPT_CACHE_KEY_ENV] = "1";
		const body = await transform(
			withSession("123e4567-e89b-42d3-a456-426614174000"),
		);
		expect(typeof body.prompt_cache_key).toBe("string");
		expect((body.prompt_cache_key as string).length).toBeLessThanOrEqual(64);
	});

	test("UUID casing is normalized to a single key", async () => {
		process.env[CODEX_PROMPT_CACHE_KEY_ENV] = "1";
		const lower = await transform(
			withSession("123e4567-e89b-42d3-a456-426614174abc"),
		);
		const upper = await transform(
			withSession("123E4567-E89B-42D3-A456-426614174ABC"),
		);
		expect(lower.prompt_cache_key).toBe(upper.prompt_cache_key as string);
	});

	test("UUIDv7 session ids are accepted", async () => {
		process.env[CODEX_PROMPT_CACHE_KEY_ENV] = "1";
		const body = await transform(
			withSession("01890a5d-ac96-774b-bcce-b302099a8057"),
		);
		expect(typeof body.prompt_cache_key).toBe("string");
	});
});

describe("Codex transform, bounded structured block serialization", () => {
	test("oversized structured blocks are omitted with a bounded marker", async () => {
		const bigData = "A".repeat(200_000);
		const body = await transform(
			taskTurn([
				{
					type: "document",
					source: {
						type: "base64",
						media_type: "application/pdf",
						data: bigData,
					},
				},
			]),
		);
		const out = outputs(body.input)[0]?.output as string;
		expect(out.length).toBeLessThan(10_000);
		expect(out).not.toContain(bigData);
		expect(out).toContain("omitted");
	});

	test("small structured blocks remain fully serialized", async () => {
		const body = await transform(
			taskTurn([{ type: "tool_reference", tool_name: "TaskCreate" }]),
		);
		expect(outputs(body.input)[0]?.output).toBe(
			'{"type":"tool_reference","tool_name":"TaskCreate"}',
		);
	});
});

describe("Codex transform, tool_choice strictness", () => {
	test("unknown tool_choice variants are rejected, not coerced to a forced tool", async () => {
		const provider = new CodexProvider();
		const request = makeRequest({
			model: "claude-opus-4-8",
			max_tokens: 10,
			messages: [{ role: "user", content: "hi" }],
			tools: [{ name: "Read", input_schema: { type: "object" } }],
			tool_choice: { type: "bogus", name: "Read" },
		});
		await expect(
			provider.transformRequestBody(request, undefined),
		).rejects.toThrow(/tool_choice/);
	});

	test("named tool_choice without any tools is rejected", async () => {
		const provider = new CodexProvider();
		const request = makeRequest({
			model: "claude-opus-4-8",
			max_tokens: 10,
			messages: [{ role: "user", content: "hi" }],
			tool_choice: { type: "tool", name: "Read" },
		});
		await expect(
			provider.transformRequestBody(request, undefined),
		).rejects.toThrow(/tool_choice/);
	});
});

describe("Codex transform, is_error signal preservation", () => {
	test("errored tool results carry an explicit error marker", async () => {
		const body = await transform(
			taskTurn([{ type: "text", text: "boom" }], { is_error: true }),
		);
		expect(outputs(body.input)[0]?.output).toBe("[tool error] boom");
	});

	test("successful tool results carry no marker", async () => {
		const body = await transform(taskTurn([{ type: "text", text: "fine" }]));
		expect(outputs(body.input)[0]?.output).toBe("fine");
	});
});
