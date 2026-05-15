import { describe, expect, it } from "bun:test";
import type { Account } from "@better-ccflare/types";
import { OpenAICompatibleProvider } from "../provider";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeProvider() {
	return new OpenAICompatibleProvider();
}

function makeAccount(overrides = {}): Account {
	return {
		id: "acc-1",
		name: "test",
		provider: "openai-compatible",
		api_key: null,
		refresh_token: "key",
		access_token: null,
		expires_at: null,
		request_count: 0,
		total_requests: 0,
		last_used: null,
		created_at: Date.now(),
		rate_limited_until: null,
		session_start: null,
		session_request_count: 0,
		paused: false,
		rate_limit_reset: null,
		rate_limit_status: null,
		rate_limit_remaining: null,
		priority: 0,
		auto_fallback_enabled: false,
		auto_refresh_enabled: false,
		custom_endpoint: null,
		model_mappings: null,
		cross_region_mode: null,
		model_fallbacks: null,
		...overrides,
	};
}

function openaiJsonResponse(
	body: object,
	status = 200,
	extraHeaders: Record<string, string> = {},
) {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json", ...extraHeaders },
	});
}

/** Build a fake OpenAI SSE stream */
function makeOpenAIStream(chunks: string[]): Response {
	const encoder = new TextEncoder();
	const lines = chunks.map((c) => `data: ${c}\n\n`).join("");
	const body = new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(encoder.encode(lines));
			controller.close();
		},
	});
	return new Response(body, {
		headers: { "content-type": "text/event-stream" },
	});
}

async function readStream(stream: ReadableStream<Uint8Array>): Promise<string> {
	const reader = stream.getReader();
	const chunks: Uint8Array[] = [];
	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		chunks.push(value);
	}
	const total = new Uint8Array(chunks.reduce((a, c) => a + c.byteLength, 0));
	let offset = 0;
	for (const c of chunks) {
		total.set(c, offset);
		offset += c.byteLength;
	}
	return new TextDecoder().decode(total);
}

function parseSSEEvents(raw: string) {
	return raw
		.split("\n\n")
		.filter((b) => b.trim())
		.map((block) => {
			const ev: { event?: string; data?: string } = {};
			for (const line of block.split("\n")) {
				if (line.startsWith("event: ")) ev.event = line.slice(7).trim();
				if (line.startsWith("data: ")) ev.data = line.slice(6).trim();
			}
			return ev;
		});
}

// ---------------------------------------------------------------------------
// Branch 1: JSON responses
// ---------------------------------------------------------------------------

describe("processResponse – JSON (application/json)", () => {
	it("simple text response converts to Anthropic message shape", async () => {
		const provider = makeProvider();
		const account = makeAccount();

		const upstream = openaiJsonResponse({
			id: "chatcmpl-abc",
			object: "chat.completion",
			model: "gpt-4o",
			choices: [
				{
					message: { role: "assistant", content: "Hello" },
					finish_reason: "stop",
				},
			],
			usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 },
		});

		const result = await provider.processResponse(upstream, account);
		const body = await result.json();

		expect(body.type).toBe("message");
		expect(Array.isArray(body.content)).toBe(true);
		expect(body.content[0]).toMatchObject({ type: "text", text: "Hello" });
	});

	it("tool call response converts to Anthropic tool_use shape", async () => {
		const provider = makeProvider();
		const account = makeAccount();

		const upstream = openaiJsonResponse({
			id: "chatcmpl-tc",
			object: "chat.completion",
			model: "gpt-4o",
			choices: [
				{
					message: {
						role: "assistant",
						content: null,
						tool_calls: [
							{
								id: "c1",
								type: "function",
								function: { name: "search", arguments: '{"q":"bun"}' },
							},
						],
					},
					finish_reason: "tool_calls",
				},
			],
			usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
		});

		const result = await provider.processResponse(upstream, account);
		const body = await result.json();

		expect(body.type).toBe("message");
		const toolBlock = body.content.find(
			(b: { type: string }) => b.type === "tool_use",
		);
		expect(toolBlock).toBeDefined();
		expect(toolBlock).toMatchObject({
			type: "tool_use",
			id: "c1",
			name: "search",
			input: { q: "bun" },
		});
	});

	it("finish_reason 'stop' maps to stop_reason 'end_turn'", async () => {
		const provider = makeProvider();
		const upstream = openaiJsonResponse({
			id: "chatcmpl-1",
			choices: [
				{
					message: { role: "assistant", content: "hi" },
					finish_reason: "stop",
				},
			],
			usage: { prompt_tokens: 1, completion_tokens: 1 },
		});
		const result = await provider.processResponse(upstream, makeAccount());
		const body = await result.json();
		expect(body.stop_reason).toBe("end_turn");
	});

	it("finish_reason 'tool_calls' maps to stop_reason 'tool_use'", async () => {
		const provider = makeProvider();
		const upstream = openaiJsonResponse({
			id: "chatcmpl-2",
			choices: [
				{
					message: {
						role: "assistant",
						content: null,
						tool_calls: [
							{
								id: "tc1",
								type: "function",
								function: { name: "fn", arguments: "{}" },
							},
						],
					},
					finish_reason: "tool_calls",
				},
			],
			usage: { prompt_tokens: 1, completion_tokens: 1 },
		});
		const result = await provider.processResponse(upstream, makeAccount());
		const body = await result.json();
		expect(body.stop_reason).toBe("tool_use");
	});

	it("finish_reason 'length' maps to stop_reason 'max_tokens'", async () => {
		const provider = makeProvider();
		const upstream = openaiJsonResponse({
			id: "chatcmpl-3",
			choices: [
				{
					message: { role: "assistant", content: "partial" },
					finish_reason: "length",
				},
			],
			usage: { prompt_tokens: 1, completion_tokens: 1 },
		});
		const result = await provider.processResponse(upstream, makeAccount());
		const body = await result.json();
		expect(body.stop_reason).toBe("max_tokens");
	});

	it("error response passthrough preserves Anthropic error shape and status", async () => {
		const provider = makeProvider();
		const upstream = openaiJsonResponse(
			{
				error: {
					type: "rate_limit_error",
					message: "Too many requests",
					code: "rate_limit_exceeded",
				},
			},
			429,
		);

		const result = await provider.processResponse(upstream, makeAccount());
		expect(result.status).toBe(429);
		const body = await result.json();
		expect(body.type).toBe("error");
		expect(body.error).toMatchObject({
			type: "rate_limit_error",
			message: "Too many requests",
		});
	});

	it("provider-specific headers are stripped from JSON response", async () => {
		const provider = makeProvider();
		const upstream = openaiJsonResponse(
			{
				id: "chatcmpl-h",
				choices: [
					{
						message: { role: "assistant", content: "hi" },
						finish_reason: "stop",
					},
				],
				usage: { prompt_tokens: 1, completion_tokens: 1 },
			},
			200,
			{
				"x-ratelimit-limit-requests": "1000",
				"openai-organization": "org-abc",
				"access-control-expose-headers": "X-Request-ID",
			},
		);

		const result = await provider.processResponse(upstream, makeAccount());
		expect(result.headers.get("x-ratelimit-limit-requests")).toBeNull();
		expect(result.headers.get("openai-organization")).toBeNull();
		expect(result.headers.get("access-control-expose-headers")).toBeNull();
	});

	it("usage tokens are correctly mapped from OpenAI to Anthropic format", async () => {
		const provider = makeProvider();
		const upstream = openaiJsonResponse({
			id: "chatcmpl-u",
			choices: [
				{
					message: { role: "assistant", content: "hi" },
					finish_reason: "stop",
				},
			],
			usage: { prompt_tokens: 15, completion_tokens: 7, total_tokens: 22 },
		});

		const result = await provider.processResponse(upstream, makeAccount());
		const body = await result.json();
		expect(body.usage).toMatchObject({ input_tokens: 15, output_tokens: 7 });
	});

	it("malformed JSON upstream does not throw — returns original response", async () => {
		const provider = makeProvider();
		// Build a Response with content-type application/json but invalid JSON body
		const upstream = new Response("not-valid-json{{{", {
			status: 200,
			headers: { "content-type": "application/json" },
		});

		// Should not throw
		const result = await provider.processResponse(upstream, makeAccount());
		expect(result).toBeInstanceOf(Response);
	});
});

// ---------------------------------------------------------------------------
// Branch 2: Streaming responses
// ---------------------------------------------------------------------------

describe("processResponse – SSE (text/event-stream)", () => {
	it("returns a Response with a non-null body stream", async () => {
		const provider = makeProvider();
		const upstream = makeOpenAIStream([
			JSON.stringify({
				id: "chatcmpl-s1",
				model: "gpt-4o",
				choices: [{ delta: { content: "Hi" }, finish_reason: null }],
			}),
			"[DONE]",
		]);

		const result = await provider.processResponse(upstream, makeAccount());
		expect(result).toBeInstanceOf(Response);
		expect(result.body).not.toBeNull();
	});

	it("full stream round-trip: text content — emits message_start and content_block_delta events", async () => {
		const provider = makeProvider();
		const upstream = makeOpenAIStream([
			JSON.stringify({
				id: "chatcmpl-s2",
				model: "gpt-4o",
				choices: [{ delta: { content: "Hello world" }, finish_reason: null }],
			}),
			"[DONE]",
		]);

		const result = await provider.processResponse(upstream, makeAccount());
		const raw = await readStream(result.body!);
		const events = parseSSEEvents(raw);

		const messageStart = events.find((e) => e.event === "message_start");
		expect(messageStart).toBeDefined();
		const msgData = JSON.parse(messageStart!.data);
		expect(msgData.type).toBe("message_start");

		const textDelta = events.find(
			(e) =>
				e.event === "content_block_delta" &&
				e.data &&
				JSON.parse(e.data).delta?.type === "text_delta",
		);
		expect(textDelta).toBeDefined();
		const deltaData = JSON.parse(textDelta!.data);
		expect(deltaData.delta.text).toBe("Hello world");
	});

	it("full stream round-trip: tool call — emits content_block_start with tool_use and content_block_delta with input_json_delta", async () => {
		const provider = makeProvider();

		// First chunk: tool call header (id + name)
		const chunk1 = JSON.stringify({
			id: "chatcmpl-tc",
			model: "gpt-4o",
			choices: [
				{
					delta: {
						tool_calls: [
							{
								index: 0,
								id: "call_abc",
								type: "function",
								function: { name: "search", arguments: "" },
							},
						],
					},
					finish_reason: null,
				},
			],
		});

		// Second chunk: arguments
		const chunk2 = JSON.stringify({
			id: "chatcmpl-tc",
			model: "gpt-4o",
			choices: [
				{
					delta: {
						tool_calls: [
							{
								index: 0,
								function: { arguments: '{"q":"bun"}' },
							},
						],
					},
					finish_reason: null,
				},
			],
		});

		const upstream = makeOpenAIStream([chunk1, chunk2, "[DONE]"]);
		const result = await provider.processResponse(upstream, makeAccount());
		const raw = await readStream(result.body!);
		const events = parseSSEEvents(raw);

		// Should have a content_block_start with type:tool_use
		const blockStart = events.find(
			(e) =>
				e.event === "content_block_start" &&
				e.data &&
				JSON.parse(e.data).content_block?.type === "tool_use",
		);
		expect(blockStart).toBeDefined();
		const blockData = JSON.parse(blockStart!.data);
		expect(blockData.content_block.name).toBe("search");

		// Should have a content_block_delta with input_json_delta
		const jsonDelta = events.find(
			(e) =>
				e.event === "content_block_delta" &&
				e.data &&
				JSON.parse(e.data).delta?.type === "input_json_delta",
		);
		expect(jsonDelta).toBeDefined();
		const jsonDeltaData = JSON.parse(jsonDelta!.data);
		expect(jsonDeltaData.delta.partial_json).toBe('{"q":"bun"}');
	});
});

// ---------------------------------------------------------------------------
// Branch 3: Other content types (fallback path)
// ---------------------------------------------------------------------------

describe("processResponse – other content types (fallback)", () => {
	it("text/plain response preserves body, status, and strips provider headers", async () => {
		const provider = makeProvider();
		const upstream = new Response("plain body text", {
			status: 200,
			headers: {
				"content-type": "text/plain",
				"x-ratelimit-limit-requests": "500",
				"openai-organization": "org-xyz",
			},
		});

		const result = await provider.processResponse(upstream, makeAccount());
		expect(result.status).toBe(200);

		const text = await result.text();
		expect(text).toBe("plain body text");

		expect(result.headers.get("x-ratelimit-limit-requests")).toBeNull();
		expect(result.headers.get("openai-organization")).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// Branch 4: extractUsageInfo
// ---------------------------------------------------------------------------

describe("extractUsageInfo", () => {
	it("calculates cost correctly for known model gpt-4o", async () => {
		const provider = makeProvider();
		const response = openaiJsonResponse({
			id: "chatcmpl-cost",
			model: "gpt-4o",
			choices: [
				{
					message: { role: "assistant", content: "hi" },
					finish_reason: "stop",
				},
			],
			usage: {
				prompt_tokens: 1000,
				completion_tokens: 500,
				total_tokens: 1500,
			},
		});

		const info = await provider.extractUsageInfo(response);
		expect(info).not.toBeNull();
		expect(info?.costUsd).toBeGreaterThan(0);
		// (1000/1000 * 0.005) + (500/1000 * 0.015) = 0.005 + 0.0075 = 0.0125
		expect(info?.costUsd).toBeCloseTo(0.0125, 6);
	});

	it("returns non-zero cost for unknown model using default pricing", async () => {
		const provider = makeProvider();
		const response = openaiJsonResponse({
			id: "chatcmpl-unk",
			model: "some-unknown-model",
			choices: [
				{
					message: { role: "assistant", content: "hi" },
					finish_reason: "stop",
				},
			],
			usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
		});

		const info = await provider.extractUsageInfo(response);
		expect(info).not.toBeNull();
		// Default pricing: input 0.001/1k, output 0.002/1k → (100/1000)*0.001 + (50/1000)*0.002 = 0.0001 + 0.0001 = 0.0002
		expect(info?.costUsd).toBeGreaterThan(0);
	});

	it("returns null for streaming (SSE) responses", async () => {
		const provider = makeProvider();
		const upstream = makeOpenAIStream([
			JSON.stringify({
				id: "chatcmpl-sse",
				model: "gpt-4o",
				choices: [{ delta: { content: "hi" }, finish_reason: null }],
			}),
			"[DONE]",
		]);

		const info = await provider.extractUsageInfo(upstream);
		expect(info).toBeNull();
	});
});
