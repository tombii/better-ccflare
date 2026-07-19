/**
 * Characterization tests for the Codex request transform under agentic /
 * multi-subagent ("ultracode / workflow") conversation shapes.
 *
 * These do NOT assert desired behavior — they pin down what the CURRENT
 * transform emits, so we can see (and later fix) the mechanisms that make the
 * Codex path spawn far more subagent turns, and cache far worse, than the
 * native Anthropic path. Each `REVEAL:` test documents a suspected defect.
 */
import { describe, expect, test } from "bun:test";
import { CodexProvider } from "./provider";

const CONTINUATION_NUDGE = "Continue the user's original request now";

interface CodexBody {
	model: string;
	input: Array<Record<string, unknown>>;
	store: boolean;
	instructions?: string;
	tools?: Array<Record<string, unknown>>;
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

const outputs = (input: CodexBody["input"]) =>
	input.filter((it) => it.type === "function_call_output");
const calls = (input: CodexBody["input"]) =>
	input.filter((it) => it.type === "function_call");

describe("Codex transform — continuation nudge behavior", () => {
	test("nudge fires once when a Skill result ends the active turn", async () => {
		const body = await transform({
			model: "claude-opus-4-8",
			max_tokens: 10,
			messages: [
				{ role: "user", content: "run /ce-plan" },
				{
					role: "assistant",
					content: [
						{
							type: "tool_use",
							id: "call_skill_1",
							name: "Skill",
							input: { skill: "ce-plan" },
						},
					],
				},
				{
					role: "user",
					content: [
						{
							type: "tool_result",
							tool_use_id: "call_skill_1",
							content: [{ type: "text", text: "loaded" }],
						},
					],
				},
			],
		});
		expect(nudges(body.input)).toBe(1);
	});

	test("nudge does NOT fire for a replayed Skill result in mid-history", async () => {
		const body = await transform({
			model: "claude-opus-4-8",
			max_tokens: 10,
			messages: [
				{ role: "user", content: "run /ce-plan" },
				{
					role: "assistant",
					content: [
						{ type: "tool_use", id: "call_skill_1", name: "Skill", input: {} },
					],
				},
				{
					role: "user",
					content: [
						{
							type: "tool_result",
							tool_use_id: "call_skill_1",
							content: [{ type: "text", text: "loaded" }],
						},
					],
				},
				{ role: "assistant", content: "Now doing the work." },
				{ role: "user", content: "thanks, continue" },
			],
		});
		expect(nudges(body.input)).toBe(0);
	});

	// REVEAL: whether concurrent Skill invocations in one turn each get a nudge,
	// and how the guard interacts with parallel fan-out.
	test("REVEAL: two Skill results ending the turn — how many nudges?", async () => {
		const body = await transform({
			model: "claude-opus-4-8",
			max_tokens: 10,
			messages: [
				{ role: "user", content: "load two skills" },
				{
					role: "assistant",
					content: [
						{
							type: "tool_use",
							id: "call_skill_a",
							name: "Skill",
							input: { skill: "a" },
						},
						{
							type: "tool_use",
							id: "call_skill_b",
							name: "Skill",
							input: { skill: "b" },
						},
					],
				},
				{
					role: "user",
					content: [
						{
							type: "tool_result",
							tool_use_id: "call_skill_a",
							content: [{ type: "text", text: "a loaded" }],
						},
						{
							type: "tool_result",
							tool_use_id: "call_skill_b",
							content: [{ type: "text", text: "b loaded" }],
						},
					],
				},
			],
		});
		console.log(
			`[characterization] two-skill nudge count = ${nudges(body.input)}`,
		);
		// Pinned now that the single-tail-nudge behavior is implemented: two
		// concurrent Skill results still produce exactly one nudge.
		expect(nudges(body.input)).toBe(1);
	});
});

describe("Codex transform — subagent (Task) tool_result fidelity", () => {
	test("parallel Task fan-out: all call_ids pair with non-empty outputs", async () => {
		const body = await transform({
			model: "claude-opus-4-8",
			max_tokens: 10,
			messages: [
				{ role: "user", content: "review these files" },
				{
					role: "assistant",
					content: [
						{
							type: "tool_use",
							id: "t1",
							name: "Task",
							input: { prompt: "review a" },
						},
						{
							type: "tool_use",
							id: "t2",
							name: "Task",
							input: { prompt: "review b" },
						},
						{
							type: "tool_use",
							id: "t3",
							name: "Task",
							input: { prompt: "review c" },
						},
					],
				},
				{
					role: "user",
					content: [
						{
							type: "tool_result",
							tool_use_id: "t1",
							content: [{ type: "text", text: "finding a" }],
						},
						{
							type: "tool_result",
							tool_use_id: "t2",
							content: [{ type: "text", text: "finding b" }],
						},
						{
							type: "tool_result",
							tool_use_id: "t3",
							content: [{ type: "text", text: "finding c" }],
						},
					],
				},
			],
		});
		expect(
			calls(body.input)
				.map((c) => c.call_id)
				.sort(),
		).toEqual(["t1", "t2", "t3"]);
		const outs = outputs(body.input);
		expect(outs.map((o) => o.call_id).sort()).toEqual(["t1", "t2", "t3"]);
		for (const o of outs)
			expect((o.output as string).length).toBeGreaterThan(0);
	});

	test("non-text image tool_result uses a bounded placeholder", async () => {
		const body = await transform({
			model: "claude-opus-4-8",
			max_tokens: 10,
			messages: [
				{ role: "user", content: "run a subagent" },
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
							content: [
								{
									type: "image",
									source: {
										type: "base64",
										media_type: "image/png",
										data: "AAAA",
									},
								},
							],
						},
					],
				},
			],
		});
		const out = outputs(body.input)[0];
		expect(out?.output).toBe(
			"[image content not supported in Codex tool results]",
		);
		expect(out?.output).not.toContain("AAAA");
	});

	test("tool_reference result blocks are preserved as JSON", async () => {
		const body = await transform({
			model: "claude-opus-4-8",
			max_tokens: 10,
			messages: [
				{ role: "user", content: "load tools" },
				{
					role: "assistant",
					content: [
						{ type: "tool_use", id: "t1", name: "ToolSearch", input: {} },
					],
				},
				{
					role: "user",
					content: [
						{
							type: "tool_result",
							tool_use_id: "t1",
							content: [
								{ type: "tool_reference", tool_name: "TaskCreate" },
								{ type: "tool_reference", tool_name: "TaskUpdate" },
							],
						},
					],
				},
			],
		});
		const out = outputs(body.input)[0];
		expect(out?.output).toBe(
			'{"type":"tool_reference","tool_name":"TaskCreate"}\n' +
				'{"type":"tool_reference","tool_name":"TaskUpdate"}',
		);
	});
});

describe("Codex transform — prompt-cache prefix stability", () => {
	// The nudge is injected as a NEW input item. If it lands anywhere but the tail,
	// it shifts the prefix that Codex prompt-caches, and every following turn misses.
	test("continuation nudge is appended at the tail (prefix before it is stable)", async () => {
		const body = await transform({
			model: "claude-opus-4-8",
			max_tokens: 10,
			messages: [
				{ role: "user", content: "run /ce-plan" },
				{
					role: "assistant",
					content: [
						{ type: "tool_use", id: "call_skill_1", name: "Skill", input: {} },
					],
				},
				{
					role: "user",
					content: [
						{
							type: "tool_result",
							tool_use_id: "call_skill_1",
							content: [{ type: "text", text: "loaded" }],
						},
					],
				},
			],
		});
		const last = body.input[body.input.length - 1];
		expect(nudges([last])).toBe(1);
	});
});
