import { describe, expect, test } from "bun:test";
import { handleResponsesRequest } from "../handler";
import type { HandleProxyFn } from "../types";

// Mock upstream /v1/messages response so the non-stream path can translate.
const ANTHROPIC_MESSAGE_BODY = JSON.stringify({
	id: "msg_1",
	type: "message",
	role: "assistant",
	model: "",
	content: [{ type: "text", text: "Hello" }],
	stop_reason: "end_turn",
	stop_sequence: null,
	usage: { input_tokens: 10, output_tokens: 5 },
});

const validMessage = { type: "message", role: "user", content: "keep me" };
// Codex VS Code clients omit `type` on message items (types.ts:57 makes it
// optional) — these must keep translating, not be dropped as malformed.
const typelessMessage = { role: "user", content: "no type field" };
// An object whose string coercion throws, to prove nothing is coerced.
const coercionHostile = { toString: null, valueOf: null };
const additionalTools = {
	type: "additional_tools",
	tools: [{ type: "computer_use_preview" }],
};

type Forwarded = Record<string, unknown>;

async function runRequest(body: Record<string, unknown>): Promise<{
	status: number;
	json: Record<string, unknown>;
	forwarded: Forwarded[];
}> {
	const forwarded: Forwarded[] = [];
	const proxy: HandleProxyFn = async (request) => {
		forwarded.push((await request.json()) as Forwarded);
		return new Response(ANTHROPIC_MESSAGE_BODY, {
			status: 200,
			headers: { "Content-Type": "application/json" },
		});
	};

	const req = new Request("http://localhost/v1/responses", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});

	const response = await handleResponsesRequest(
		req,
		new URL(req.url),
		proxy,
		{},
	);

	return {
		status: response.status,
		json: (await response.json()) as Record<string, unknown>,
		forwarded,
	};
}

const KEPT_MESSAGE = {
	role: "user",
	content: [{ type: "text", text: "keep me" }],
};

describe("model validation", () => {
	for (const [label, model] of [
		["missing", undefined],
		["null", null],
		["number", 7],
		["boolean", false],
		["array", []],
		["object", {}],
		["coercion-hostile object", coercionHostile],
	] as const) {
		test(`rejects a ${label} model with a 400 before proxy dispatch`, async () => {
			const { status, json, forwarded } = await runRequest({
				model,
				input: "Hi",
			});

			expect(status).toBe(400);
			expect(json).toEqual({
				type: "error",
				error: {
					type: "invalid_request_error",
					message: "model must be a string",
				},
			});
			expect(forwarded).toHaveLength(0);
		});
	}

	test("still accepts an empty-string model", async () => {
		const { status, forwarded } = await runRequest({
			model: "",
			input: [validMessage],
		});

		expect(status).toBe(200);
		expect(forwarded[0].messages).toEqual([KEPT_MESSAGE]);
	});
});

describe("malformed input items", () => {
	for (const [label, item] of [
		["null", null],
		["number", 7],
		["boolean", false],
		["string", "junk"],
		["array", []],
	] as const) {
		test(`drops a ${label} input item instead of failing the request`, async () => {
			const { status, forwarded } = await runRequest({
				model: "",
				input: [item, validMessage],
			});

			expect(status).toBe(200);
			expect(forwarded).toHaveLength(1);
			expect(forwarded[0].messages).toEqual([KEPT_MESSAGE]);
		});
	}

	for (const [label, type] of [
		["null", null],
		["number", 7],
		["boolean", false],
		["array", []],
		["object", {}],
		["coercion-hostile object", coercionHostile],
		["coercion-hostile array", [coercionHostile]],
	] as const) {
		test(`drops an item with a ${label} type instead of failing the request`, async () => {
			const { status, forwarded } = await runRequest({
				model: "",
				input: [{ type }, validMessage],
			});

			expect(status).toBe(200);
			expect(forwarded).toHaveLength(1);
			expect(forwarded[0].messages).toEqual([KEPT_MESSAGE]);
		});
	}

	test("drops a message item whose content is neither string nor array", async () => {
		const { status, forwarded } = await runRequest({
			model: "",
			input: [
				{ type: "message", role: "user" },
				{ type: "message", role: "user", content: 7 },
				{ type: "message", role: "user", content: {} },
				validMessage,
			],
		});

		expect(status).toBe(200);
		expect(forwarded).toHaveLength(1);
		expect(forwarded[0].messages).toEqual([KEPT_MESSAGE]);
	});

	test("preserves typeless message items for Codex VS Code clients", async () => {
		const { status, forwarded } = await runRequest({
			model: "",
			input: [
				typelessMessage,
				{ type: "message", role: "assistant", content: "reply" },
			],
		});

		expect(status).toBe(200);
		expect(forwarded).toHaveLength(1);
		expect(forwarded[0].messages).toEqual([
			{ role: "user", content: [{ type: "text", text: "no type field" }] },
			{ role: "assistant", content: [{ type: "text", text: "reply" }] },
		]);
	});

	test("preserves additional_tools passthrough alongside dropped items", async () => {
		const { status, forwarded } = await runRequest({
			model: "",
			input: [null, 7, false, "junk", [], validMessage, additionalTools],
		});

		expect(status).toBe(200);
		expect(forwarded).toHaveLength(1);
		expect(forwarded[0].messages).toEqual([KEPT_MESSAGE]);
		// The malformed items are dropped from the translated messages but the
		// native input side channel still carries the client's own payload.
		const passthrough = forwarded[0].__better_ccflare_codex_passthrough as {
			model?: unknown;
			additional_tools?: unknown;
			native_input?: unknown;
		};
		expect(passthrough.model).toBe("");
		expect(passthrough.additional_tools).toEqual([additionalTools]);
		expect(passthrough.native_input).toEqual([
			null,
			7,
			false,
			"junk",
			[],
			validMessage,
			additionalTools,
		]);
	});

	test("keeps unknown string item types on the existing drop path", async () => {
		const { status, forwarded } = await runRequest({
			model: "",
			input: [{ type: "future_item" }, validMessage],
		});

		expect(status).toBe(200);
		expect(forwarded).toHaveLength(1);
		expect(forwarded[0].messages).toEqual([KEPT_MESSAGE]);
	});

	test("does not fail the request when every input item is dropped", async () => {
		// Deliberately not a 400: a Codex-native account carries its real
		// conversation in __better_ccflare_codex_passthrough.native_input, so an
		// empty Anthropic messages array is not by itself an invalid request.
		const { status, forwarded } = await runRequest({
			model: "",
			input: [null, { type: coercionHostile }, { type: "message" }],
		});

		expect(status).toBe(200);
		expect(forwarded).toHaveLength(1);
		expect(forwarded[0].messages).toEqual([]);
	});
});

describe("malformed content parts and tool outputs", () => {
	test("treats a null content part as empty text instead of failing", async () => {
		const { status, forwarded } = await runRequest({
			model: "",
			input: [
				{
					type: "message",
					role: "user",
					content: [null, { type: "input_text", text: "hi" }],
				},
			],
		});

		expect(status).toBe(200);
		expect(forwarded[0].messages).toEqual([
			{
				role: "user",
				content: [
					{ type: "text", text: "" },
					{ type: "text", text: "hi" },
				],
			},
		]);
	});

	for (const [label, output] of [
		["missing", undefined],
		["number", 7],
		["object", {}],
	] as const) {
		test(`coerces a ${label} tool output to an empty result instead of failing`, async () => {
			const { status, forwarded } = await runRequest({
				model: "",
				input: [{ type: "function_call_output", call_id: "call_1", output }],
			});

			expect(status).toBe(200);
			expect(forwarded[0].messages).toEqual([
				{
					role: "user",
					content: [
						{ type: "tool_result", tool_use_id: "call_1", content: "" },
					],
				},
			]);
		});
	}

	test("translates a null part inside a tool output to empty text", async () => {
		const { status, forwarded } = await runRequest({
			model: "",
			input: [
				{ type: "function_call_output", call_id: "call_1", output: [null] },
			],
		});

		expect(status).toBe(200);
		expect(forwarded[0].messages).toEqual([
			{
				role: "user",
				content: [
					{
						type: "tool_result",
						tool_use_id: "call_1",
						content: [{ type: "text", text: "" }],
					},
				],
			},
		]);
	});
});

describe("malformed tool declarations", () => {
	test("ignores non-object entries in input, tools and namespace tool lists", async () => {
		const { status, forwarded } = await runRequest({
			model: "",
			input: [null, 7, [], { type: "additional_tools", tools: [null, 7] }],
			tools: [
				null,
				7,
				[],
				{ type: "namespace", name: "ns" },
				{ type: "namespace", name: "ns", tools: [null] },
			],
		});

		expect(status).toBe(200);
		expect(forwarded).toHaveLength(1);
	});

	test("translates a namespaced tool call whose name is not a string", async () => {
		const { status, forwarded } = await runRequest({
			model: "",
			input: [
				{
					type: "function_call",
					call_id: "call_1",
					name: 7,
					namespace: "ns",
					arguments: "{}",
				},
			],
		});

		expect(status).toBe(200);
		const messages = forwarded[0].messages as Array<{
			content: Array<{ name?: string }>;
		}>;
		expect(messages[0].content[0].name).toMatch(/^ns_[0-9a-f]{24}_$/);
	});
});
