import { describe, expect, it } from "bun:test";
import { sanitizeHeaders, transformStreamingResponse } from "../stream";

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Collect all bytes from a ReadableStream into a string.
 * Accepts a possibly-null body (as typed by the DOM lib on `Response.body`)
 * and throws a clear error if the stream under test didn't produce one.
 */
async function readStream(
	stream: ReadableStream<Uint8Array> | null,
): Promise<string> {
	if (!stream) {
		throw new Error("expected response body, got null");
	}
	const reader = stream.getReader();
	const chunks: Uint8Array[] = [];
	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		chunks.push(value);
	}
	const totalLength = chunks.reduce((acc, c) => acc + c.byteLength, 0);
	const combined = new Uint8Array(totalLength);
	let offset = 0;
	for (const chunk of chunks) {
		combined.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return new TextDecoder().decode(combined);
}

/**
 * Build a fake OpenAI SSE stream from an array of raw data payloads.
 * Each payload is wrapped in `data: <payload>\n\n`. The last element
 * of `chunks` can be "[DONE]" to send the stream terminator.
 */
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

function parseSSEEvents(raw: string): Array<{ event?: string; data?: string }> {
	const events: Array<{ event?: string; data?: string }> = [];
	const blocks = raw.split("\n\n").filter((b) => b.trim());
	for (const block of blocks) {
		const lines = block.split("\n");
		const ev: { event?: string; data?: string } = {};
		for (const line of lines) {
			if (line.startsWith("event: ")) ev.event = line.slice(7).trim();
			if (line.startsWith("data: ")) ev.data = line.slice(6).trim();
		}
		events.push(ev);
	}
	return events;
}

/**
 * Parse the JSON `data` payload of a parsed SSE event. Throws a clear error
 * if the event has no data field, instead of relying on a non-null assertion
 * at each of the ~40 call sites in this file. Return type mirrors
 * `JSON.parse`'s own (implicit `any`) signature since call sites assert on
 * arbitrary, ad-hoc shapes of the decoded Anthropic SSE payload.
 */
// biome-ignore lint/suspicious/noExplicitAny: mirrors JSON.parse's own return type; call sites assert on ad-hoc payload shapes
function parseEventData(event: { event?: string; data?: string }): any {
	if (event.data === undefined) {
		throw new Error(
			`expected SSE event to have a data field (event: ${event.event ?? "<none>"})`,
		);
	}
	return JSON.parse(event.data);
}

// ── sanitizeHeaders ──────────────────────────────────────────────────────────

describe("sanitizeHeaders", () => {
	it("removes x-ratelimit-* headers", () => {
		const h = new Headers({
			"x-ratelimit-limit-requests": "100",
			"content-type": "text/event-stream",
		});
		const result = sanitizeHeaders(h);
		expect(result.get("x-ratelimit-limit-requests")).toBeNull();
		expect(result.get("content-type")).toBe("text/event-stream");
	});

	it("removes openai-* headers", () => {
		const h = new Headers({
			"openai-organization": "org-123",
			"content-type": "application/json",
		});
		const result = sanitizeHeaders(h);
		expect(result.get("openai-organization")).toBeNull();
	});

	it("removes access-control-expose-headers", () => {
		const h = new Headers({
			"access-control-expose-headers": "x-ratelimit-limit-requests",
			"content-type": "application/json",
		});
		const result = sanitizeHeaders(h);
		expect(result.get("access-control-expose-headers")).toBeNull();
	});

	it("preserves non-provider headers", () => {
		const h = new Headers({
			"content-type": "text/event-stream",
			"transfer-encoding": "chunked",
		});
		const result = sanitizeHeaders(h);
		expect(result.get("transfer-encoding")).toBe("chunked");
	});

	it("defaults content-type to application/json when absent", () => {
		const result = sanitizeHeaders(new Headers());
		expect(result.get("content-type")).toBe("application/json");
	});
});

// ── transformStreamingResponse — passthrough when no body ────────────────────

describe("transformStreamingResponse — no body", () => {
	it("returns the response as-is when body is null", () => {
		const response = new Response(null, { status: 200 });
		const result = transformStreamingResponse(response);
		expect(result).toBe(response);
	});
});

// ── transformStreamingResponse — text stream ──────────────────────────────────

describe("transformStreamingResponse — text responses", () => {
	it("emits message_start + ping on the first chunk", async () => {
		const upstream = makeOpenAIStream([
			JSON.stringify({
				id: "c1",
				model: "gpt-4",
				choices: [{ index: 0, delta: { content: "Hi" }, finish_reason: null }],
			}),
			"[DONE]",
		]);
		const transformed = transformStreamingResponse(upstream);
		const raw = await readStream(transformed.body);
		const events = parseSSEEvents(raw);
		const types = events.map((e) => e.event);
		expect(types).toContain("message_start");
		expect(types).toContain("ping");
	});

	it("emits content_block_start before first text delta", async () => {
		const upstream = makeOpenAIStream([
			JSON.stringify({
				id: "c1",
				model: "gpt-4",
				choices: [
					{ index: 0, delta: { content: "Hello" }, finish_reason: null },
				],
			}),
			"[DONE]",
		]);
		const transformed = transformStreamingResponse(upstream);
		const raw = await readStream(transformed.body);
		const events = parseSSEEvents(raw);
		const types = events.map((e) => e.event);
		expect(types).toContain("content_block_start");
	});

	it("emits content_block_delta with text_delta for each text chunk", async () => {
		const upstream = makeOpenAIStream([
			JSON.stringify({
				id: "c1",
				model: "gpt-4",
				choices: [
					{ index: 0, delta: { content: "Hello" }, finish_reason: null },
				],
			}),
			JSON.stringify({
				id: "c1",
				model: "gpt-4",
				choices: [
					{ index: 0, delta: { content: " world" }, finish_reason: null },
				],
			}),
			"[DONE]",
		]);
		const transformed = transformStreamingResponse(upstream);
		const raw = await readStream(transformed.body);
		const events = parseSSEEvents(raw);
		const deltas = events.filter((e) => e.event === "content_block_delta");
		expect(deltas.length).toBeGreaterThanOrEqual(2);
		const texts = deltas.map((e) => parseEventData(e).delta.text);
		expect(texts).toContain("Hello");
		expect(texts).toContain(" world");
	});

	it("treats an empty tool_calls array as no tool call", async () => {
		// CodeBuddy includes `"tool_calls": []` on every delta. An empty array is
		// truthy, so the tool-call branch must not swallow the text content.
		const upstream = makeOpenAIStream([
			JSON.stringify({
				id: "c1",
				model: "deepseek-v4.1-flash",
				choices: [
					{
						index: 0,
						delta: {
							role: "assistant",
							content: "",
							reasoning_content: "",
							tool_calls: [],
						},
						finish_reason: "",
					},
				],
			}),
			JSON.stringify({
				id: "c1",
				model: "deepseek-v4.1-flash",
				choices: [
					{
						index: 0,
						delta: { content: "Hi", tool_calls: [] },
						finish_reason: "",
					},
				],
			}),
			"[DONE]",
		]);
		const transformed = transformStreamingResponse(upstream);
		const raw = await readStream(transformed.body);
		const events = parseSSEEvents(raw);
		const deltas = events.filter((e) => e.event === "content_block_delta");
		const texts = deltas.map((e) => parseEventData(e).delta.text);
		expect(texts).toContain("Hi");
	});

	it("emits message_delta with stop_reason end_turn on [DONE]", async () => {
		const upstream = makeOpenAIStream([
			JSON.stringify({
				id: "c1",
				model: "gpt-4",
				choices: [
					{ index: 0, delta: { content: "Done" }, finish_reason: "stop" },
				],
			}),
			"[DONE]",
		]);
		const transformed = transformStreamingResponse(upstream);
		const raw = await readStream(transformed.body);
		const events = parseSSEEvents(raw);
		const msgDelta = events.find((e) => e.event === "message_delta");
		expect(msgDelta).toBeDefined();
		if (!msgDelta) throw new Error("expected message_delta event");
		const parsed = JSON.parse(msgDelta.data);
		expect(parsed.delta.stop_reason).toBe("end_turn");
	});

	it("emits message_stop after message_delta", async () => {
		const upstream = makeOpenAIStream([
			JSON.stringify({
				id: "c1",
				model: "gpt-4",
				choices: [{ index: 0, delta: { content: "Hi" }, finish_reason: null }],
			}),
			"[DONE]",
		]);
		const transformed = transformStreamingResponse(upstream);
		const raw = await readStream(transformed.body);
		const events = parseSSEEvents(raw);
		const types = events.map((e) => e.event);
		const msgDeltaIdx = types.lastIndexOf("message_delta");
		const msgStopIdx = types.indexOf("message_stop");
		expect(msgStopIdx).toBeGreaterThan(msgDeltaIdx);
	});

	it("forwards usage tokens from the upstream stream", async () => {
		const upstream = makeOpenAIStream([
			JSON.stringify({
				id: "c1",
				model: "gpt-4",
				choices: [{ index: 0, delta: { content: "Hi" }, finish_reason: null }],
				usage: { prompt_tokens: 20, completion_tokens: 5 },
			}),
			"[DONE]",
		]);
		const transformed = transformStreamingResponse(upstream);
		const raw = await readStream(transformed.body);
		const events = parseSSEEvents(raw);
		const msgDelta = events.find((e) => e.event === "message_delta");
		expect(msgDelta).toBeDefined();
		if (!msgDelta) throw new Error("expected message_delta event");
		const parsed = JSON.parse(msgDelta.data);
		expect(parsed.usage.input_tokens).toBe(20);
		expect(parsed.usage.output_tokens).toBe(5);
	});

	it("includes content_block_stop for text block", async () => {
		const upstream = makeOpenAIStream([
			JSON.stringify({
				id: "c1",
				model: "gpt-4",
				choices: [{ index: 0, delta: { content: "Hi" }, finish_reason: null }],
			}),
			"[DONE]",
		]);
		const transformed = transformStreamingResponse(upstream);
		const raw = await readStream(transformed.body);
		const events = parseSSEEvents(raw);
		const types = events.map((e) => e.event);
		expect(types).toContain("content_block_stop");
	});

	it("advertises the official 500k Grok 4.6 window on message_delta", async () => {
		const upstream = makeOpenAIStream([
			JSON.stringify({
				id: "c1",
				model: "grok-4.6",
				choices: [{ index: 0, delta: { content: "Hi" }, finish_reason: null }],
				usage: {
					prompt_tokens: 20,
					completion_tokens: 5,
					prompt_tokens_details: { cached_tokens: 12 },
				},
			}),
			"[DONE]",
		]);
		const transformed = transformStreamingResponse(upstream, {
			contextWindowForModel: (model) =>
				model === "grok-4.6" ? 500_000 : undefined,
		});
		const raw = await readStream(transformed.body);
		const events = parseSSEEvents(raw);
		const msgDelta = events.find((e) => e.event === "message_delta");
		expect(msgDelta).toBeDefined();
		if (!msgDelta) throw new Error("expected message_delta event");
		const parsed = JSON.parse(msgDelta.data);

		expect(parsed.context_window).toEqual({
			current_usage: {
				input_tokens: 8,
				cache_read_input_tokens: 12,
				cache_creation_input_tokens: 0,
			},
			context_window_size: 500_000,
		});
	});

	it("does not infer context capacity from an upstream model name", async () => {
		const upstream = makeOpenAIStream([
			JSON.stringify({
				id: "c1",
				model: "grok-4.6",
				choices: [{ index: 0, delta: { content: "Hi" }, finish_reason: null }],
				usage: { prompt_tokens: 20, completion_tokens: 5 },
			}),
			"[DONE]",
		]);
		const transformed = transformStreamingResponse(upstream);
		const raw = await readStream(transformed.body);
		const events = parseSSEEvents(raw);
		const msgDelta = events.find((e) => e.event === "message_delta");
		expect(msgDelta).toBeDefined();
		if (!msgDelta) throw new Error("expected message_delta event");
		expect(JSON.parse(msgDelta.data)).not.toHaveProperty("context_window");
	});

	it("does not double-count cached tokens in message_delta usage", async () => {
		// Reproduces request 280cee17-3dbb-49cb-8928-314d81f724f6 (codebuddy,
		// deepseek-v4.1-flash): prompt_tokens is cache-inclusive upstream, so
		// Anthropic's additive input_tokens must exclude the cached subset or
		// the proxy records 33730 + 33536 input tokens for a 194-token prompt.
		const upstream = makeOpenAIStream([
			JSON.stringify({
				id: "c1",
				model: "deepseek-v4.1-flash",
				choices: [{ index: 0, delta: { content: "Hi" }, finish_reason: null }],
				usage: {
					prompt_tokens: 33730,
					completion_tokens: 61,
					prompt_tokens_details: { cached_tokens: 33536 },
				},
			}),
			"[DONE]",
		]);
		const transformed = transformStreamingResponse(upstream);
		const raw = await readStream(transformed.body);
		const events = parseSSEEvents(raw);
		const msgDelta = events.find((e) => e.event === "message_delta");
		expect(msgDelta).toBeDefined();
		if (!msgDelta) throw new Error("expected message_delta event");
		const usage = JSON.parse(msgDelta.data).usage;

		expect(usage).toEqual({
			input_tokens: 194,
			output_tokens: 61,
			cache_read_input_tokens: 33536,
			cache_creation_input_tokens: 0,
		});
	});

	it("keeps message_delta input_tokens as the full prompt when nothing is cached", async () => {
		const upstream = makeOpenAIStream([
			JSON.stringify({
				id: "c1",
				model: "grok-4.6",
				choices: [{ index: 0, delta: { content: "Hi" }, finish_reason: null }],
				usage: { prompt_tokens: 20, completion_tokens: 5 },
			}),
			"[DONE]",
		]);
		const transformed = transformStreamingResponse(upstream);
		const raw = await readStream(transformed.body);
		const events = parseSSEEvents(raw);
		const msgDelta = events.find((e) => e.event === "message_delta");
		expect(msgDelta).toBeDefined();
		if (!msgDelta) throw new Error("expected message_delta event");
		const usage = JSON.parse(msgDelta.data).usage;

		expect(usage.input_tokens).toBe(20);
		expect(usage.cache_read_input_tokens).toBe(0);
	});

	it("does not double-count a fully cached prompt in context_window.current_usage", async () => {
		const upstream = makeOpenAIStream([
			JSON.stringify({
				id: "c1",
				model: "grok-4.6",
				choices: [{ index: 0, delta: { content: "Hi" }, finish_reason: null }],
				usage: {
					prompt_tokens: 20,
					completion_tokens: 5,
					prompt_tokens_details: { cached_tokens: 20 },
				},
			}),
			"[DONE]",
		]);
		const transformed = transformStreamingResponse(upstream, {
			contextWindowForModel: (model) =>
				model === "grok-4.6" ? 500_000 : undefined,
		});
		const raw = await readStream(transformed.body);
		const events = parseSSEEvents(raw);
		const msgDelta = events.find((e) => e.event === "message_delta");
		expect(msgDelta).toBeDefined();
		if (!msgDelta) throw new Error("expected message_delta event");
		const parsed = JSON.parse(msgDelta.data);

		expect(parsed.context_window.current_usage).toEqual({
			input_tokens: 0,
			cache_read_input_tokens: 20,
			cache_creation_input_tokens: 0,
		});
	});
});

// ── transformStreamingResponse — tool call stream ────────────────────────────

describe("transformStreamingResponse — tool calls", () => {
	it("emits content_block_start with tool_use type on first tool call chunk", async () => {
		const upstream = makeOpenAIStream([
			JSON.stringify({
				id: "c1",
				model: "gpt-4",
				choices: [
					{
						index: 0,
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
			}),
			JSON.stringify({
				id: "c1",
				model: "gpt-4",
				choices: [
					{
						index: 0,
						delta: {
							tool_calls: [
								{ index: 0, function: { arguments: '{"q":"bun"}' } },
							],
						},
						finish_reason: null,
					},
				],
			}),
			"[DONE]",
		]);
		const transformed = transformStreamingResponse(upstream);
		const raw = await readStream(transformed.body);
		const events = parseSSEEvents(raw);
		const blockStart = events.find(
			(e) =>
				e.event === "content_block_start" &&
				parseEventData(e).content_block?.type === "tool_use",
		);
		expect(blockStart).toBeDefined();
		if (!blockStart) throw new Error("expected block_start event");
		const blockStartData = JSON.parse(blockStart.data);
		expect(blockStartData.content_block.name).toBe("search");
		expect(blockStartData.content_block.id).toBe("call_abc");
	});

	it("buffers all argument chunks and emits a single input_json_delta at [DONE]", async () => {
		const upstream = makeOpenAIStream([
			JSON.stringify({
				id: "c1",
				model: "gpt-4",
				choices: [
					{
						index: 0,
						delta: {
							tool_calls: [
								{
									index: 0,
									id: "call_abc",
									type: "function",
									function: { name: "search", arguments: '{"q"' },
								},
							],
						},
						finish_reason: null,
					},
				],
			}),
			JSON.stringify({
				id: "c1",
				model: "gpt-4",
				choices: [
					{
						index: 0,
						delta: {
							tool_calls: [{ index: 0, function: { arguments: ':"bun"}' } }],
						},
						finish_reason: null,
					},
				],
			}),
			"[DONE]",
		]);
		const transformed = transformStreamingResponse(upstream);
		const raw = await readStream(transformed.body);
		const events = parseSSEEvents(raw);
		const deltas = events.filter(
			(e) =>
				e.event === "content_block_delta" &&
				parseEventData(e).delta?.type === "input_json_delta",
		);
		// Should be exactly one buffered emission
		expect(deltas).toHaveLength(1);
		const delta0 = deltas[0];
		expect(delta0).toBeDefined();
		if (!delta0) throw new Error("expected input_json_delta event");
		expect(JSON.parse(delta0.data).delta.partial_json).toBe('{"q":"bun"}');
	});

	it("emits message_delta with stop_reason tool_use for tool calls", async () => {
		const upstream = makeOpenAIStream([
			JSON.stringify({
				id: "c1",
				model: "gpt-4",
				choices: [
					{
						index: 0,
						delta: {
							tool_calls: [
								{
									index: 0,
									id: "call_1",
									type: "function",
									function: { name: "fn", arguments: "{}" },
								},
							],
						},
						finish_reason: "tool_calls",
					},
				],
			}),
			"[DONE]",
		]);
		const transformed = transformStreamingResponse(upstream);
		const raw = await readStream(transformed.body);
		const events = parseSSEEvents(raw);
		const msgDelta = events.find((e) => e.event === "message_delta");
		expect(msgDelta).toBeDefined();
		if (!msgDelta) throw new Error("expected message_delta event");
		expect(JSON.parse(msgDelta.data).delta.stop_reason).toBe("tool_use");
	});

	it("handles multiple parallel tool calls (indexes 0 and 1)", async () => {
		const upstream = makeOpenAIStream([
			JSON.stringify({
				id: "c1",
				model: "gpt-4",
				choices: [
					{
						index: 0,
						delta: {
							tool_calls: [
								{
									index: 0,
									id: "call_a",
									type: "function",
									function: { name: "search", arguments: '{"q":"a"}' },
								},
								{
									index: 1,
									id: "call_b",
									type: "function",
									function: { name: "lookup", arguments: '{"id":"1"}' },
								},
							],
						},
						finish_reason: null,
					},
				],
			}),
			"[DONE]",
		]);
		const transformed = transformStreamingResponse(upstream);
		const raw = await readStream(transformed.body);
		const events = parseSSEEvents(raw);
		const toolStarts = events.filter(
			(e) =>
				e.event === "content_block_start" &&
				parseEventData(e).content_block?.type === "tool_use",
		);
		expect(toolStarts).toHaveLength(2);
	});

	it("drops tool call chunks with invalid index (too large)", async () => {
		const upstream = makeOpenAIStream([
			JSON.stringify({
				id: "c1",
				model: "gpt-4",
				choices: [
					{
						index: 0,
						delta: {
							tool_calls: [
								{
									index: 999,
									id: "call_overflow",
									type: "function",
									function: { name: "overflow", arguments: "{}" },
								},
							],
						},
						finish_reason: null,
					},
				],
			}),
			"[DONE]",
		]);
		const transformed = transformStreamingResponse(upstream);
		const raw = await readStream(transformed.body);
		// Should not throw; stream terminates cleanly
		expect(raw).toBeDefined();
	});
});

// ── transformStreamingResponse — flush (stream truncated without [DONE]) ─────

describe("transformStreamingResponse — flush path (no [DONE])", () => {
	it("emits stop events when stream ends without [DONE] for text content", async () => {
		const encoder = new TextEncoder();
		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				// Send a text chunk but no [DONE]
				controller.enqueue(
					encoder.encode(
						`data: ${JSON.stringify({
							id: "c1",
							model: "gpt-4",
							choices: [
								{ index: 0, delta: { content: "Hello" }, finish_reason: null },
							],
						})}\n\n`,
					),
				);
				controller.close(); // close without [DONE]
			},
		});
		const upstream = new Response(body, {
			headers: { "content-type": "text/event-stream" },
		});
		const transformed = transformStreamingResponse(upstream);
		const raw = await readStream(transformed.body);
		const events = parseSSEEvents(raw);
		const types = events.map((e) => e.event);
		// Should emit message_stop and message_delta even without [DONE]
		expect(types).toContain("message_delta");
		expect(types).toContain("message_stop");
	});

	it("emits nothing terminal when the body closes before any valid chunk", async () => {
		// Transport died before a single parseable chunk: message_start was never
		// sent, so a message_delta/message_stop here would make a broken stream
		// look like a completed empty answer.
		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(new TextEncoder().encode("data: {not json\n\n"));
				controller.close();
			},
		});
		const upstream = new Response(body, {
			headers: { "content-type": "text/event-stream" },
		});
		const events = parseSSEEvents(
			await readStream(transformStreamingResponse(upstream).body),
		);
		const types = events.map(parseEventData).map((d) => d.type);
		expect(types).not.toContain("message_delta");
		expect(types).not.toContain("message_stop");
	});

	it("finishes the message on flush when no content block ever opened", async () => {
		// Only empty content, then the body closes with no [DONE]. Nothing was
		// opened, so no block may be stopped — but the message must still end
		// because the final chunk declared completion via finish_reason.
		const encoder = new TextEncoder();
		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				const contents = ["", []];
				for (const [i, content] of contents.entries()) {
					controller.enqueue(
						encoder.encode(
							`data: ${JSON.stringify({
								id: "c1",
								model: "zai-glm-5-3-flash",
								choices: [
									{
										index: 0,
										delta: { content },
										finish_reason: i === contents.length - 1 ? "stop" : null,
									},
								],
							})}\n\n`,
						),
					);
				}
				controller.close(); // close without [DONE]
			},
		});
		const upstream = new Response(body, {
			headers: { "content-type": "text/event-stream" },
		});
		const events = parseSSEEvents(
			await readStream(transformStreamingResponse(upstream).body),
		);
		expect(events.filter((e) => e.event === "content_block_stop")).toHaveLength(
			0,
		);
		const data = events.map(parseEventData);
		expect(
			data.find((d) => d.type === "message_delta")?.delta.stop_reason,
		).toBe("end_turn");
		expect(data.find((d) => d.type === "message_stop")).toBeDefined();
	});

	it("does not finish the message on flush when no finish_reason was seen", async () => {
		// A role-only chunk followed by EOF: the connection died before the
		// upstream declared completion. Emitting message_stop here would make the
		// proxy record a truncated empty response as a successful completion, so
		// the stream must stay unterminated for terminal recovery to classify it
		// as truncated.
		const upstream = makeOpenAIStream([
			JSON.stringify({
				id: "c1",
				model: "gpt-4",
				choices: [
					{
						index: 0,
						delta: { role: "assistant", content: "" },
						finish_reason: null,
					},
				],
			}),
		]);
		const events = parseSSEEvents(
			await readStream(transformStreamingResponse(upstream).body),
		);
		const types = events.map(parseEventData).map((d) => d.type);
		expect(types).toContain("message_start");
		expect(types).not.toContain("message_delta");
		expect(types).not.toContain("message_stop");
	});

	it("finishes the message on flush when the upstream declared finish_reason", async () => {
		// The GLM/Mistral shape from the hang fix: a final empty-content chunk
		// carrying `finish_reason: "stop"`, then EOF with no [DONE]. Completion
		// was declared, so the message must be finished rather than left hanging.
		const upstream = makeOpenAIStream([
			JSON.stringify({
				id: "c1",
				model: "zai-glm-5-3-flash",
				choices: [
					{
						index: 0,
						delta: { role: "assistant", content: "" },
						finish_reason: null,
					},
				],
			}),
			JSON.stringify({
				id: "c1",
				model: "zai-glm-5-3-flash",
				choices: [{ index: 0, delta: { content: "" }, finish_reason: "stop" }],
			}),
		]);
		const events = parseSSEEvents(
			await readStream(transformStreamingResponse(upstream).body),
		);
		expect(events.filter((e) => e.event === "content_block_stop")).toHaveLength(
			0,
		);
		const data = events.map(parseEventData);
		expect(
			data.find((d) => d.type === "message_delta")?.delta.stop_reason,
		).toBe("end_turn");
		expect(data.find((d) => d.type === "message_stop")).toBeDefined();
	});

	it("emits buffered tool call JSON on flush without [DONE]", async () => {
		const encoder = new TextEncoder();
		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(
					encoder.encode(
						`data: ${JSON.stringify({
							id: "c1",
							model: "gpt-4",
							choices: [
								{
									index: 0,
									delta: {
										tool_calls: [
											{
												index: 0,
												id: "call_flush",
												type: "function",
												function: { name: "fn", arguments: '{"x":1}' },
											},
										],
									},
									finish_reason: null,
								},
							],
						})}\n\n`,
					),
				);
				controller.close(); // truncated stream
			},
		});
		const upstream = new Response(body, {
			headers: { "content-type": "text/event-stream" },
		});
		const transformed = transformStreamingResponse(upstream);
		const raw = await readStream(transformed.body);
		const events = parseSSEEvents(raw);
		const jsonDelta = events.find(
			(e) =>
				e.event === "content_block_delta" &&
				parseEventData(e).delta?.type === "input_json_delta",
		);
		expect(jsonDelta).toBeDefined();
	});
});

// ── transformStreamingResponse — thinking/reasoning blocks ───────────────────

describe("transformStreamingResponse — reasoning_content (thinking blocks)", () => {
	it("emits thinking deltas for the `reasoning` alias when reasoning_content is empty", async () => {
		const encoder = new TextEncoder();
		const payload = JSON.stringify({
			id: "c1",
			model: "deepseek-v4.1-flash",
			choices: [
				{
					index: 0,
					delta: { reasoning_content: "", reasoning: "Thinking..." },
					finish_reason: null,
				},
			],
		});
		const upstream = new Response(
			new ReadableStream<Uint8Array>({
				start(controller) {
					controller.enqueue(encoder.encode(`data: ${payload}\n\n`));
					controller.enqueue(encoder.encode("data: [DONE]\n\n"));
					controller.close();
				},
			}),
			{ headers: { "content-type": "text/event-stream" } },
		);
		const transformed = transformStreamingResponse(upstream);
		const raw = await readStream(transformed.body);
		const events = parseSSEEvents(raw);
		const thinkingDeltas = events.filter(
			(e) => parseEventData(e).delta?.type === "thinking_delta",
		);
		expect(thinkingDeltas.map((e) => parseEventData(e).delta.thinking)).toEqual(
			["Thinking..."],
		);
	});

	it("emits content_block_start with type thinking before first reasoning_content chunk", async () => {
		const upstream = makeOpenAIStream([
			JSON.stringify({
				id: "c1",
				model: "deepseek-r1",
				choices: [
					{
						index: 0,
						delta: { reasoning_content: "Let me think..." },
						finish_reason: null,
					},
				],
			}),
			"[DONE]",
		]);
		const transformed = transformStreamingResponse(upstream);
		const raw = await readStream(transformed.body);
		const events = parseSSEEvents(raw);
		const thinkingStart = events.find(
			(e) =>
				e.event === "content_block_start" &&
				parseEventData(e).content_block?.type === "thinking",
		);
		expect(thinkingStart).toBeDefined();
		if (!thinkingStart) throw new Error("expected thinking block_start event");
		expect(JSON.parse(thinkingStart.data).index).toBe(0);
	});

	it("emits content_block_delta with type thinking_delta for reasoning_content chunks", async () => {
		const upstream = makeOpenAIStream([
			JSON.stringify({
				id: "c1",
				model: "deepseek-r1",
				choices: [
					{
						index: 0,
						delta: { reasoning_content: "First thought." },
						finish_reason: null,
					},
				],
			}),
			JSON.stringify({
				id: "c1",
				model: "deepseek-r1",
				choices: [
					{
						index: 0,
						delta: { reasoning_content: " Second thought." },
						finish_reason: null,
					},
				],
			}),
			"[DONE]",
		]);
		const transformed = transformStreamingResponse(upstream);
		const raw = await readStream(transformed.body);
		const events = parseSSEEvents(raw);
		const thinkingDeltas = events.filter(
			(e) =>
				e.event === "content_block_delta" &&
				parseEventData(e).delta?.type === "thinking_delta",
		);
		expect(thinkingDeltas.length).toBeGreaterThanOrEqual(2);
		const thoughts = thinkingDeltas.map(
			(e) => parseEventData(e).delta.thinking,
		);
		expect(thoughts).toContain("First thought.");
		expect(thoughts).toContain(" Second thought.");
	});

	it("emits content_block_start for thinking only once across multiple chunks", async () => {
		const upstream = makeOpenAIStream([
			JSON.stringify({
				id: "c1",
				model: "deepseek-r1",
				choices: [
					{ index: 0, delta: { reasoning_content: "A" }, finish_reason: null },
				],
			}),
			JSON.stringify({
				id: "c1",
				model: "deepseek-r1",
				choices: [
					{ index: 0, delta: { reasoning_content: "B" }, finish_reason: null },
				],
			}),
			"[DONE]",
		]);
		const transformed = transformStreamingResponse(upstream);
		const raw = await readStream(transformed.body);
		const events = parseSSEEvents(raw);
		const thinkingStarts = events.filter(
			(e) =>
				e.event === "content_block_start" &&
				parseEventData(e).content_block?.type === "thinking",
		);
		expect(thinkingStarts).toHaveLength(1);
	});

	it("closes thinking block (content_block_stop at index 0) before opening text block when text follows", async () => {
		const upstream = makeOpenAIStream([
			JSON.stringify({
				id: "c1",
				model: "deepseek-r1",
				choices: [
					{
						index: 0,
						delta: { reasoning_content: "Thinking..." },
						finish_reason: null,
					},
				],
			}),
			JSON.stringify({
				id: "c1",
				model: "deepseek-r1",
				choices: [
					{ index: 0, delta: { content: "Answer." }, finish_reason: null },
				],
			}),
			"[DONE]",
		]);
		const transformed = transformStreamingResponse(upstream);
		const raw = await readStream(transformed.body);
		const events = parseSSEEvents(raw);
		const types = events.map((e) => e.event);

		// content_block_stop at index 0 must appear before content_block_start for text
		const stops = events
			.map((e, i) => ({ e, i }))
			.filter(
				({ e }) =>
					e.event === "content_block_stop" && parseEventData(e).index === 0,
			);
		const textStart = events
			.map((e, i) => ({ e, i }))
			.find(
				({ e }) =>
					e.event === "content_block_start" &&
					parseEventData(e).content_block?.type === "text",
			);
		expect(stops).toHaveLength(1);
		expect(textStart).toBeDefined();
		expect(stops[0]?.i).toBeLessThan(textStart?.i);

		// text block must be at index 1
		expect(JSON.parse(textStart?.e.data).index).toBe(1);
		expect(types).toContain("message_start");
	});

	it("emits text block at index 1 when thinking preceded it", async () => {
		const upstream = makeOpenAIStream([
			JSON.stringify({
				id: "c1",
				model: "deepseek-r1",
				choices: [
					{
						index: 0,
						delta: { reasoning_content: "Think." },
						finish_reason: null,
					},
				],
			}),
			JSON.stringify({
				id: "c1",
				model: "deepseek-r1",
				choices: [
					{ index: 0, delta: { content: "Reply." }, finish_reason: null },
				],
			}),
			"[DONE]",
		]);
		const transformed = transformStreamingResponse(upstream);
		const raw = await readStream(transformed.body);
		const events = parseSSEEvents(raw);
		const textBlockStart = events.find(
			(e) =>
				e.event === "content_block_start" &&
				parseEventData(e).content_block?.type === "text",
		);
		expect(textBlockStart).toBeDefined();
		if (!textBlockStart) throw new Error("expected text block_start event");
		expect(JSON.parse(textBlockStart.data).index).toBe(1);

		// text_delta should also be at index 1
		const textDeltas = events.filter(
			(e) =>
				e.event === "content_block_delta" &&
				parseEventData(e).delta?.type === "text_delta",
		);
		expect(textDeltas.length).toBeGreaterThanOrEqual(1);
		const textDelta0 = textDeltas[0];
		expect(textDelta0).toBeDefined();
		if (!textDelta0) throw new Error("expected text_delta event");
		expect(JSON.parse(textDelta0.data).index).toBe(1);
	});

	it("emits content_block_stop at index 1 on stream end when thinking+text both present", async () => {
		const upstream = makeOpenAIStream([
			JSON.stringify({
				id: "c1",
				model: "deepseek-r1",
				choices: [
					{
						index: 0,
						delta: { reasoning_content: "Think." },
						finish_reason: null,
					},
				],
			}),
			JSON.stringify({
				id: "c1",
				model: "deepseek-r1",
				choices: [
					{ index: 0, delta: { content: "Answer." }, finish_reason: "stop" },
				],
			}),
			"[DONE]",
		]);
		const transformed = transformStreamingResponse(upstream);
		const raw = await readStream(transformed.body);
		const events = parseSSEEvents(raw);
		// Exactly 2 content_block_stop events: thinking (index 0) and text (index 1)
		const allStops = events.filter((e) => e.event === "content_block_stop");
		expect(allStops).toHaveLength(2);
		expect(allStops.map((e) => parseEventData(e).index).sort()).toEqual([0, 1]);
	});

	it("handles reasoning_content only (no text) — thinking block without text block", async () => {
		const upstream = makeOpenAIStream([
			JSON.stringify({
				id: "c1",
				model: "deepseek-r1",
				choices: [
					{
						index: 0,
						delta: { reasoning_content: "Pure thought." },
						finish_reason: null,
					},
				],
			}),
			"[DONE]",
		]);
		const transformed = transformStreamingResponse(upstream);
		const raw = await readStream(transformed.body);
		const events = parseSSEEvents(raw);

		// Thinking block start was emitted
		const thinkingStart = events.find(
			(e) =>
				e.event === "content_block_start" &&
				parseEventData(e).content_block?.type === "thinking",
		);
		expect(thinkingStart).toBeDefined();

		// No text block start emitted
		const textStart = events.find(
			(e) =>
				e.event === "content_block_start" &&
				parseEventData(e).content_block?.type === "text",
		);
		expect(textStart).toBeUndefined();

		// Thinking block must be closed exactly once and message terminated
		const stops = events.filter((e) => e.event === "content_block_stop");
		expect(stops).toHaveLength(1);
		const stop0 = stops[0];
		expect(stop0).toBeDefined();
		if (!stop0) throw new Error("expected content_block_stop event");
		expect(JSON.parse(stop0.data).index).toBe(0);
		const types = events.map((e) => e.event);
		expect(types).toContain("message_stop");
	});

	it("closes thinking block before first tool_use block when reasoning_content precedes tool_calls", async () => {
		const upstream = makeOpenAIStream([
			JSON.stringify({
				id: "c1",
				model: "deepseek-r1",
				choices: [
					{
						index: 0,
						delta: { reasoning_content: "Thinking..." },
						finish_reason: null,
					},
				],
			}),
			JSON.stringify({
				id: "c1",
				model: "deepseek-r1",
				choices: [
					{
						index: 0,
						delta: {
							tool_calls: [
								{
									index: 0,
									id: "tc1",
									type: "function",
									function: { name: "search", arguments: "" },
								},
							],
						},
						finish_reason: null,
					},
				],
			}),
			JSON.stringify({
				id: "c1",
				model: "deepseek-r1",
				choices: [
					{
						index: 0,
						delta: {
							tool_calls: [{ index: 0, function: { arguments: '{"q":"hi"}' } }],
						},
						finish_reason: "tool_calls",
					},
				],
			}),
			"[DONE]",
		]);
		const transformed = transformStreamingResponse(upstream);
		const raw = await readStream(transformed.body);
		const events = parseSSEEvents(raw);

		const thinkingStart = events.findIndex(
			(e) =>
				e.event === "content_block_start" &&
				parseEventData(e).content_block?.type === "thinking",
		);
		const thinkingStop = events.findIndex(
			(e) => e.event === "content_block_stop" && parseEventData(e).index === 0,
		);
		const toolStart = events.findIndex(
			(e) =>
				e.event === "content_block_start" &&
				parseEventData(e).content_block?.type === "tool_use",
		);

		expect(thinkingStart).toBeGreaterThanOrEqual(0);
		expect(thinkingStop).toBeGreaterThanOrEqual(0);
		expect(toolStart).toBeGreaterThanOrEqual(0);
		// thinking must be closed before tool opens
		expect(thinkingStop).toBeLessThan(toolStart);
		// tool block gets index 1 (thinking consumed 0)
		const toolStartEvent = events[toolStart];
		expect(toolStartEvent).toBeDefined();
		if (!toolStartEvent)
			throw new Error("expected tool_use block_start event at index");
		expect(JSON.parse(toolStartEvent.data).index).toBe(1);
	});

	it("closes text block before first tool_use block when text precedes tool_calls", async () => {
		const upstream = makeOpenAIStream([
			JSON.stringify({
				id: "c1",
				model: "gpt-4o",
				choices: [
					{
						index: 0,
						delta: { content: "Let me check." },
						finish_reason: null,
					},
				],
			}),
			JSON.stringify({
				id: "c1",
				model: "gpt-4o",
				choices: [
					{
						index: 0,
						delta: {
							tool_calls: [
								{
									index: 0,
									id: "tc1",
									type: "function",
									function: { name: "search", arguments: "" },
								},
							],
						},
						finish_reason: null,
					},
				],
			}),
			JSON.stringify({
				id: "c1",
				model: "gpt-4o",
				choices: [
					{
						index: 0,
						delta: {
							tool_calls: [{ index: 0, function: { arguments: '{"q":"x"}' } }],
						},
						finish_reason: "tool_calls",
					},
				],
			}),
			"[DONE]",
		]);
		const transformed = transformStreamingResponse(upstream);
		const raw = await readStream(transformed.body);
		const events = parseSSEEvents(raw);

		const textStartIdx = events.findIndex(
			(e) =>
				e.event === "content_block_start" &&
				parseEventData(e).content_block?.type === "text",
		);
		const textStopIdx = events.findIndex(
			(e) => e.event === "content_block_stop" && parseEventData(e).index === 0,
		);
		const toolStartIdx = events.findIndex(
			(e) =>
				e.event === "content_block_start" &&
				parseEventData(e).content_block?.type === "tool_use",
		);

		expect(textStartIdx).toBeGreaterThanOrEqual(0);
		expect(textStopIdx).toBeGreaterThanOrEqual(0);
		expect(toolStartIdx).toBeGreaterThanOrEqual(0);
		// text block (idx=0) must be closed before tool block opens
		expect(textStopIdx).toBeLessThan(toolStartIdx);
		// tool block gets index 1
		const toolStartEvent2 = events[toolStartIdx];
		expect(toolStartEvent2).toBeDefined();
		if (!toolStartEvent2)
			throw new Error("expected tool_use block_start event at index");
		expect(JSON.parse(toolStartEvent2.data).index).toBe(1);
	});

	it("closes text block before thinking block when content precedes reasoning_content", async () => {
		// text chunk → reasoning_content chunk → [DONE]
		// Text block (index 0) must be closed before thinking block (index 1) opens.
		const upstream = makeOpenAIStream([
			JSON.stringify({
				id: "c1",
				model: "deepseek-r1",
				choices: [
					{ index: 0, delta: { content: "Intro." }, finish_reason: null },
				],
			}),
			JSON.stringify({
				id: "c1",
				model: "deepseek-r1",
				choices: [
					{
						index: 0,
						delta: { reasoning_content: "Now thinking." },
						finish_reason: null,
					},
				],
			}),
			"[DONE]",
		]);
		const transformed = transformStreamingResponse(upstream);
		const raw = await readStream(transformed.body);
		const events = parseSSEEvents(raw);

		const textStartIdx = events.findIndex(
			(e) =>
				e.event === "content_block_start" &&
				parseEventData(e).content_block?.type === "text",
		);
		const textStopIdx = events.findIndex(
			(e) => e.event === "content_block_stop" && parseEventData(e).index === 0,
		);
		const thinkingStartIdx = events.findIndex(
			(e) =>
				e.event === "content_block_start" &&
				parseEventData(e).content_block?.type === "thinking",
		);

		expect(textStartIdx).toBeGreaterThanOrEqual(0);
		expect(textStopIdx).toBeGreaterThanOrEqual(0);
		expect(thinkingStartIdx).toBeGreaterThanOrEqual(0);
		// text block (index 0) closed before thinking block opens
		expect(textStopIdx).toBeLessThan(thinkingStartIdx);
		// thinking block gets index 1
		const thinkingStartEvent = events[thinkingStartIdx];
		expect(thinkingStartEvent).toBeDefined();
		if (!thinkingStartEvent)
			throw new Error("expected thinking block_start event at index");
		expect(JSON.parse(thinkingStartEvent.data).index).toBe(1);
		// exactly 2 content_block_stop events: one for text (index 0), one for thinking (index 1)
		const stops = events.filter((e) => e.event === "content_block_stop");
		expect(stops).toHaveLength(2);
		expect(stops.map((e) => parseEventData(e).index).sort()).toEqual([0, 1]);
	});

	it("handles same-delta reasoning_content + content: emits thinking block then text block", async () => {
		// Single delta chunk carries both reasoning_content and content.
		// Thinking block (index 0) must come before text block (index 1).
		const upstream = makeOpenAIStream([
			JSON.stringify({
				id: "c1",
				model: "deepseek-r1",
				choices: [
					{
						index: 0,
						delta: { reasoning_content: "Think.", content: "Answer." },
						finish_reason: null,
					},
				],
			}),
			"[DONE]",
		]);
		const transformed = transformStreamingResponse(upstream);
		const raw = await readStream(transformed.body);
		const events = parseSSEEvents(raw);

		const thinkingStartIdx = events.findIndex(
			(e) =>
				e.event === "content_block_start" &&
				parseEventData(e).content_block?.type === "thinking",
		);
		const textStartIdx = events.findIndex(
			(e) =>
				e.event === "content_block_start" &&
				parseEventData(e).content_block?.type === "text",
		);

		expect(thinkingStartIdx).toBeGreaterThanOrEqual(0);
		expect(textStartIdx).toBeGreaterThanOrEqual(0);
		// thinking block (index 0) before text block (index 1)
		expect(thinkingStartIdx).toBeLessThan(textStartIdx);
		const thinkingStartEv = events[thinkingStartIdx];
		expect(thinkingStartEv).toBeDefined();
		if (!thinkingStartEv)
			throw new Error("expected thinking block_start event at index");
		const textStartEv = events[textStartIdx];
		expect(textStartEv).toBeDefined();
		if (!textStartEv)
			throw new Error("expected text block_start event at index");
		expect(JSON.parse(thinkingStartEv.data).index).toBe(0);
		expect(JSON.parse(textStartEv.data).index).toBe(1);

		// thinking block closed before text block opens
		const thinkingStopIdx = events.findIndex(
			(e) => e.event === "content_block_stop" && parseEventData(e).index === 0,
		);
		expect(thinkingStopIdx).toBeGreaterThanOrEqual(0);
		expect(thinkingStopIdx).toBeLessThan(textStartIdx);
		// exactly 2 content_block_stop events: one for thinking (index 0), one for text (index 1)
		const stops = events.filter((e) => e.event === "content_block_stop");
		expect(stops).toHaveLength(2);
		expect(stops.map((e) => parseEventData(e).index).sort()).toEqual([0, 1]);
	});
});

// ── transformStreamingResponse — array-shaped delta.content ──────────────────
// Some OpenAI-compatible gateways (Mistral serving zai-glm-5-3-flash) stream
// `delta.content` as an array of content blocks instead of a string.

describe("transformStreamingResponse — delta.content as an array of blocks", () => {
	function chunk(delta: unknown, finishReason: string | null = null) {
		return JSON.stringify({
			id: "c1",
			model: "zai-glm-5-3-flash",
			choices: [{ index: 0, delta, finish_reason: finishReason }],
		});
	}

	function thinkingBlock(thinking: unknown) {
		return { type: "thinking", thinking, closed: true };
	}

	it("maps streamed thinking blocks to a thinking block then text from the mixed final chunk", async () => {
		const upstream = makeOpenAIStream([
			chunk({ role: "assistant", content: [] }),
			chunk({
				index: 0,
				content: [thinkingBlock([{ type: "text", text: "The" }])],
			}),
			chunk({
				index: 0,
				content: [thinkingBlock([{ type: "text", text: " answer" }])],
			}),
			chunk({
				index: 0,
				content: [
					thinkingBlock([{ type: "text", text: 'I\'ll respond with "OK".' }]),
					{ type: "text", text: "OK" },
				],
			}),
			chunk({ content: "" }, "stop"),
			"[DONE]",
		]);
		const raw = await readStream(transformStreamingResponse(upstream).body);
		const events = parseSSEEvents(raw);

		const starts = events
			.filter((e) => e.event === "content_block_start")
			.map(parseEventData);
		expect(starts.map((s) => s.content_block.type)).toEqual([
			"thinking",
			"text",
		]);
		expect(starts.map((s) => s.index)).toEqual([0, 1]);

		const deltas = events
			.filter((e) => e.event === "content_block_delta")
			.map(parseEventData);
		const thinkingDeltas = deltas.filter(
			(d) => d.delta.type === "thinking_delta",
		);
		expect(thinkingDeltas.map((d) => d.delta.thinking)).toEqual([
			"The",
			" answer",
			'I\'ll respond with "OK".',
		]);
		expect(thinkingDeltas.every((d) => d.index === 0)).toBe(true);

		const textDeltas = deltas.filter((d) => d.delta.type === "text_delta");
		expect(textDeltas).toEqual([
			{
				type: "content_block_delta",
				index: 1,
				delta: { type: "text_delta", text: "OK" },
			},
		]);

		// thinking block closed before text block opens
		const thinkingStopIdx = events.findIndex(
			(e) => e.event === "content_block_stop" && parseEventData(e).index === 0,
		);
		const textStartIdx = events.findIndex(
			(e) =>
				e.event === "content_block_start" &&
				parseEventData(e).content_block.type === "text",
		);
		expect(thinkingStopIdx).toBeGreaterThanOrEqual(0);
		expect(thinkingStopIdx).toBeLessThan(textStartIdx);

		const stops = events.filter((e) => e.event === "content_block_stop");
		expect(stops.map((e) => parseEventData(e).index)).toEqual([0, 1]);

		// usage is still read off the final chunk even with content: ""
		const messageDelta = events
			.map(parseEventData)
			.find((d) => d.type === "message_delta");
		expect(messageDelta.delta.stop_reason).toBe("end_turn");
	});

	it("accepts a string-valued thinking field inside a thinking block", async () => {
		const upstream = makeOpenAIStream([
			chunk({ content: [thinkingBlock("Plain thought")] }),
			"[DONE]",
		]);
		const events = parseSSEEvents(
			await readStream(transformStreamingResponse(upstream).body),
		);
		const thinkingDelta = events
			.map(parseEventData)
			.find((d) => d.delta?.type === "thinking_delta");
		expect(thinkingDelta.delta.thinking).toBe("Plain thought");
	});

	it("opens a text block for a single text block array", async () => {
		const upstream = makeOpenAIStream([
			chunk({ content: [{ type: "text", text: "Hello" }] }),
			chunk({ content: [{ type: "text", text: " world" }] }),
			"[DONE]",
		]);
		const events = parseSSEEvents(
			await readStream(transformStreamingResponse(upstream).body),
		);
		const textDeltas = events
			.map(parseEventData)
			.filter((d) => d.delta?.type === "text_delta");
		expect(textDeltas.map((d) => d.delta.text)).toEqual(["Hello", " world"]);
		expect(textDeltas.every((d) => d.index === 0)).toBe(true);
	});

	it("does not open a block for content: []", async () => {
		const upstream = makeOpenAIStream([
			chunk({ role: "assistant", content: [] }),
			chunk({ content: "" }, "stop"),
			"[DONE]",
		]);
		const events = parseSSEEvents(
			await readStream(transformStreamingResponse(upstream).body),
		);
		expect(
			events.filter((e) => e.event === "content_block_start"),
		).toHaveLength(0);
		// No block opened, so none may be stopped — but the message must still
		// finish, or the client hangs waiting for message_delta/message_stop.
		expect(events.filter((e) => e.event === "content_block_stop")).toHaveLength(
			0,
		);
		const types = events.map(parseEventData).map((d) => d.type);
		expect(types).toContain("message_delta");
		expect(types).toContain("message_stop");
	});

	it("emits nothing terminal for a [DONE]-only stream that never started", async () => {
		// message_start is only sent on the first parseable chunk, and [DONE] is
		// handled before that. A body of just `[DONE]` therefore never started a
		// message, so terminal events here would fabricate a completed answer.
		const upstream = makeOpenAIStream(["[DONE]"]);
		const events = parseSSEEvents(
			await readStream(transformStreamingResponse(upstream).body),
		);
		const types = events.map(parseEventData).map((d) => d.type);
		expect(types).not.toContain("message_delta");
		expect(types).not.toContain("message_stop");
	});

	it("finishes a stream whose only content is empty blocks", async () => {
		const upstream = makeOpenAIStream([
			chunk({ role: "assistant", content: [] }),
			chunk({ content: [{ type: "text", text: "" }] }),
			chunk({ content: "" }, "stop"),
			"[DONE]",
		]);
		const events = parseSSEEvents(
			await readStream(transformStreamingResponse(upstream).body),
		);
		expect(
			events.filter((e) => e.event === "content_block_delta"),
		).toHaveLength(0);
		const data = events.map(parseEventData);
		const messageDelta = data.find((d) => d.type === "message_delta");
		expect(messageDelta.delta.stop_reason).toBe("end_turn");
		expect(data.find((d) => d.type === "message_stop")).toBeDefined();
	});

	it("still handles plain string content (regression)", async () => {
		const upstream = makeOpenAIStream([
			chunk({ role: "assistant", content: "OK" }),
			chunk({ content: "" }, "stop"),
			"[DONE]",
		]);
		const events = parseSSEEvents(
			await readStream(transformStreamingResponse(upstream).body),
		);
		const textDeltas = events
			.map(parseEventData)
			.filter((d) => d.delta?.type === "text_delta");
		expect(textDeltas.map((d) => d.delta.text)).toEqual(["OK"]);
	});

	it("closes array-shaped thinking and text blocks before the first tool_use block", async () => {
		// Block-array content (Mistral/GLM shape) followed by tool calls in the
		// same stream: both open blocks must be closed before the tool_use block
		// opens, and the tool_use block must take the next monotonic index (2).
		const upstream = makeOpenAIStream([
			chunk({ role: "assistant", content: [] }),
			chunk({
				content: [thinkingBlock([{ type: "text", text: "Need to search." }])],
			}),
			chunk({ content: [{ type: "text", text: "Let me check." }] }),
			chunk({
				tool_calls: [
					{
						index: 0,
						id: "tc1",
						type: "function",
						function: { name: "search", arguments: '{"q":"x"}' },
					},
				],
			}),
			chunk({ content: "" }, "tool_calls"),
			"[DONE]",
		]);
		const events = parseSSEEvents(
			await readStream(transformStreamingResponse(upstream).body),
		);

		const starts = events
			.filter((e) => e.event === "content_block_start")
			.map(parseEventData);
		expect(starts.map((s) => s.content_block.type)).toEqual([
			"thinking",
			"text",
			"tool_use",
		]);
		expect(starts.map((s) => s.index)).toEqual([0, 1, 2]);

		const thinkingStop = events.findIndex(
			(e) => e.event === "content_block_stop" && parseEventData(e).index === 0,
		);
		const textStop = events.findIndex(
			(e) => e.event === "content_block_stop" && parseEventData(e).index === 1,
		);
		const toolStart = events.findIndex(
			(e) =>
				e.event === "content_block_start" &&
				parseEventData(e).content_block.type === "tool_use",
		);
		expect(thinkingStop).toBeGreaterThanOrEqual(0);
		expect(textStop).toBeGreaterThanOrEqual(0);
		expect(toolStart).toBeGreaterThanOrEqual(0);
		expect(thinkingStop).toBeLessThan(toolStart);
		expect(textStop).toBeLessThan(toolStart);

		const thinkingDeltas = events
			.map(parseEventData)
			.filter((d) => d.delta?.type === "thinking_delta");
		expect(thinkingDeltas.map((d) => d.delta.thinking)).toEqual([
			"Need to search.",
		]);
		const textDeltas = events
			.map(parseEventData)
			.filter((d) => d.delta?.type === "text_delta");
		expect(textDeltas.map((d) => d.delta.text)).toEqual(["Let me check."]);

		const messageDelta = events
			.map(parseEventData)
			.find((d) => d.type === "message_delta");
		expect(messageDelta.delta.stop_reason).toBe("tool_use");
	});
});

// ── transformStreamingResponse — model extraction ────────────────────────────

describe("transformStreamingResponse — model extraction", () => {
	it("uses the mapped outbound model when the upstream stream omits model", async () => {
		const upstream = makeOpenAIStream([
			JSON.stringify({
				id: "c1",
				choices: [{ index: 0, delta: { content: "Hi" }, finish_reason: null }],
			}),
			"[DONE]",
		]);
		const transformed = transformStreamingResponse(upstream, {
			fallbackModel: "gpt-5.6-terra",
		});
		const raw = await readStream(transformed.body);
		const events = parseSSEEvents(raw);
		const msgStart = events.find((e) => e.event === "message_start");
		expect(msgStart).toBeDefined();
		if (!msgStart) throw new Error("expected message_start event");

		expect(parseEventData(msgStart).message.model).toBe("gpt-5.6-terra");
	});

	it("extracts model from first chunk and includes it in message_start", async () => {
		const upstream = makeOpenAIStream([
			JSON.stringify({
				id: "c1",
				model: "claude-sonnet-4-5",
				choices: [{ index: 0, delta: { content: "Hi" }, finish_reason: null }],
			}),
			"[DONE]",
		]);
		const transformed = transformStreamingResponse(upstream, {
			fallbackModel: "fallback-must-not-win",
		});
		const raw = await readStream(transformed.body);
		const events = parseSSEEvents(raw);
		const msgStart = events.find((e) => e.event === "message_start");
		expect(msgStart).toBeDefined();
		if (!msgStart) throw new Error("expected message_start event");
		const parsed = JSON.parse(msgStart.data);
		expect(parsed.message.model).toBe("claude-sonnet-4-5");
	});
});

// ── transformStreamingResponse — response metadata ───────────────────────────

describe("transformStreamingResponse — response metadata", () => {
	it("preserves the upstream status code", async () => {
		const upstream = makeOpenAIStream([
			JSON.stringify({
				id: "c1",
				model: "gpt-4",
				choices: [{ index: 0, delta: { content: "ok" }, finish_reason: null }],
			}),
			"[DONE]",
		]);
		const transformed = transformStreamingResponse(upstream);
		expect(transformed.status).toBe(200);
	});
});

// ── transformStreamingResponse — block index collision ───────────────────────

describe("transformStreamingResponse — block index assignment", () => {
	it("text-only: text block gets index 0", async () => {
		const upstream = makeOpenAIStream([
			JSON.stringify({
				id: "c1",
				model: "gpt-4",
				choices: [
					{ index: 0, delta: { content: "Hello" }, finish_reason: null },
				],
			}),
			"[DONE]",
		]);
		const transformed = transformStreamingResponse(upstream);
		const raw = await readStream(transformed.body);
		const events = parseSSEEvents(raw);
		const textStart = events.find(
			(e) =>
				e.event === "content_block_start" &&
				parseEventData(e).content_block?.type === "text",
		);
		expect(textStart).toBeDefined();
		if (!textStart) throw new Error("expected text block_start event");
		expect(JSON.parse(textStart.data).index).toBe(0);

		const textDeltas = events.filter(
			(e) =>
				e.event === "content_block_delta" &&
				parseEventData(e).delta?.type === "text_delta",
		);
		for (const d of textDeltas) {
			expect(parseEventData(d).index).toBe(0);
		}
	});

	it("tool-only: first tool call (OpenAI index 0) gets Anthropic block index 0", async () => {
		const upstream = makeOpenAIStream([
			JSON.stringify({
				id: "c1",
				model: "gpt-4",
				choices: [
					{
						index: 0,
						delta: {
							tool_calls: [
								{
									index: 0,
									id: "call_abc",
									type: "function",
									function: { name: "search", arguments: '{"q":"test"}' },
								},
							],
						},
						finish_reason: null,
					},
				],
			}),
			"[DONE]",
		]);
		const transformed = transformStreamingResponse(upstream);
		const raw = await readStream(transformed.body);
		const events = parseSSEEvents(raw);
		const toolStart = events.find(
			(e) =>
				e.event === "content_block_start" &&
				parseEventData(e).content_block?.type === "tool_use",
		);
		expect(toolStart).toBeDefined();
		if (!toolStart) throw new Error("expected tool_use block_start event");
		expect(JSON.parse(toolStart.data).index).toBe(0);
	});

	it("text then tool: text gets index 0, tool gets index 1 — no collision", async () => {
		// OpenAI sends text content first, then tool_calls[0] — both naively map to index 0.
		// The fix ensures the tool call is assigned the next monotonic block index (1).
		const upstream = makeOpenAIStream([
			JSON.stringify({
				id: "c1",
				model: "gpt-4",
				choices: [
					{ index: 0, delta: { content: "thinking..." }, finish_reason: null },
				],
			}),
			JSON.stringify({
				id: "c1",
				model: "gpt-4",
				choices: [
					{
						index: 0,
						delta: {
							tool_calls: [
								{
									index: 0,
									id: "call_xyz",
									type: "function",
									function: { name: "lookup", arguments: '{"id":1}' },
								},
							],
						},
						finish_reason: null,
					},
				],
			}),
			"[DONE]",
		]);
		const transformed = transformStreamingResponse(upstream);
		const raw = await readStream(transformed.body);
		const events = parseSSEEvents(raw);

		const textStart = events.find(
			(e) =>
				e.event === "content_block_start" &&
				parseEventData(e).content_block?.type === "text",
		);
		const toolStart = events.find(
			(e) =>
				e.event === "content_block_start" &&
				parseEventData(e).content_block?.type === "tool_use",
		);

		expect(textStart).toBeDefined();
		expect(toolStart).toBeDefined();
		if (!textStart) throw new Error("expected text block_start event");
		if (!toolStart) throw new Error("expected tool_use block_start event");

		const textIdx = JSON.parse(textStart.data).index;
		const toolIdx = JSON.parse(toolStart.data).index;

		// Indices must be distinct — no collision
		expect(textIdx).not.toBe(toolIdx);
		// Text block came first: index 0; tool block came second: index 1
		expect(textIdx).toBe(0);
		expect(toolIdx).toBe(1);

		// The input_json_delta must carry the same Anthropic index as the tool block_start
		const jsonDelta = events.find(
			(e) =>
				e.event === "content_block_delta" &&
				parseEventData(e).delta?.type === "input_json_delta",
		);
		expect(jsonDelta).toBeDefined();
		if (!jsonDelta) throw new Error("expected input_json_delta event");
		expect(JSON.parse(jsonDelta.data).index).toBe(toolIdx);

		// The content_block_stop for the tool must match too
		const stops = events.filter((e) => e.event === "content_block_stop");
		const stopIndices = stops.map((e) => parseEventData(e).index);
		expect(stopIndices).toContain(toolIdx);
	});

	it("multiple tool calls: each gets a distinct monotonic Anthropic block index", async () => {
		const upstream = makeOpenAIStream([
			JSON.stringify({
				id: "c1",
				model: "gpt-4",
				choices: [
					{
						index: 0,
						delta: {
							tool_calls: [
								{
									index: 0,
									id: "call_a",
									type: "function",
									function: { name: "search", arguments: '{"q":"a"}' },
								},
								{
									index: 1,
									id: "call_b",
									type: "function",
									function: { name: "lookup", arguments: '{"id":"1"}' },
								},
							],
						},
						finish_reason: null,
					},
				],
			}),
			"[DONE]",
		]);
		const transformed = transformStreamingResponse(upstream);
		const raw = await readStream(transformed.body);
		const events = parseSSEEvents(raw);

		const toolStarts = events.filter(
			(e) =>
				e.event === "content_block_start" &&
				parseEventData(e).content_block?.type === "tool_use",
		);
		expect(toolStarts).toHaveLength(2);

		const indices = toolStarts.map((e) => parseEventData(e).index);
		// All indices must be unique
		expect(new Set(indices).size).toBe(2);
		// Must be 0 and 1 (monotonically assigned)
		expect(indices.sort()).toEqual([0, 1]);
	});
});
