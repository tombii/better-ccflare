import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { fetchCodexUsageOnDemand } from "./on-demand-fetch";
import { CodexProvider } from "./provider";
import { parseCodexUsageHeaders } from "./usage";

const sseBody = (lines: string[]) => `${lines.join("\n")}\n`;
const eventLine = (name: string, data: unknown) => [
	`event: ${name}`,
	`data: ${typeof data === "string" ? data : JSON.stringify(data)}`,
	"",
];

describe("CodexProvider request conversion", () => {
	it("handles only /v1/messages path", () => {
		const provider = new CodexProvider();
		expect(provider.canHandle("/v1/messages")).toBeTrue();
		expect(provider.canHandle("/v1/messages/count_tokens")).toBeFalse();
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
		expect(headers.get("Openai-Beta")).toBe("responses=experimental");
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
