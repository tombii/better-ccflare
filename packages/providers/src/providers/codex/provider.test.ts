import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fetchCodexUsageOnDemand } from "./on-demand-fetch";
import { CODEX_PROMPT_CACHE_KEY_ENV, CodexProvider } from "./provider";
import { CODEX_TRACE_DIR_ENV } from "./trace";
import { parseCodexUsageHeaders } from "./usage";

const sseBody = (lines: string[]) => `${lines.join("\n")}\n`;
const eventLine = (name: string, data: unknown) => [
	`event: ${name}`,
	`data: ${typeof data === "string" ? data : JSON.stringify(data)}`,
	"",
];
const readTraceRecords = (dir: string): Array<Record<string, unknown>> => {
	const file = readdirSync(dir).find((f) => f.endsWith(".jsonl"));
	if (!file) return [];
	return readFileSync(join(dir, file), "utf8")
		.trim()
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line) as Record<string, unknown>);
};

afterEach(() => {
	delete process.env[CODEX_PROMPT_CACHE_KEY_ENV];
});

describe("CodexProvider request conversion", () => {
	it("handles messages and synthetic count_tokens paths", () => {
		const provider = new CodexProvider();
		expect(provider.canHandle("/v1/messages")).toBeTrue();
		expect(provider.canHandle("/v1/messages/count_tokens")).toBeTrue();
		expect(provider.canHandle("/v1/complete")).toBeFalse();
	});

	it("forwards Claude reasoning effort to Codex reasoning.effort", async () => {
		const provider = new CodexProvider();
		const request = new Request("https://example.com/v1/messages", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				model: "claude-3-5-sonnet-20241022",
				max_tokens: 100,
				reasoning: { effort: "high" },
				messages: [{ role: "user", content: "Hello" }],
			}),
		});

		const transformed = await provider.transformRequestBody(request);
		const body = await transformed.json();

		expect(body.reasoning).toEqual({ effort: "high" });
	});

	it("adds a continuation nudge after Skill tool results", async () => {
		const provider = new CodexProvider();
		const request = new Request("https://example.com/v1/messages", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				model: "claude-3-7-sonnet",
				max_tokens: 10,
				messages: [
					{ role: "user", content: "load /ce-plan" },
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
								content: [{ type: "text", text: "Successfully loaded skill" }],
							},
						],
					},
				],
			}),
		});

		const transformed = await provider.transformRequestBody(request, undefined);
		const body = await transformed.json();

		expect(body.input).toContainEqual({
			role: "user",
			content: [
				{
					type: "input_text",
					text: "The requested Skill tool has loaded additional instructions. Continue the user's original request now, applying those instructions. Do not wait for another user message.",
				},
			],
		});
	});

	it("does not add a continuation nudge after non-Skill tool results", async () => {
		const provider = new CodexProvider();
		const request = new Request("https://example.com/v1/messages", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				model: "claude-3-7-sonnet",
				max_tokens: 10,
				messages: [
					{ role: "user", content: "search" },
					{
						role: "assistant",
						content: [
							{
								type: "tool_use",
								id: "call_search_1",
								name: "WebSearch",
								input: { query: "news" },
							},
						],
					},
					{
						role: "user",
						content: [
							{
								type: "tool_result",
								tool_use_id: "call_search_1",
								content: [{ type: "text", text: "results" }],
							},
						],
					},
				],
			}),
		});

		const transformed = await provider.transformRequestBody(request, undefined);
		const body = await transformed.json();

		expect(JSON.stringify(body.input)).not.toContain(
			"Continue the user's original request now",
		);
	});

	it("does not inject a Skill continuation nudge into replayed mid-history", async () => {
		const provider = new CodexProvider();
		const request = new Request("https://example.com/v1/messages", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				model: "claude-3-7-sonnet",
				max_tokens: 10,
				messages: [
					{ role: "user", content: "load /ce-plan" },
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
								content: [{ type: "text", text: "Successfully loaded skill" }],
							},
						],
					},
					{ role: "assistant", content: "I will apply the plan skill." },
					{ role: "user", content: "continue" },
				],
			}),
		});

		const transformed = await provider.transformRequestBody(request, undefined);
		const body = await transformed.json();

		expect(JSON.stringify(body.input)).not.toContain(
			"Continue the user's original request now",
		);
	});

	it("forwards xhigh reasoning effort to Codex unchanged", async () => {
		const provider = new CodexProvider();
		const request = new Request("https://example.com/v1/messages", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				model: "claude-3-5-sonnet-20241022",
				max_tokens: 100,
				reasoning: { effort: "xhigh" },
				messages: [{ role: "user", content: "Hello" }],
			}),
		});

		const transformed = await provider.transformRequestBody(request);
		const body = await transformed.json();

		expect(body.reasoning).toEqual({ effort: "xhigh" });
	});

	it("uses role-appropriate text block types in Codex input", async () => {
		const provider = new CodexProvider();
		const request = new Request("https://example.com/v1/messages", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				model: "claude-3-5-sonnet-20241022",
				max_tokens: 100,
				messages: [
					{ role: "user", content: "hello" },
					{ role: "assistant", content: "hi" },
					{ role: "developer", content: "follow policy" },
				],
			}),
		});

		const transformed = await provider.transformRequestBody(request);
		const body = await transformed.json();

		expect(body.input[0]).toEqual({
			role: "user",
			content: [{ type: "input_text", text: "hello" }],
		});
		expect(body.input[1]).toEqual({
			role: "assistant",
			content: [{ type: "output_text", text: "hi" }],
		});
		expect(body.input[2]).toEqual({
			role: "system",
			content: [{ type: "input_text", text: "follow policy" }],
		});
	});

	it("marks replayed tool call items as completed", async () => {
		const provider = new CodexProvider();
		const request = new Request("https://example.com/v1/messages", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				model: "claude-3-5-sonnet-20241022",
				max_tokens: 100,
				messages: [
					{
						role: "assistant",
						content: [
							{
								type: "tool_use",
								id: "call_1",
								name: "search",
								input: { query: "hello" },
							},
						],
					},
					{
						role: "user",
						content: [
							{
								type: "tool_result",
								tool_use_id: "call_1",
								content: [{ type: "text", text: "result" }],
							},
						],
					},
				],
			}),
		});

		const transformed = await provider.transformRequestBody(request);
		const body = await transformed.json();

		expect(body.input[0]).toMatchObject({
			type: "function_call",
			call_id: "call_1",
			name: "search",
			arguments: JSON.stringify({ query: "hello" }),
			status: "completed",
		});
		expect(body.input[1]).toMatchObject({
			type: "function_call_output",
			call_id: "call_1",
			output: "result",
			status: "completed",
		});
	});

	it("keeps default Codex reasoning effort when Claude effort is absent", async () => {
		const provider = new CodexProvider();
		const request = new Request("https://example.com/v1/messages", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				model: "claude-3-5-sonnet-20241022",
				max_tokens: 100,
				messages: [{ role: "user", content: "Hello" }],
			}),
		});

		const transformed = await provider.transformRequestBody(request);
		const body = await transformed.json();

		expect(body.reasoning).toEqual({ effort: "medium" });
	});

	it("rejects unsupported reasoning effort values", async () => {
		const provider = new CodexProvider();
		const request = new Request("https://example.com/v1/messages", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				model: "claude-3-5-sonnet-20241022",
				max_tokens: 100,
				reasoning: { effort: "extreme" },
				messages: [{ role: "user", content: "Hello" }],
			}),
		});

		await expect(provider.transformRequestBody(request)).rejects.toThrow(
			"reasoning.effort must be one of: minimal, low, medium, high, xhigh, max",
		);
	});

	it("downgrades efforts unsupported by the mapped Codex model", async () => {
		const provider = new CodexProvider();
		const account = {
			model_mappings: JSON.stringify({ sonnet: "gpt-5.4-mini" }),
		} as Parameters<typeof provider.transformRequestBody>[1];

		const request = new Request("https://example.com/v1/messages", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				model: "claude-3-5-sonnet-20241022",
				max_tokens: 100,
				reasoning: { effort: "xhigh" },
				messages: [{ role: "user", content: "Hello" }],
			}),
		});

		const transformed = await provider.transformRequestBody(request, account);
		const body = await transformed.json();
		expect(body.reasoning).toEqual({ effort: "medium" });
	});

	it("omits empty Read.pages when replaying Anthropic history to Codex", async () => {
		const provider = new CodexProvider();
		const request = new Request("https://example.com/v1/messages", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				model: "claude-3-5-sonnet-20241022",
				max_tokens: 100,
				messages: [
					{
						role: "assistant",
						content: [
							{
								type: "tool_use",
								id: "call_read_1",
								name: "Read",
								input: {
									file_path: "/tmp/full.diff",
									offset: 0,
									limit: 2000,
									pages: "",
								},
							},
						],
					},
				],
			}),
		});

		const transformed = await provider.transformRequestBody(request);
		const body = await transformed.json();

		expect(body.input[0]).toMatchObject({
			type: "function_call",
			call_id: "call_read_1",
			name: "Read",
		});
		expect(JSON.parse(body.input[0].arguments)).toEqual({
			file_path: "/tmp/full.diff",
			offset: 0,
			limit: 2000,
		});
	});

	it("normalizes stored WebSearch tool_use input when replaying Anthropic history to Codex", async () => {
		const provider = new CodexProvider();
		const request = new Request("https://example.com/v1/messages", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				model: "claude-3-5-sonnet-20241022",
				max_tokens: 100,
				messages: [
					{
						role: "assistant",
						content: [
							{
								type: "tool_use",
								id: "call_search_1",
								name: "WebSearch",
								input: {
									query: "latest earnings",
									allowed_domains: [" investors.example.com ", ""],
									blocked_domains: ["spam.example.com"],
								},
							},
						],
					},
				],
			}),
		});

		const transformed = await provider.transformRequestBody(request);
		const body = await transformed.json();

		expect(body.input[0]).toMatchObject({
			type: "function_call",
			call_id: "call_search_1",
			name: "WebSearch",
		});
		expect(JSON.parse(body.input[0].arguments)).toEqual({
			query: "latest earnings",
			allowed_domains: ["investors.example.com"],
		});
	});

	it("preserves falsy non-object tool_use input when replaying Anthropic history to Codex", async () => {
		const provider = new CodexProvider();
		const request = new Request("https://example.com/v1/messages", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				model: "claude-3-5-sonnet-20241022",
				max_tokens: 100,
				messages: [
					{
						role: "assistant",
						content: [
							{
								type: "tool_use",
								id: "call_generic_1",
								name: "generic_tool",
								input: "",
							},
							{
								type: "tool_use",
								id: "call_generic_2",
								name: "generic_tool",
								input: null,
							},
						],
					},
				],
			}),
		});

		const transformed = await provider.transformRequestBody(request);
		const body = await transformed.json();

		expect(body.input[0]).toMatchObject({
			type: "function_call",
			call_id: "call_generic_1",
			name: "generic_tool",
		});
		expect(body.input[0].arguments).toBe('""');
		expect(body.input[1]).toMatchObject({
			type: "function_call",
			call_id: "call_generic_2",
			name: "generic_tool",
		});
		expect(body.input[1].arguments).toBe("null");
	});
});

describe("CodexProvider.processResponse", () => {
	it("buffers tool-call arguments and emits them once before content_block_stop", async () => {
		const provider = new CodexProvider();
		const upstreamBody = sseBody([
			...eventLine("response.created", {
				response: { id: "resp_test", model: "gpt-5.4" },
			}),
			...eventLine("response.output_item.added", {
				item: { type: "function_call", call_id: "call_1", name: "search" },
				output_index: 0,
			}),
			...eventLine("response.function_call_arguments.delta", {
				delta: '{"query":"hel',
				output_index: 0,
			}),
			...eventLine("response.function_call_arguments.delta", {
				delta: 'lo"}',
				output_index: 0,
			}),
			...eventLine("response.output_item.done", {
				item: { type: "function_call", call_id: "call_1", name: "search" },
				output_index: 0,
			}),
			...eventLine("response.completed", {
				response: {
					model: "gpt-5.4",
					usage: { input_tokens: 1, output_tokens: 1 },
				},
			}),
		]);

		const response = new Response(upstreamBody, {
			status: 200,
			headers: { "content-type": "text/event-stream" },
		});

		const transformed = await provider.processResponse(response, null);
		const transformedBody = await transformed.text();

		expect(
			transformedBody.match(/event: content_block_delta/g)?.length ?? 0,
		).toBe(1);
		expect(transformedBody).toContain('"index":0');
		expect(transformedBody).toContain(
			'"partial_json":"{\\"query\\":\\"hello\\"}"',
		);
		const deltaPos = transformedBody.indexOf("event: content_block_delta");
		const stopPos = transformedBody.indexOf("event: content_block_stop");
		expect(deltaPos).toBeGreaterThanOrEqual(0);
		expect(stopPos).toBeGreaterThan(deltaPos);
		expect(transformedBody).toContain('"stop_reason":"tool_use"');
	});

	it("omits empty Read.pages from streaming tool-call arguments", async () => {
		const provider = new CodexProvider();
		const upstreamBody = sseBody([
			...eventLine("response.created", {
				response: { id: "resp_test", model: "gpt-5.4" },
			}),
			...eventLine("response.output_item.added", {
				item: { type: "function_call", call_id: "call_1", name: "Read" },
				output_index: 0,
			}),
			...eventLine("response.function_call_arguments.delta", {
				delta: '{"file_path":"/tmp/full.diff","offset":0,',
				output_index: 0,
			}),
			...eventLine("response.function_call_arguments.delta", {
				delta: '"limit":2000,"pages":""}',
				output_index: 0,
			}),
			...eventLine("response.output_item.done", {
				item: { type: "function_call", call_id: "call_1", name: "Read" },
				output_index: 0,
			}),
			...eventLine("response.completed", {
				response: {
					model: "gpt-5.4",
					usage: { input_tokens: 1, output_tokens: 1 },
				},
			}),
		]);

		const response = new Response(upstreamBody, {
			status: 200,
			headers: { "content-type": "text/event-stream" },
		});

		const transformed = await provider.processResponse(response, null);
		const transformedBody = await transformed.text();

		expect(transformedBody).toContain(
			'"partial_json":"{\\"file_path\\":\\"/tmp/full.diff\\",\\"offset\\":0,\\"limit\\":2000}"',
		);
		expect(transformedBody).not.toContain('\\"pages\\"');
	});

	it("omits invalid WebSearch domain filters from streaming tool-call arguments", async () => {
		const provider = new CodexProvider();
		const upstreamBody = sseBody([
			...eventLine("response.created", {
				response: { id: "resp_test", model: "gpt-5.4" },
			}),
			...eventLine("response.output_item.added", {
				item: { type: "function_call", call_id: "call_1", name: "WebSearch" },
				output_index: 0,
			}),
			...eventLine("response.function_call_arguments.delta", {
				delta: '{"query":"earnings","allowed_domains":[],',
				output_index: 0,
			}),
			...eventLine("response.function_call_arguments.delta", {
				delta: '"blocked_domains":[""]}',
				output_index: 0,
			}),
			...eventLine("response.output_item.done", {
				item: { type: "function_call", call_id: "call_1", name: "WebSearch" },
				output_index: 0,
			}),
			...eventLine("response.completed", {
				response: {
					model: "gpt-5.4",
					usage: { input_tokens: 1, output_tokens: 1 },
				},
			}),
		]);

		const response = new Response(upstreamBody, {
			status: 200,
			headers: { "content-type": "text/event-stream" },
		});

		const transformed = await provider.processResponse(response, null);
		const transformedBody = await transformed.text();

		expect(transformedBody).toContain(
			'"partial_json":"{\\"query\\":\\"earnings\\"}"',
		);
		expect(transformedBody).not.toContain("allowed_domains");
		expect(transformedBody).not.toContain("blocked_domains");
	});

	it("uses the function_call block index rather than the current text block index", async () => {
		const provider = new CodexProvider();
		const upstreamBody = sseBody([
			...eventLine("response.created", {
				response: { id: "resp_test", model: "gpt-5.4" },
			}),
			...eventLine("response.output_item.added", {
				item: { type: "function_call", call_id: "call_1", name: "search" },
				output_index: 0,
			}),
			...eventLine("response.output_item.added", {
				item: { type: "message" },
				output_index: 1,
			}),
			...eventLine("response.content_part.added", {
				part: { type: "output_text" },
			}),
			...eventLine("response.output_text.delta", { delta: "hello" }),
			...eventLine("response.function_call_arguments.delta", {
				delta: '{"query":"hel',
				output_index: 0,
			}),
			...eventLine("response.function_call_arguments.delta", {
				delta: 'lo"}',
				output_index: 0,
			}),
			...eventLine("response.output_item.done", {
				item: { type: "function_call", call_id: "call_1", name: "search" },
				output_index: 0,
			}),
			...eventLine("response.completed", {
				response: {
					model: "gpt-5.4",
					usage: { input_tokens: 1, output_tokens: 1 },
				},
			}),
		]);

		const response = new Response(upstreamBody, {
			status: 200,
			headers: { "content-type": "text/event-stream" },
		});

		const transformed = await provider.processResponse(response, null);
		const transformedBody = await transformed.text();
		const deltaLine = transformedBody
			.split("\n")
			.find(
				(line) =>
					line.includes('"type":"content_block_delta"') &&
					line.includes('"input_json_delta"'),
			);

		expect(deltaLine).not.toBeUndefined();
		expect(deltaLine).toContain('"index":0');
		expect(deltaLine).toContain('"partial_json":"{\\"query\\":\\"hello\\"}"');
	});

	it("does not emit premature content_block_stop for function-call when text block opens concurrently", async () => {
		const provider = new CodexProvider();
		const upstreamBody = sseBody([
			...eventLine("response.created", {
				response: { id: "resp_test", model: "gpt-5.4" },
			}),
			...eventLine("response.output_item.added", {
				item: { type: "function_call", call_id: "call_1", name: "search" },
				output_index: 0,
			}),
			...eventLine("response.output_item.added", {
				item: { type: "message" },
				output_index: 1,
			}),
			...eventLine("response.content_part.added", {
				part: { type: "output_text" },
			}),
			...eventLine("response.output_text.delta", { delta: "hello" }),
			...eventLine("response.function_call_arguments.delta", {
				delta: '{"q":1}',
				output_index: 0,
			}),
			...eventLine("response.output_item.done", {
				item: { type: "function_call", call_id: "call_1", name: "search" },
				output_index: 0,
			}),
			...eventLine("response.completed", {
				response: {
					model: "gpt-5.4",
					usage: { input_tokens: 1, output_tokens: 1 },
				},
			}),
		]);

		const response = new Response(upstreamBody, {
			status: 200,
			headers: { "content-type": "text/event-stream" },
		});

		const transformed = await provider.processResponse(response, null);
		const transformedBody = await transformed.text();
		const events = transformedBody
			.split("\n")
			.filter((l) => l.startsWith("data:"))
			.map(
				(l) =>
					JSON.parse(l.slice("data:".length).trim()) as Record<string, unknown>,
			);

		// Collect events for block index 0 in order
		const block0Events = events
			.filter(
				(e) =>
					(e.type === "content_block_start" ||
						e.type === "content_block_stop" ||
						e.type === "content_block_delta") &&
					(e.index === 0 ||
						(e.type === "content_block_start" &&
							(e.content_block as Record<string, unknown>)?.type ===
								"tool_use")),
			)
			.map((e) => e.type);

		// Must be: start → delta → stop (no premature stop before delta)
		expect(block0Events).toEqual([
			"content_block_start",
			"content_block_delta",
			"content_block_stop",
		]);

		// Text block (index 1) must come after function-call block opens
		const block1Start = events.findIndex(
			(e) => e.type === "content_block_start" && e.index === 1,
		);
		const block0Stop = events.findIndex(
			(e) => e.type === "content_block_stop" && e.index === 0,
		);
		expect(block1Start).toBeGreaterThan(-1);
		expect(block0Stop).toBeGreaterThan(block1Start);
	});

	it("includes input_tokens when model metadata is unavailable", async () => {
		const provider = new CodexProvider();
		const upstreamBody = sseBody([
			...eventLine("response.created", {
				response: { id: "resp_test", model: "unknown-model" },
			}),
			...eventLine("response.completed", {
				response: {
					model: "unknown-model",
					usage: {
						input_tokens: 12,
						output_tokens: 3,
						input_tokens_details: { cached_tokens: 4 },
					},
				},
			}),
		]);

		const response = new Response(upstreamBody, {
			status: 200,
			headers: { "content-type": "text/event-stream" },
		});

		const transformed = await provider.processResponse(response, null);
		const transformedBody = await transformed.text();
		const messageDeltaLine = transformedBody
			.split("\n")
			.find((line) => line.includes('"type":"message_delta"'));

		expect(messageDeltaLine).not.toBeUndefined();
		expect(messageDeltaLine).not.toContain('"context_window"');
		expect(messageDeltaLine).toContain('"usage":{');
		expect(messageDeltaLine).toContain('"output_tokens":3');
		expect(messageDeltaLine).toContain('"input_tokens":12');
		expect(messageDeltaLine).toContain('"cache_read_input_tokens":4');
	});

	it("normalizes message_delta usage and delta defaults when missing", async () => {
		const provider = new CodexProvider();
		const upstreamBody = sseBody([
			...eventLine("response.created", {
				response: { id: "resp_test", model: "gpt-5.4" },
			}),
			...eventLine("response.completed", {
				response: {
					model: "gpt-5.4",
					usage: { input_tokens: 5, output_tokens: 2 },
				},
			}),
		]);

		const response = new Response(upstreamBody, {
			status: 200,
			headers: { "content-type": "text/event-stream" },
		});

		const transformed = await provider.processResponse(response, null);
		const transformedBody = await transformed.text();
		const messageDeltaLine = transformedBody
			.split("\n")
			.find((line) => line.includes('"type":"message_delta"'));

		expect(messageDeltaLine).not.toBeUndefined();
		const dataPrefix = "data: ";
		expect(messageDeltaLine?.startsWith(dataPrefix)).toBeTrue();
		const payload = JSON.parse(
			(messageDeltaLine as string).slice(dataPrefix.length),
		);
		expect(payload.usage.input_tokens).toBe(5);
		expect(payload.usage.output_tokens).toBe(2);
		expect(payload.usage.cache_read_input_tokens).toBe(0);
		expect(payload.usage.cache_creation_input_tokens).toBe(0);
		expect(payload.delta.stop_reason).toBe("end_turn");
		expect(payload.delta.stop_sequence).toBe(null);
	});

	it("successful JSON responses pass through unchanged", async () => {
		const provider = new CodexProvider();
		const body = JSON.stringify({
			type: "message",
			message: { role: "assistant", content: [] },
		});
		const response = new Response(body, {
			status: 200,
			headers: { "content-type": "application/json" },
		});

		const transformed = await provider.processResponse(response, null);
		expect(transformed.headers.get("content-type")).toContain(
			"application/json",
		);
		expect(await transformed.text()).toBe(body);
	});

	it("returns Anthropic JSON for non-streaming requests when upstream returns SSE", async () => {
		const provider = new CodexProvider();
		const requestId = "req_non_stream_1";
		const originalRequest = new Request("https://example.test/v1/messages", {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"x-better-ccflare-request-id": requestId,
			},
			body: JSON.stringify({
				model: "claude-sonnet-4-5",
				max_tokens: 16,
				stream: false,
				messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
			}),
		});
		await provider.transformRequestBody(originalRequest);

		const upstreamBody = sseBody([
			...eventLine("response.created", {
				response: { id: "resp_test", model: "gpt-5.4" },
			}),
			...eventLine("response.output_item.added", {
				item: { type: "message" },
				output_index: 0,
			}),
			...eventLine("response.content_part.added", {
				part: { type: "output_text" },
			}),
			...eventLine("response.output_text.delta", { delta: "Hi" }),
			...eventLine("response.completed", {
				response: {
					model: "gpt-5.4",
					usage: { input_tokens: 7, output_tokens: 2 },
				},
			}),
		]);
		const response = new Response(upstreamBody, {
			status: 200,
			headers: {
				"content-type": "text/event-stream",
				"x-better-ccflare-request-id": requestId,
				"x-better-ccflare-request-stream": "false",
			},
		});

		const transformed = await provider.processResponse(response, null);
		expect(transformed.headers.get("content-type")).toContain(
			"application/json",
		);
		const payload = JSON.parse(await transformed.text()) as Record<
			string,
			unknown
		>;
		expect(payload.type).toBe("message");
		expect(payload.role).toBe("assistant");
		expect(payload.content).toEqual([{ type: "text", text: "Hi" }]);
		expect(payload.usage).toEqual({
			input_tokens: 7,
			output_tokens: 2,
			cache_read_input_tokens: 0,
			cache_creation_input_tokens: 0,
		});
	});

	it("preserves tool_use content in non-streaming SSE->JSON conversion", async () => {
		const provider = new CodexProvider();
		const requestId = "req_non_stream_tool_1";
		const originalRequest = new Request("https://example.test/v1/messages", {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"x-better-ccflare-request-id": requestId,
			},
			body: JSON.stringify({
				model: "claude-sonnet-4-5",
				max_tokens: 16,
				stream: false,
				tools: [
					{
						name: "search",
						description: "search",
						input_schema: {
							type: "object",
							properties: { query: { type: "string" } },
						},
					},
				],
				messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
			}),
		});
		await provider.transformRequestBody(originalRequest);

		const upstreamBody = sseBody([
			...eventLine("response.created", {
				response: { id: "resp_tool", model: "gpt-5.4" },
			}),
			...eventLine("response.output_item.added", {
				item: { type: "function_call", call_id: "call_1", name: "search" },
				output_index: 0,
			}),
			...eventLine("response.function_call_arguments.delta", {
				delta: '{"query":"hel',
				output_index: 0,
			}),
			...eventLine("response.function_call_arguments.delta", {
				delta: 'lo"}',
				output_index: 0,
			}),
			...eventLine("response.output_item.done", {
				item: { type: "function_call", call_id: "call_1", name: "search" },
				output_index: 0,
			}),
			...eventLine("response.completed", {
				response: {
					model: "gpt-5.4",
					usage: { input_tokens: 9, output_tokens: 4 },
				},
			}),
		]);
		const response = new Response(upstreamBody, {
			status: 200,
			headers: {
				"content-type": "text/event-stream",
				"x-better-ccflare-request-id": requestId,
				"x-better-ccflare-request-stream": "false",
			},
		});

		const transformed = await provider.processResponse(response, null);
		const payload = JSON.parse(await transformed.text()) as Record<
			string,
			unknown
		>;
		expect(payload.content).toEqual([
			{
				type: "tool_use",
				id: "call_1",
				name: "search",
				input: { query: "hello" },
			},
		]);
		expect(payload.stop_reason).toBe("tool_use");
	});

	it("omits invalid WebSearch domain filters from non-streaming tool_use input", async () => {
		const provider = new CodexProvider();
		const requestId = "req_non_stream_websearch_domains";
		const originalRequest = new Request("https://example.test/v1/messages", {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"x-better-ccflare-request-id": requestId,
			},
			body: JSON.stringify({
				model: "claude-sonnet-4-5",
				max_tokens: 16,
				stream: false,
				tools: [
					{
						name: "WebSearch",
						description: "search",
						input_schema: {
							type: "object",
							properties: {
								allowed_domains: { type: "array", items: { type: "string" } },
								blocked_domains: { type: "array", items: { type: "string" } },
							},
						},
					},
				],
				messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
			}),
		});
		await provider.transformRequestBody(originalRequest);

		const upstreamBody = sseBody([
			...eventLine("response.created", {
				response: { id: "resp_tool", model: "gpt-5.4" },
			}),
			...eventLine("response.output_item.added", {
				item: { type: "function_call", call_id: "call_1", name: "WebSearch" },
				output_index: 0,
			}),
			...eventLine("response.function_call_arguments.delta", {
				delta:
					'{"query":"earnings","allowed_domains":["reuters.com"],"blocked_domains":["seekingalpha.com"]}',
				output_index: 0,
			}),
			...eventLine("response.output_item.done", {
				item: { type: "function_call", call_id: "call_1", name: "WebSearch" },
				output_index: 0,
			}),
			...eventLine("response.completed", {
				response: {
					model: "gpt-5.4",
					usage: { input_tokens: 9, output_tokens: 4 },
				},
			}),
		]);
		const response = new Response(upstreamBody, {
			status: 200,
			headers: {
				"content-type": "text/event-stream",
				"x-better-ccflare-request-id": requestId,
				"x-better-ccflare-request-stream": "false",
			},
		});

		const transformed = await provider.processResponse(response, null);
		const payload = JSON.parse(await transformed.text()) as Record<
			string,
			unknown
		>;
		expect(payload.content).toEqual([
			{
				type: "tool_use",
				id: "call_1",
				name: "WebSearch",
				input: { query: "earnings", allowed_domains: ["reuters.com"] },
			},
		]);
	});

	it("preserves non-object tool arguments in non-streaming SSE-to-JSON conversion", async () => {
		const provider = new CodexProvider();
		const requestId = "req_non_stream_non_object_tool_input";
		const originalRequest = new Request("https://example.test/v1/messages", {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"x-better-ccflare-request-id": requestId,
			},
			body: JSON.stringify({
				model: "claude-sonnet-4-5",
				max_tokens: 16,
				stream: false,
				tools: [
					{
						name: "generic_tool",
						description: "generic",
						input_schema: { type: "object" },
					},
				],
				messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
			}),
		});
		await provider.transformRequestBody(originalRequest);

		const upstreamBody = sseBody([
			...eventLine("response.created", {
				response: { id: "resp_tool", model: "gpt-5.4" },
			}),
			...eventLine("response.output_item.added", {
				item: {
					type: "function_call",
					call_id: "call_1",
					name: "generic_tool",
				},
				output_index: 0,
			}),
			...eventLine("response.function_call_arguments.delta", {
				delta: "null",
				output_index: 0,
			}),
			...eventLine("response.output_item.done", {
				item: {
					type: "function_call",
					call_id: "call_1",
					name: "generic_tool",
				},
				output_index: 0,
			}),
			...eventLine("response.completed", {
				response: {
					model: "gpt-5.4",
					usage: { input_tokens: 9, output_tokens: 4 },
				},
			}),
		]);
		const response = new Response(upstreamBody, {
			status: 200,
			headers: {
				"content-type": "text/event-stream",
				"x-better-ccflare-request-id": requestId,
				"x-better-ccflare-request-stream": "false",
			},
		});

		const transformed = await provider.processResponse(response, null);
		const payload = JSON.parse(await transformed.text()) as Record<
			string,
			unknown
		>;
		expect(payload.content).toEqual([
			{
				type: "tool_use",
				id: "call_1",
				name: "generic_tool",
				input: null,
			},
		]);
	});

	it("maps response.completed usage into Claude-compatible context_window using model metadata", async () => {
		const provider = new CodexProvider();
		const upstreamBody = sseBody([
			...eventLine("response.created", {
				response: { id: "resp_test", model: "gpt-5.3-codex" },
			}),
			...eventLine("response.completed", {
				response: {
					model: "gpt-5.3-codex",
					usage: {
						input_tokens: 100,
						output_tokens: 50,
						input_tokens_details: {
							cached_tokens: 25,
							cache_creation_input_tokens: 10,
						},
					},
				},
			}),
		]);

		const response = new Response(upstreamBody, {
			status: 200,
			headers: { "content-type": "text/event-stream" },
		});

		const transformed = await provider.processResponse(response, null);
		const transformedBody = await transformed.text();
		const messageDeltaLine = transformedBody
			.split("\n")
			.find((line) => line.includes('"type":"message_delta"'));

		expect(messageDeltaLine).toContain('"context_window"');
		expect(messageDeltaLine).toContain('"cache_read_input_tokens":25');
		expect(messageDeltaLine).toContain('"cache_creation_input_tokens":10');
		expect(messageDeltaLine).toContain('"context_window_size":272000');
	});

	it("omits context_window when model metadata is unavailable", async () => {
		const provider = new CodexProvider();
		const upstreamBody = sseBody([
			...eventLine("response.created", {
				response: { id: "resp_test", model: "unknown-model" },
			}),
			...eventLine("response.completed", {
				response: {
					model: "unknown-model",
					usage: {
						input_tokens: 12,
						output_tokens: 3,
						input_tokens_details: { cached_tokens: 4 },
					},
				},
			}),
		]);

		const response = new Response(upstreamBody, {
			status: 200,
			headers: { "content-type": "text/event-stream" },
		});

		const transformed = await provider.processResponse(response, null);
		const transformedBody = await transformed.text();
		const messageDeltaLine = transformedBody
			.split("\n")
			.find((line) => line.includes('"type":"message_delta"'));

		expect(messageDeltaLine).not.toContain('"context_window"');
		expect(messageDeltaLine).toContain('"output_tokens":3');
	});

	it("fallback message_start includes top-level usage", async () => {
		const provider = new CodexProvider();
		const upstreamBody = sseBody([
			...eventLine("response.output_item.added", {
				item: { type: "message" },
				output_index: 0,
			}),
			...eventLine("response.content_part.added", {
				part: { type: "output_text" },
			}),
			...eventLine("response.output_text.delta", { delta: "hello" }),
		]);
		const response = new Response(upstreamBody, {
			status: 200,
			headers: { "content-type": "text/event-stream" },
		});
		const transformed = await provider.processResponse(response, null);
		const transformedBody = await transformed.text();
		const messageStartLine = transformedBody
			.split("\n")
			.find((line) => line.includes('"type":"message_start"'));
		const messageDeltaLine = transformedBody
			.split("\n")
			.find((line) => line.includes('"type":"message_delta"'));

		expect(messageStartLine).not.toBeUndefined();
		const payload = JSON.parse(
			(messageStartLine as string).slice("data: ".length),
		);
		expect(payload.usage.input_tokens).toBe(0);
		expect(payload.usage.output_tokens).toBe(0);
		expect(payload.usage.cache_read_input_tokens).toBe(0);
		expect(payload.usage.cache_creation_input_tokens).toBe(0);
		expect(payload.message.usage.input_tokens).toBe(0);
		expect(payload.message.usage.output_tokens).toBe(0);
		expect(messageDeltaLine).not.toBeUndefined();
		expect(messageDeltaLine).toContain('"usage":{');
		expect(messageDeltaLine).toContain('"input_tokens":0');
		expect(messageDeltaLine).toContain('"output_tokens":0');
		expect(messageDeltaLine).toContain(
			'"delta":{"stop_reason":"end_turn","stop_sequence":null,"usage":{',
		);
	});

	it("includes cache_creation_input_tokens in synthesized context_window when present", async () => {
		const provider = new CodexProvider();
		const upstreamBody = sseBody([
			...eventLine("response.created", {
				response: { id: "resp_test", model: "gpt-5.4" },
			}),
			...eventLine("response.completed", {
				response: {
					model: "gpt-5.4",
					usage: {
						input_tokens: 42,
						output_tokens: 7,
						input_tokens_details: {
							cached_tokens: 5,
							cache_creation_input_tokens: 9,
						},
					},
				},
			}),
		]);

		const response = new Response(upstreamBody, {
			status: 200,
			headers: { "content-type": "text/event-stream" },
		});

		const transformed = await provider.processResponse(response, null);
		const transformedBody = await transformed.text();
		const messageDeltaLine = transformedBody
			.split("\n")
			.find((line) => line.includes('"type":"message_delta"'));

		expect(messageDeltaLine).not.toBeUndefined();
		expect(messageDeltaLine).toContain('"cache_creation_input_tokens":9');
		expect(messageDeltaLine).toContain('"context_window"');
		expect(messageDeltaLine).toContain('"context_window_size":272000');
	});

	it("treats successful missing-content-type SSE bodies as streams", async () => {
		const provider = new CodexProvider();
		const upstreamBody = sseBody([
			...eventLine("response.created", {
				response: { id: "resp_test", model: "gpt-5.4" },
			}),
			...eventLine("response.output_item.added", {
				item: { type: "message" },
				output_index: 0,
			}),
			...eventLine("response.content_part.added", {
				part: { type: "output_text" },
			}),
			...eventLine("response.output_text.delta", { delta: "hello" }),
			...eventLine("response.completed", {
				response: {
					model: "gpt-5.4",
					usage: { input_tokens: 2, output_tokens: 1 },
				},
			}),
		]);

		const response = new Response(upstreamBody, {
			status: 200,
			headers: {},
		});

		const transformed = await provider.processResponse(response, null);
		expect(transformed.headers.get("content-type")).toContain(
			"text/event-stream",
		);
		const transformedBody = await transformed.text();
		expect(transformedBody).toContain("event: message_start");
		expect(transformedBody).toContain("event: message_delta");
		expect(transformedBody).toContain(
			'"usage":{"input_tokens":2,"output_tokens":1',
		);
	});

	it("preserves request id in traces for missing-content-type SSE streams", async () => {
		const provider = new CodexProvider();
		const requestId = "req_trace_stream_missing_content_type";
		const traceDir = mkdtempSync(join(tmpdir(), "codex-trace-"));
		process.env[CODEX_TRACE_DIR_ENV] = traceDir;
		try {
			const upstreamBody = sseBody([
				...eventLine("response.created", {
					response: { id: "resp_trace", model: "gpt-5.4" },
				}),
				...eventLine("response.completed", {
					response: {
						model: "gpt-5.4",
						usage: { input_tokens: 3, output_tokens: 1 },
					},
				}),
			]);
			const response = new Response(upstreamBody, {
				status: 200,
				headers: {
					"x-better-ccflare-request-id": requestId,
					"x-better-ccflare-request-stream": "true",
				},
			});

			const transformed = await provider.processResponse(response, null);
			await transformed.text();

			const responseRecord = readTraceRecords(traceDir).find(
				(r) => r.phase === "response",
			);
			expect(responseRecord?.request_id).toBe(requestId);
		} finally {
			delete process.env[CODEX_TRACE_DIR_ENV];
			rmSync(traceDir, { recursive: true, force: true });
		}
	});

	it("preserves request id in traces for missing-content-type SSE to JSON", async () => {
		const provider = new CodexProvider();
		const requestId = "req_trace_json_missing_content_type";
		const traceDir = mkdtempSync(join(tmpdir(), "codex-trace-"));
		process.env[CODEX_TRACE_DIR_ENV] = traceDir;
		try {
			const upstreamBody = sseBody([
				...eventLine("response.created", {
					response: { id: "resp_trace", model: "gpt-5.4" },
				}),
				...eventLine("response.completed", {
					response: {
						model: "gpt-5.4",
						usage: { input_tokens: 3, output_tokens: 1 },
					},
				}),
			]);
			const response = new Response(upstreamBody, {
				status: 200,
				headers: {
					"x-better-ccflare-request-id": requestId,
					"x-better-ccflare-request-stream": "false",
				},
			});

			const transformed = await provider.processResponse(response, null);
			await transformed.text();

			const responseRecord = readTraceRecords(traceDir).find(
				(r) => r.phase === "response",
			);
			expect(responseRecord?.request_id).toBe(requestId);
		} finally {
			delete process.env[CODEX_TRACE_DIR_ENV];
			rmSync(traceDir, { recursive: true, force: true });
		}
	});

	it("passes through successful missing-content-type unknown bodies", async () => {
		const provider = new CodexProvider();
		const response = new Response("ok", {
			status: 200,
			headers: {},
		});

		const transformed = await provider.processResponse(response, null);
		expect(transformed.headers.get("content-type")).toBeNull();
		expect(await transformed.text()).toBe("ok");
	});

	it("returns Anthropic JSON for non-streaming missing-content-type SSE bodies", async () => {
		const provider = new CodexProvider();
		const upstreamBody = sseBody([
			...eventLine("response.created", {
				response: { id: "resp_test", model: "gpt-5.4" },
			}),
			...eventLine("response.output_item.added", {
				item: { type: "message" },
				output_index: 0,
			}),
			...eventLine("response.content_part.added", {
				part: { type: "output_text" },
			}),
			...eventLine("response.output_text.delta", { delta: "hello" }),
			...eventLine("response.completed", {
				response: {
					model: "gpt-5.4",
					usage: { input_tokens: 2, output_tokens: 1 },
				},
			}),
		]);

		const response = new Response(upstreamBody, {
			status: 200,
			headers: { "x-better-ccflare-request-stream": "false" },
		});

		const transformed = await provider.processResponse(response, null);
		expect(transformed.headers.get("content-type")).toContain(
			"application/json",
		);
		const payload = await transformed.json();
		expect(payload.content).toEqual([{ type: "text", text: "hello" }]);
		expect(payload.usage).toEqual({
			input_tokens: 2,
			output_tokens: 1,
			cache_read_input_tokens: 0,
			cache_creation_input_tokens: 0,
		});
	});

	it("surfaces Codex SSE errors instead of fabricating an empty streaming success", async () => {
		const provider = new CodexProvider();
		const upstreamBody = sseBody([
			...eventLine("response.created", {
				response: { id: "resp_failed", model: "gpt-5.5" },
			}),
			...eventLine("response.failed", {
				response: {
					status: "failed",
					error: {
						type: "invalid_request_error",
						code: "context_length_exceeded",
						message: "Input is too large",
					},
				},
			}),
		]);

		const response = new Response(upstreamBody, {
			status: 200,
			headers: { "content-type": "text/event-stream" },
		});

		const transformed = await provider.processResponse(response, null);
		const transformedBody = await transformed.text();

		expect(transformedBody).toContain("event: error");
		expect(transformedBody).toContain("Input is too large");
		expect(transformedBody).toContain("context_length_exceeded");
		expect(transformedBody).not.toContain("event: message_delta");
		expect(transformedBody).not.toContain("event: message_stop");
	});

	it("closes an open content block before surfacing a streaming Codex error", async () => {
		const provider = new CodexProvider();
		const upstreamBody = sseBody([
			...eventLine("response.created", {
				response: { id: "resp_failed", model: "gpt-5.5" },
			}),
			...eventLine("response.output_item.added", {
				item: { type: "message" },
				output_index: 0,
			}),
			...eventLine("response.content_part.added", {
				part: { type: "output_text" },
			}),
			...eventLine("response.output_text.delta", { delta: "partial" }),
			...eventLine("response.failed", {
				response: {
					status: "failed",
					error: {
						type: "invalid_request_error",
						message: "Codex failed after partial output",
					},
				},
			}),
		]);

		const response = new Response(upstreamBody, {
			status: 200,
			headers: { "content-type": "text/event-stream" },
		});

		const transformed = await provider.processResponse(response, null);
		const transformedBody = await transformed.text();

		const stopPos = transformedBody.indexOf("event: content_block_stop");
		const errorPos = transformedBody.indexOf("event: error");
		expect(stopPos).toBeGreaterThan(-1);
		expect(errorPos).toBeGreaterThan(stopPos);
		expect(transformedBody).toContain("Codex failed after partial output");
	});

	it("surfaces Codex SSE errors as JSON errors for non-streaming clients", async () => {
		const provider = new CodexProvider();
		const upstreamBody = sseBody([
			...eventLine("response.created", {
				response: { id: "resp_failed", model: "gpt-5.5" },
			}),
			...eventLine("response.failed", {
				response: {
					status: "failed",
					error: {
						type: "invalid_request_error",
						message: "Codex failed",
					},
				},
			}),
		]);

		const response = new Response(upstreamBody, {
			status: 200,
			headers: {
				"content-type": "text/event-stream",
				"x-better-ccflare-request-stream": "false",
			},
		});

		const transformed = await provider.processResponse(response, null);
		const body = await transformed.json();

		expect(transformed.status).toBe(400);
		expect(body).toEqual({
			type: "error",
			error: {
				type: "invalid_request_error",
				message: "Codex failed",
			},
		});
	});

	it("maps non-streaming Codex context-window SSE errors to non-retryable bad requests", async () => {
		const provider = new CodexProvider();
		const upstreamBody = sseBody([
			...eventLine("response.created", {
				response: { id: "resp_failed", model: "gpt-5.5" },
			}),
			...eventLine("error", {
				type: "error",
				code: "context_length_exceeded",
				message: "Input is too large",
			}),
		]);

		const response = new Response(upstreamBody, {
			status: 200,
			headers: {
				"content-type": "text/event-stream",
				"x-better-ccflare-request-stream": "false",
			},
		});

		const transformed = await provider.processResponse(response, null);
		const body = await transformed.json();

		expect(transformed.status).toBe(400);
		expect(body).toEqual({
			type: "error",
			error: {
				type: "invalid_request_error",
				message: "Input is too large",
				code: "context_length_exceeded",
			},
		});
	});

	it("maps generic Codex error events to a valid Anthropic api_error type", async () => {
		const provider = new CodexProvider();
		const upstreamBody = sseBody([
			...eventLine("error", {
				type: "error",
				code: "some_other_code",
				message: "Generic Codex failure",
			}),
		]);

		const response = new Response(upstreamBody, {
			status: 200,
			headers: {
				"content-type": "text/event-stream",
				"x-better-ccflare-request-stream": "false",
			},
		});

		const transformed = await provider.processResponse(response, null);
		const body = await transformed.json();

		expect(transformed.status).toBe(502);
		expect(body.error.type).toBe("api_error");
		expect(body.error.code).toBe("some_other_code");
	});

	it("maps Codex rate-limited status to a non-streaming 429", async () => {
		const provider = new CodexProvider();
		const upstreamBody = sseBody([
			...eventLine("response.failed", {
				response: {
					status: "rate_limited",
					error: {
						type: "error",
						message: "Rate limited by Codex",
					},
				},
			}),
		]);

		const response = new Response(upstreamBody, {
			status: 200,
			headers: {
				"content-type": "text/event-stream",
				"x-better-ccflare-request-stream": "false",
			},
		});

		const transformed = await provider.processResponse(response, null);
		const body = await transformed.json();

		expect(transformed.status).toBe(429);
		expect(body.error.type).toBe("rate_limit_error");
		expect(body.error.status).toBe("rate_limited");
	});

	it("does not emit terminal events after response.failed when response.completed follows", async () => {
		const provider = new CodexProvider();
		const upstreamBody = sseBody([
			...eventLine("response.created", {
				response: { id: "resp_failed", model: "gpt-5.5" },
			}),
			...eventLine("response.failed", {
				response: {
					status: "failed",
					error: { type: "invalid_request_error", message: "Context exceeded" },
				},
			}),
			...eventLine("response.completed", {
				response: {
					model: "gpt-5.5",
					usage: { input_tokens: 5, output_tokens: 0 },
				},
			}),
		]);

		const response = new Response(upstreamBody, {
			status: 200,
			headers: { "content-type": "text/event-stream" },
		});

		const transformed = await provider.processResponse(response, null);
		const body = await transformed.text();

		expect(body).toContain("event: error");
		expect(body).not.toContain("event: message_delta");
		expect(body).not.toContain("event: message_stop");
	});

	it("passes through non-streaming error responses", async () => {
		const provider = new CodexProvider();
		const response = new Response('{"error":"bad_request"}', {
			status: 400,
			headers: { "content-type": "application/json" },
		});

		const processed = await provider.processResponse(response, null);

		expect(processed.status).toBe(400);
		expect(await processed.text()).toBe('{"error":"bad_request"}');
	});
});

describe("CodexProvider.transformRequestBody", () => {
	it("returns a synthetic Anthropic count_tokens response", async () => {
		const provider = new CodexProvider();
		const url = provider.buildUrl("/v1/messages/count_tokens", "");
		const request = new Request(url, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				model: "claude-3-7-sonnet",
				messages: [{ role: "user", content: "hello world" }],
			}),
		});

		const transformed = await provider.transformRequestBody(request, undefined);
		const body = await transformed.json();

		expect(transformed.headers.get("content-type")).toContain(
			"application/json",
		);
		expect(transformed.headers.get("x-better-ccflare-synthetic-response")).toBe(
			"true",
		);
		expect(transformed.headers.get("x-better-ccflare-synthetic-status")).toBe(
			"200",
		);
		expect(body.input_tokens).toBeNumber();
		expect(body.input_tokens).toBeGreaterThan(0);
		expect(body).not.toHaveProperty("input");
		expect(body).not.toHaveProperty("stream");
		expect(body).not.toHaveProperty("store");
	});

	it("estimates count_tokens from prompt material instead of the full JSON envelope", async () => {
		const provider = new CodexProvider();
		const url = provider.buildUrl("/v1/messages/count_tokens", "");
		const request = new Request(url, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				model: "claude-3-7-sonnet",
				messages: [{ role: "user", content: "hello" }],
			}),
		});

		const transformed = await provider.transformRequestBody(request, undefined);
		const body = await transformed.json();

		expect(body.input_tokens).toBeGreaterThan(0);
		expect(body.input_tokens).toBeLessThan(10);
	});

	it("returns a synthetic error for malformed count_tokens requests", async () => {
		const provider = new CodexProvider();
		const url = provider.buildUrl("/v1/messages/count_tokens", "");
		const request = new Request(url, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: "{not-json",
		});

		const transformed = await provider.transformRequestBody(request, undefined);
		const body = await transformed.json();

		expect(transformed.headers.get("x-better-ccflare-synthetic-response")).toBe(
			"true",
		);
		expect(transformed.headers.get("x-better-ccflare-synthetic-status")).toBe(
			"400",
		);
		expect(body).toEqual({
			type: "error",
			error: {
				type: "invalid_request_error",
				message: "Codex count_tokens requires a valid JSON request body.",
			},
		});
	});

	it("returns a synthetic error for non-JSON count_tokens requests", async () => {
		const provider = new CodexProvider();
		const url = provider.buildUrl("/v1/messages/count_tokens", "");
		const request = new Request(url, {
			method: "POST",
			headers: { "content-type": "text/plain" },
			body: "hello",
		});

		const transformed = await provider.transformRequestBody(request, undefined);
		const body = await transformed.json();

		expect(transformed.headers.get("x-better-ccflare-synthetic-response")).toBe(
			"true",
		);
		expect(transformed.headers.get("x-better-ccflare-synthetic-status")).toBe(
			"400",
		);
		expect(body.error.message).toBe(
			"Codex count_tokens requires an application/json request body.",
		);
	});

	it("maps sonnet-family models to the default Codex model", async () => {
		const provider = new CodexProvider();
		const request = new Request("https://example.com/v1/messages", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				model: "claude-3-7-sonnet",
				max_tokens: 10,
				messages: [{ role: "user", content: "hello" }],
			}),
		});

		const transformed = await provider.transformRequestBody(request, undefined);
		const body = await transformed.json();

		expect(body.model).toBe("gpt-5.3-codex");
	});

	it("uses account sonnet mapping for sonnet-family models", async () => {
		const provider = new CodexProvider();
		const account = {
			model_mappings: JSON.stringify({ sonnet: "gpt-5.3-codex" }),
		} as Parameters<typeof provider.transformRequestBody>[1];
		const request = new Request("https://example.com/v1/messages", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				model: "claude-3-7-sonnet",
				max_tokens: 10,
				messages: [{ role: "user", content: "hello" }],
			}),
		});

		const transformed = await provider.transformRequestBody(request, account);
		const body = await transformed.json();

		expect(body.model).toBe("gpt-5.3-codex");
	});

	it("uses first model when account mapping value is an ordered array", async () => {
		const provider = new CodexProvider();
		const account = {
			model_mappings: JSON.stringify({
				sonnet: ["gpt-5.3-codex", "gpt-5.4"],
			}),
		} as Parameters<typeof provider.transformRequestBody>[1];
		const request = new Request("https://example.com/v1/messages", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				model: "claude-3-7-sonnet",
				max_tokens: 10,
				messages: [{ role: "user", content: "hello" }],
			}),
		});

		const transformed = await provider.transformRequestBody(request, account);
		const body = await transformed.json();

		expect(body.model).toBe("gpt-5.3-codex");
	});

	it("uses default Codex mapping for families missing from account mappings", async () => {
		const provider = new CodexProvider();
		const account = {
			model_mappings: JSON.stringify({ sonnet: "gpt-5.3-codex" }),
		} as Parameters<typeof provider.transformRequestBody>[1];
		const request = new Request("https://example.com/v1/messages", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				model: "claude-3-haiku",
				max_tokens: 10,
				messages: [{ role: "user", content: "hello" }],
			}),
		});

		const transformed = await provider.transformRequestBody(request, account);
		const body = await transformed.json();

		expect(body.model).toBe("gpt-5.4-mini");
	});

	it("passes through unknown model names unchanged", async () => {
		const provider = new CodexProvider();
		const request = new Request("https://example.com/v1/messages", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				model: "gpt-5.4-mini",
				max_tokens: 10,
				messages: [{ role: "user", content: "hello" }],
			}),
		});

		const transformed = await provider.transformRequestBody(request, undefined);
		const body = await transformed.json();

		expect(body.model).toBe("gpt-5.4-mini");
	});

	it("forces StructuredOutput tool_choice when the Claude Code schema tool is present", async () => {
		const provider = new CodexProvider();
		const request = new Request("https://example.com/v1/messages", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				model: "claude-haiku-4-5-20251001",
				max_tokens: 10,
				messages: [{ role: "user", content: "return structured output" }],
				tools: [
					{
						name: "StructuredOutput",
						description: "Return the validated payload.",
						input_schema: {
							type: "object",
							additionalProperties: false,
							properties: { ok: { type: "boolean" } },
							required: ["ok"],
						},
					},
				],
			}),
		});

		const transformed = await provider.transformRequestBody(request, undefined);
		const body = await transformed.json();

		expect(body.tools.map((t: { name: string }) => t.name)).toContain(
			"StructuredOutput",
		);
		expect(body.tool_choice).toEqual({
			type: "function",
			name: "StructuredOutput",
		});
	});

	it("does not force tool_choice for ordinary tool-enabled requests", async () => {
		const provider = new CodexProvider();
		const request = new Request("https://example.com/v1/messages", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				model: "claude-haiku-4-5-20251001",
				max_tokens: 10,
				messages: [{ role: "user", content: "read a file" }],
				tools: [
					{
						name: "Read",
						description: "Read a file.",
						input_schema: {
							type: "object",
							properties: { file_path: { type: "string" } },
							required: ["file_path"],
						},
					},
				],
			}),
		});

		const transformed = await provider.transformRequestBody(request, undefined);
		const body = await transformed.json();

		expect(body.tool_choice).toBeUndefined();
	});

	it.each([
		[{ type: "auto" }, "auto"],
		[{ type: "any" }, "required"],
		[{ type: "none" }, "none"],
		[
			{ type: "tool", name: "Read" },
			{ type: "function", name: "Read" },
		],
	] as const)("maps Anthropic tool_choice %j to Codex", async (toolChoice, expected) => {
		const provider = new CodexProvider();
		const request = new Request("https://example.com/v1/messages", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				model: "claude-opus-4-8",
				max_tokens: 10,
				messages: [{ role: "user", content: "read a file" }],
				tools: [
					{
						name: "Read",
						description: "Read a file.",
						input_schema: { type: "object" },
					},
				],
				tool_choice: toolChoice,
			}),
		});

		const transformed = await provider.transformRequestBody(request);
		const body = await transformed.json();
		expect(body.tool_choice).toEqual(expected);
	});

	it("preserves explicit tool_choice precedence over StructuredOutput fallback", async () => {
		const provider = new CodexProvider();
		const request = new Request("https://example.com/v1/messages", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				model: "claude-opus-4-8",
				max_tokens: 10,
				messages: [{ role: "user", content: "return text" }],
				tools: [
					{
						name: "StructuredOutput",
						description: "Return structured output.",
						input_schema: { type: "object" },
					},
				],
				tool_choice: { type: "none" },
			}),
		});

		const transformed = await provider.transformRequestBody(request);
		const body = await transformed.json();
		expect(body.tool_choice).toBe("none");
	});

	it("rejects a named tool_choice that is absent from tools", async () => {
		const provider = new CodexProvider();
		const request = new Request("https://example.com/v1/messages", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				model: "claude-opus-4-8",
				max_tokens: 10,
				messages: [{ role: "user", content: "search" }],
				tools: [
					{
						name: "Read",
						description: "Read a file.",
						input_schema: { type: "object" },
					},
				],
				tool_choice: { type: "tool", name: "WebSearch" },
			}),
		});

		await expect(provider.transformRequestBody(request)).rejects.toThrow(
			"tool_choice references unknown tool: WebSearch",
		);
	});

	it("omits prompt_cache_key by default", async () => {
		const provider = new CodexProvider();
		const request = new Request("https://example.com/v1/messages", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				model: "claude-opus-4-8",
				max_tokens: 10,
				metadata: {
					user_id: JSON.stringify({
						session_id: "11111111-1111-4111-8111-111111111111",
					}),
				},
				messages: [{ role: "user", content: "hello" }],
			}),
		});

		const transformed = await provider.transformRequestBody(request);
		const body = await transformed.json();
		expect(body.prompt_cache_key).toBeUndefined();
	});

	it("derives a deterministic prompt_cache_key from Claude Code session metadata when enabled", async () => {
		process.env[CODEX_PROMPT_CACHE_KEY_ENV] = "1";
		const transform = async (sessionId: string) => {
			const request = new Request("https://example.com/v1/messages", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					model: "claude-opus-4-8",
					max_tokens: 10,
					metadata: { user_id: JSON.stringify({ session_id: sessionId }) },
					messages: [{ role: "user", content: "hello" }],
				}),
			});
			return new CodexProvider()
				.transformRequestBody(request)
				.then((r) => r.json());
		};

		const first = await transform("11111111-1111-4111-8111-111111111111");
		const repeated = await transform("11111111-1111-4111-8111-111111111111");
		const different = await transform("22222222-2222-4222-8222-222222222222");

		expect(first.prompt_cache_key).toMatch(/^ccflare-session-[0-9a-f]{48}$/);
		expect(repeated.prompt_cache_key).toBe(first.prompt_cache_key);
		expect(different.prompt_cache_key).not.toBe(first.prompt_cache_key);
		expect(first.prompt_cache_key).not.toContain("11111111");
	});

	it("omits prompt_cache_key for malformed session metadata", async () => {
		process.env[CODEX_PROMPT_CACHE_KEY_ENV] = "1";
		const provider = new CodexProvider();
		const request = new Request("https://example.com/v1/messages", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				model: "claude-opus-4-8",
				max_tokens: 10,
				metadata: { user_id: "not-json" },
				messages: [{ role: "user", content: "hello" }],
			}),
		});

		const transformed = await provider.transformRequestBody(request);
		const body = await transformed.json();
		expect(body.prompt_cache_key).toBeUndefined();
	});
});

describe("parseCodexUsageHeaders", () => {
	it("normalizes primary and secondary codex quota headers", () => {
		const headers = new Headers({
			"x-codex-primary-used-percent": "11",
			"x-codex-primary-window-minutes": "10080",
			"x-codex-primary-reset-at": "1775000000",
			"x-codex-secondary-used-percent": "4",
			"x-codex-secondary-window-minutes": "300",
			"x-codex-secondary-reset-at": "1774600000",
		});

		const usage = parseCodexUsageHeaders(headers);

		expect(usage).not.toBeNull();
		expect(usage?.five_hour).toEqual({
			utilization: 4,
			resets_at: new Date(1774600000 * 1000).toISOString(),
		});
		expect(usage?.seven_day).toEqual({
			utilization: 11,
			resets_at: new Date(1775000000 * 1000).toISOString(),
		});
	});

	it("treats zero secondary window as an empty placeholder", () => {
		const headers = new Headers({
			"x-codex-primary-used-percent": "11",
			"x-codex-primary-window-minutes": "10080",
			"x-codex-primary-reset-at": "1775000000",
			"x-codex-secondary-used-percent": "0",
			"x-codex-secondary-window-minutes": "0",
			"x-codex-secondary-reset-at": "1774600000",
		});

		const usage = parseCodexUsageHeaders(headers);

		expect(usage).toEqual({
			five_hour: {
				utilization: 0,
				resets_at: new Date(1774600000 * 1000).toISOString(),
			},
			seven_day: {
				utilization: 11,
				resets_at: new Date(1775000000 * 1000).toISOString(),
			},
		});
	});

	it("returns null when no Codex usage headers are present", () => {
		expect(parseCodexUsageHeaders(new Headers())).toBeNull();
	});

	it("drops invalid reset timestamps instead of throwing", () => {
		const headers = new Headers({
			"x-codex-primary-used-percent": "12",
			"x-codex-primary-window-minutes": "300",
			"x-codex-primary-reset-at": "1e309",
		});

		expect(parseCodexUsageHeaders(headers)).toEqual({
			five_hour: { utilization: 12, resets_at: null },
			seven_day: { utilization: 0, resets_at: null },
		});
	});
});

describe("parseCodexUsageHeaders reset-after handling", () => {
	it("uses the supplied base time for relative reset headers", () => {
		const baseTimeMs = Date.UTC(2026, 2, 27, 16, 0, 0);
		const headers = new Headers({
			"x-codex-primary-used-percent": "12",
			"x-codex-primary-window-minutes": "300",
			"x-codex-primary-reset-after-seconds": "600",
		});

		const usage = parseCodexUsageHeaders(headers, {
			baseTimeMs,
			allowRelativeResetAfter: true,
		});

		expect(usage?.five_hour?.resets_at).toBe(
			new Date(baseTimeMs + 600_000).toISOString(),
		);
	});
});

describe("fetchCodexUsageOnDemand", () => {
	let originalFetch: typeof fetch;
	let recorded: { url: string; init: RequestInit } | null;

	beforeEach(() => {
		originalFetch = globalThis.fetch;
		recorded = null;
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	const makeMockFetch = (response: Response) => {
		return async (input: RequestInfo | URL, init?: RequestInit) => {
			recorded = { url: String(input), init: init ?? {} };
			return response;
		};
	};

	it("sends a minimal codex request and parses usage headers", async () => {
		globalThis.fetch = makeMockFetch(
			new Response("event: ignored\n\n", {
				status: 200,
				headers: {
					"x-codex-primary-used-percent": "11",
					"x-codex-primary-window-minutes": "10080",
					"x-codex-primary-reset-at": "1775000000",
					"x-codex-secondary-used-percent": "4",
					"x-codex-secondary-window-minutes": "300",
					"x-codex-secondary-reset-at": "1774600000",
				},
			}),
		) as unknown as typeof fetch;

		const result = await fetchCodexUsageOnDemand(
			"test-token",
			"https://example.test/codex/responses",
		);

		expect(recorded).not.toBeNull();
		expect(recorded?.url).toBe("https://example.test/codex/responses");
		expect(recorded?.init.method).toBe("POST");

		const body = JSON.parse(recorded?.init.body as string);
		expect(body.stream).toBe(true);
		expect(body.store).toBe(false);
		expect(body.max_output_tokens).toBe(1);
		expect(body.reasoning?.effort).toBe("minimal");
		expect(body.input).toHaveLength(1);
		expect(body.input[0].role).toBe("user");

		const headersInit = recorded?.init.headers as Record<string, string>;
		const headers = new Headers(headersInit);
		expect(headers.get("Authorization")).toBe("Bearer test-token");
		expect(headers.get("Version")).toBe("0.144.1");
		expect(headers.get("Openai-Beta")).toBe("responses=experimental");
		expect(headers.get("User-Agent")).toContain("codex-cli/0.144.1");
		expect(headers.get("originator")).toBe("codex_cli_rs");
		expect(headers.get("Content-Type")).toBe("application/json");

		expect(result.data?.five_hour).toEqual({
			utilization: 4,
			resets_at: new Date(1774600000 * 1000).toISOString(),
		});
		expect(result.data?.seven_day).toEqual({
			utilization: 11,
			resets_at: new Date(1775000000 * 1000).toISOString(),
		});
		expect(result.response.status).toBe(200);
		expect(result.response.headers.get("x-codex-primary-reset-at")).toBe(
			"1775000000",
		);
	});

	it("returns null data when no Codex usage headers are present", async () => {
		globalThis.fetch = makeMockFetch(
			new Response("event: ignored\n\n", { status: 200 }),
		) as unknown as typeof fetch;

		const result = await fetchCodexUsageOnDemand(
			"test-token",
			"https://example.test/codex/responses",
		);

		expect(result.data).toBeNull();
		expect(result.response.status).toBe(200);
	});

	it("preserves headers and status on a 429 so callers can persist rate_limit_reset", async () => {
		globalThis.fetch = makeMockFetch(
			new Response("rate limited", {
				status: 429,
				headers: {
					"x-codex-primary-used-percent": "100",
					"x-codex-primary-window-minutes": "300",
					"x-codex-primary-reset-at": "1775000000",
					"x-codex-secondary-used-percent": "82",
					"x-codex-secondary-window-minutes": "10080",
					"x-codex-secondary-reset-at": "1774700000",
				},
			}),
		) as unknown as typeof fetch;

		const result = await fetchCodexUsageOnDemand(
			"test-token",
			"https://example.test/codex/responses",
		);

		expect(result.response.status).toBe(429);
		expect(result.data?.five_hour.utilization).toBe(100);
		expect(result.data?.five_hour.resets_at).toBe(
			new Date(1775000000 * 1000).toISOString(),
		);
		expect(result.response.headers.get("x-codex-primary-reset-at")).toBe(
			"1775000000",
		);
	});

	it("rejects an empty access token before issuing a request", async () => {
		let called = false;
		globalThis.fetch = (async () => {
			called = true;
			return new Response(null, { status: 200 });
		}) as unknown as typeof fetch;

		await expect(fetchCodexUsageOnDemand("")).rejects.toThrow(
			/non-empty access token/,
		);
		expect(called).toBe(false);
	});
});
