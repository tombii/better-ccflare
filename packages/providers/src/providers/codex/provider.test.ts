import { describe, expect, it } from "bun:test";
import { CodexProvider } from "./provider";

const sseBody = (lines: string[]) => `${lines.join("\n")}\n`;
const eventLine = (name: string, data: unknown) => [
	`event: ${name}`,
	`data: ${typeof data === "string" ? data : JSON.stringify(data)}`,
	"",
];

describe("CodexProvider request conversion", () => {
	it("handles count_tokens path", () => {
		const provider = new CodexProvider();
		expect(provider.canHandle("/v1/messages")).toBeTrue();
		expect(provider.canHandle("/v1/messages/count_tokens")).toBeTrue();
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

		const account = {
			name: "test",
			model_mappings: JSON.stringify({
				sonnet: "gpt-5.4-mini",
			}),
		} as Parameters<CodexProvider["transformRequestBody"]>[1];

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
		expect(messageDeltaLine).toContain(
			'"delta":{"stop_reason":"end_turn","stop_sequence":null,"usage":{',
		);
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
		expect(payload.usage).toEqual({
			input_tokens: 7,
			output_tokens: 2,
			cache_read_input_tokens: 0,
			cache_creation_input_tokens: 0,
		});
	});

	it("message_start from response.created includes normalized top-level and nested usage", async () => {
		const provider = new CodexProvider();
		const upstreamBody = sseBody([
			...eventLine("response.created", {
				response: { id: "resp_test", model: "gpt-5.4" },
			}),
			...eventLine("response.completed", {
				response: {
					model: "gpt-5.4",
					usage: { input_tokens: 2, output_tokens: 1 },
				},
			}),
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

		expect(messageStartLine).not.toBeUndefined();
		const payload = JSON.parse(
			(messageStartLine as string).slice("data: ".length),
		);
		expect(payload.usage).toEqual({
			input_tokens: 0,
			output_tokens: 0,
			cache_read_input_tokens: 0,
			cache_creation_input_tokens: 0,
		});
		expect(payload.message.usage).toEqual({
			input_tokens: 0,
			output_tokens: 0,
			cache_read_input_tokens: 0,
			cache_creation_input_tokens: 0,
		});
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
		expect(messageDeltaLine).not.toContain('"context_window"');
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
});
