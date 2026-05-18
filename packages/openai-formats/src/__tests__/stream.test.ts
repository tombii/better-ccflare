import { describe, expect, it } from "bun:test";
import { sanitizeHeaders, transformStreamingResponse } from "../stream";

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Collect all bytes from a ReadableStream into a string.
 */
async function readStream(stream: ReadableStream<Uint8Array>): Promise<string> {
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
		const raw = await readStream(transformed.body!);
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
		const raw = await readStream(transformed.body!);
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
		const raw = await readStream(transformed.body!);
		const events = parseSSEEvents(raw);
		const deltas = events.filter((e) => e.event === "content_block_delta");
		expect(deltas.length).toBeGreaterThanOrEqual(2);
		const texts = deltas.map((e) => JSON.parse(e.data!).delta.text);
		expect(texts).toContain("Hello");
		expect(texts).toContain(" world");
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
		const raw = await readStream(transformed.body!);
		const events = parseSSEEvents(raw);
		const msgDelta = events.find((e) => e.event === "message_delta");
		expect(msgDelta).toBeDefined();
		const parsed = JSON.parse(msgDelta!.data);
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
		const raw = await readStream(transformed.body!);
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
		const raw = await readStream(transformed.body!);
		const events = parseSSEEvents(raw);
		const msgDelta = events.find((e) => e.event === "message_delta");
		const parsed = JSON.parse(msgDelta!.data);
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
		const raw = await readStream(transformed.body!);
		const events = parseSSEEvents(raw);
		const types = events.map((e) => e.event);
		expect(types).toContain("content_block_stop");
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
		const raw = await readStream(transformed.body!);
		const events = parseSSEEvents(raw);
		const blockStart = events.find(
			(e) =>
				e.event === "content_block_start" &&
				JSON.parse(e.data!).content_block?.type === "tool_use",
		);
		expect(blockStart).toBeDefined();
		expect(JSON.parse(blockStart!.data).content_block.name).toBe("search");
		expect(JSON.parse(blockStart!.data).content_block.id).toBe("call_abc");
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
		const raw = await readStream(transformed.body!);
		const events = parseSSEEvents(raw);
		const deltas = events.filter(
			(e) =>
				e.event === "content_block_delta" &&
				JSON.parse(e.data!).delta?.type === "input_json_delta",
		);
		// Should be exactly one buffered emission
		expect(deltas).toHaveLength(1);
		expect(JSON.parse(deltas[0]!.data).delta.partial_json).toBe('{"q":"bun"}');
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
		const raw = await readStream(transformed.body!);
		const events = parseSSEEvents(raw);
		const msgDelta = events.find((e) => e.event === "message_delta");
		expect(JSON.parse(msgDelta!.data).delta.stop_reason).toBe("tool_use");
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
		const raw = await readStream(transformed.body!);
		const events = parseSSEEvents(raw);
		const toolStarts = events.filter(
			(e) =>
				e.event === "content_block_start" &&
				JSON.parse(e.data!).content_block?.type === "tool_use",
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
		const raw = await readStream(transformed.body!);
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
		const raw = await readStream(transformed.body!);
		const events = parseSSEEvents(raw);
		const types = events.map((e) => e.event);
		// Should emit message_stop and message_delta even without [DONE]
		expect(types).toContain("message_delta");
		expect(types).toContain("message_stop");
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
		const raw = await readStream(transformed.body!);
		const events = parseSSEEvents(raw);
		const jsonDelta = events.find(
			(e) =>
				e.event === "content_block_delta" &&
				JSON.parse(e.data!).delta?.type === "input_json_delta",
		);
		expect(jsonDelta).toBeDefined();
	});
});

// ── transformStreamingResponse — thinking/reasoning blocks ───────────────────

describe("transformStreamingResponse — reasoning_content (thinking blocks)", () => {
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
		const raw = await readStream(transformed.body!);
		const events = parseSSEEvents(raw);
		const thinkingStart = events.find(
			(e) =>
				e.event === "content_block_start" &&
				JSON.parse(e.data!).content_block?.type === "thinking",
		);
		expect(thinkingStart).toBeDefined();
		expect(JSON.parse(thinkingStart!.data).index).toBe(0);
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
		const raw = await readStream(transformed.body!);
		const events = parseSSEEvents(raw);
		const thinkingDeltas = events.filter(
			(e) =>
				e.event === "content_block_delta" &&
				JSON.parse(e.data!).delta?.type === "thinking_delta",
		);
		expect(thinkingDeltas.length).toBeGreaterThanOrEqual(2);
		const thoughts = thinkingDeltas.map(
			(e) => JSON.parse(e.data!).delta.thinking,
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
		const raw = await readStream(transformed.body!);
		const events = parseSSEEvents(raw);
		const thinkingStarts = events.filter(
			(e) =>
				e.event === "content_block_start" &&
				JSON.parse(e.data!).content_block?.type === "thinking",
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
		const raw = await readStream(transformed.body!);
		const events = parseSSEEvents(raw);
		const types = events.map((e) => e.event);

		// content_block_stop at index 0 must appear before content_block_start for text
		const stops = events
			.map((e, i) => ({ e, i }))
			.filter(
				({ e }) =>
					e.event === "content_block_stop" && JSON.parse(e.data!).index === 0,
			);
		const textStart = events
			.map((e, i) => ({ e, i }))
			.find(
				({ e }) =>
					e.event === "content_block_start" &&
					JSON.parse(e.data!).content_block?.type === "text",
			);
		expect(stops).toHaveLength(1);
		expect(textStart).toBeDefined();
		expect(stops[0]?.i).toBeLessThan(textStart?.i);

		// text block must be at index 1
		expect(JSON.parse(textStart!.e.data).index).toBe(1);
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
		const raw = await readStream(transformed.body!);
		const events = parseSSEEvents(raw);
		const textBlockStart = events.find(
			(e) =>
				e.event === "content_block_start" &&
				JSON.parse(e.data!).content_block?.type === "text",
		);
		expect(textBlockStart).toBeDefined();
		expect(JSON.parse(textBlockStart!.data).index).toBe(1);

		// text_delta should also be at index 1
		const textDeltas = events.filter(
			(e) =>
				e.event === "content_block_delta" &&
				JSON.parse(e.data!).delta?.type === "text_delta",
		);
		expect(textDeltas.length).toBeGreaterThanOrEqual(1);
		expect(JSON.parse(textDeltas[0]!.data).index).toBe(1);
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
		const raw = await readStream(transformed.body!);
		const events = parseSSEEvents(raw);
		// Exactly 2 content_block_stop events: thinking (index 0) and text (index 1)
		const allStops = events.filter((e) => e.event === "content_block_stop");
		expect(allStops).toHaveLength(2);
		expect(allStops.map((e) => JSON.parse(e.data!).index).sort()).toEqual([
			0, 1,
		]);
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
		const raw = await readStream(transformed.body!);
		const events = parseSSEEvents(raw);

		// Thinking block start was emitted
		const thinkingStart = events.find(
			(e) =>
				e.event === "content_block_start" &&
				JSON.parse(e.data!).content_block?.type === "thinking",
		);
		expect(thinkingStart).toBeDefined();

		// No text block start emitted
		const textStart = events.find(
			(e) =>
				e.event === "content_block_start" &&
				JSON.parse(e.data!).content_block?.type === "text",
		);
		expect(textStart).toBeUndefined();

		// Thinking block must be closed exactly once and message terminated
		const stops = events.filter((e) => e.event === "content_block_stop");
		expect(stops).toHaveLength(1);
		expect(JSON.parse(stops[0]!.data).index).toBe(0);
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
		const raw = await readStream(transformed.body!);
		const events = parseSSEEvents(raw);

		const thinkingStart = events.findIndex(
			(e) =>
				e.event === "content_block_start" &&
				JSON.parse(e.data!).content_block?.type === "thinking",
		);
		const thinkingStop = events.findIndex(
			(e) =>
				e.event === "content_block_stop" && JSON.parse(e.data!).index === 0,
		);
		const toolStart = events.findIndex(
			(e) =>
				e.event === "content_block_start" &&
				JSON.parse(e.data!).content_block?.type === "tool_use",
		);

		expect(thinkingStart).toBeGreaterThanOrEqual(0);
		expect(thinkingStop).toBeGreaterThanOrEqual(0);
		expect(toolStart).toBeGreaterThanOrEqual(0);
		// thinking must be closed before tool opens
		expect(thinkingStop).toBeLessThan(toolStart);
		// tool block gets index 1 (thinking consumed 0)
		expect(JSON.parse(events[toolStart]!.data).index).toBe(1);
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
		const raw = await readStream(transformed.body!);
		const events = parseSSEEvents(raw);

		const textStartIdx = events.findIndex(
			(e) =>
				e.event === "content_block_start" &&
				JSON.parse(e.data!).content_block?.type === "text",
		);
		const textStopIdx = events.findIndex(
			(e) =>
				e.event === "content_block_stop" && JSON.parse(e.data!).index === 0,
		);
		const toolStartIdx = events.findIndex(
			(e) =>
				e.event === "content_block_start" &&
				JSON.parse(e.data!).content_block?.type === "tool_use",
		);

		expect(textStartIdx).toBeGreaterThanOrEqual(0);
		expect(textStopIdx).toBeGreaterThanOrEqual(0);
		expect(toolStartIdx).toBeGreaterThanOrEqual(0);
		// text block (idx=0) must be closed before tool block opens
		expect(textStopIdx).toBeLessThan(toolStartIdx);
		// tool block gets index 1
		expect(JSON.parse(events[toolStartIdx]!.data).index).toBe(1);
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
		const raw = await readStream(transformed.body!);
		const events = parseSSEEvents(raw);

		const textStartIdx = events.findIndex(
			(e) =>
				e.event === "content_block_start" &&
				JSON.parse(e.data!).content_block?.type === "text",
		);
		const textStopIdx = events.findIndex(
			(e) =>
				e.event === "content_block_stop" && JSON.parse(e.data!).index === 0,
		);
		const thinkingStartIdx = events.findIndex(
			(e) =>
				e.event === "content_block_start" &&
				JSON.parse(e.data!).content_block?.type === "thinking",
		);

		expect(textStartIdx).toBeGreaterThanOrEqual(0);
		expect(textStopIdx).toBeGreaterThanOrEqual(0);
		expect(thinkingStartIdx).toBeGreaterThanOrEqual(0);
		// text block (index 0) closed before thinking block opens
		expect(textStopIdx).toBeLessThan(thinkingStartIdx);
		// thinking block gets index 1
		expect(JSON.parse(events[thinkingStartIdx]!.data).index).toBe(1);
		// exactly 2 content_block_stop events: one for text (index 0), one for thinking (index 1)
		const stops = events.filter((e) => e.event === "content_block_stop");
		expect(stops).toHaveLength(2);
		expect(stops.map((e) => JSON.parse(e.data!).index).sort()).toEqual([0, 1]);
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
		const raw = await readStream(transformed.body!);
		const events = parseSSEEvents(raw);

		const thinkingStartIdx = events.findIndex(
			(e) =>
				e.event === "content_block_start" &&
				JSON.parse(e.data!).content_block?.type === "thinking",
		);
		const textStartIdx = events.findIndex(
			(e) =>
				e.event === "content_block_start" &&
				JSON.parse(e.data!).content_block?.type === "text",
		);

		expect(thinkingStartIdx).toBeGreaterThanOrEqual(0);
		expect(textStartIdx).toBeGreaterThanOrEqual(0);
		// thinking block (index 0) before text block (index 1)
		expect(thinkingStartIdx).toBeLessThan(textStartIdx);
		expect(JSON.parse(events[thinkingStartIdx]!.data).index).toBe(0);
		expect(JSON.parse(events[textStartIdx]!.data).index).toBe(1);

		// thinking block closed before text block opens
		const thinkingStopIdx = events.findIndex(
			(e) =>
				e.event === "content_block_stop" && JSON.parse(e.data!).index === 0,
		);
		expect(thinkingStopIdx).toBeGreaterThanOrEqual(0);
		expect(thinkingStopIdx).toBeLessThan(textStartIdx);
		// exactly 2 content_block_stop events: one for thinking (index 0), one for text (index 1)
		const stops = events.filter((e) => e.event === "content_block_stop");
		expect(stops).toHaveLength(2);
		expect(stops.map((e) => JSON.parse(e.data!).index).sort()).toEqual([0, 1]);
	});
});

// ── transformStreamingResponse — model extraction ────────────────────────────

describe("transformStreamingResponse — model extraction", () => {
	it("extracts model from first chunk and includes it in message_start", async () => {
		const upstream = makeOpenAIStream([
			JSON.stringify({
				id: "c1",
				model: "claude-sonnet-4-5",
				choices: [{ index: 0, delta: { content: "Hi" }, finish_reason: null }],
			}),
			"[DONE]",
		]);
		const transformed = transformStreamingResponse(upstream);
		const raw = await readStream(transformed.body!);
		const events = parseSSEEvents(raw);
		const msgStart = events.find((e) => e.event === "message_start");
		const parsed = JSON.parse(msgStart!.data);
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
		const raw = await readStream(transformed.body!);
		const events = parseSSEEvents(raw);
		const textStart = events.find(
			(e) =>
				e.event === "content_block_start" &&
				JSON.parse(e.data!).content_block?.type === "text",
		);
		expect(textStart).toBeDefined();
		expect(JSON.parse(textStart!.data).index).toBe(0);

		const textDeltas = events.filter(
			(e) =>
				e.event === "content_block_delta" &&
				JSON.parse(e.data!).delta?.type === "text_delta",
		);
		for (const d of textDeltas) {
			expect(JSON.parse(d.data!).index).toBe(0);
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
		const raw = await readStream(transformed.body!);
		const events = parseSSEEvents(raw);
		const toolStart = events.find(
			(e) =>
				e.event === "content_block_start" &&
				JSON.parse(e.data!).content_block?.type === "tool_use",
		);
		expect(toolStart).toBeDefined();
		expect(JSON.parse(toolStart!.data).index).toBe(0);
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
		const raw = await readStream(transformed.body!);
		const events = parseSSEEvents(raw);

		const textStart = events.find(
			(e) =>
				e.event === "content_block_start" &&
				JSON.parse(e.data!).content_block?.type === "text",
		);
		const toolStart = events.find(
			(e) =>
				e.event === "content_block_start" &&
				JSON.parse(e.data!).content_block?.type === "tool_use",
		);

		expect(textStart).toBeDefined();
		expect(toolStart).toBeDefined();

		const textIdx = JSON.parse(textStart!.data).index;
		const toolIdx = JSON.parse(toolStart!.data).index;

		// Indices must be distinct — no collision
		expect(textIdx).not.toBe(toolIdx);
		// Text block came first: index 0; tool block came second: index 1
		expect(textIdx).toBe(0);
		expect(toolIdx).toBe(1);

		// The input_json_delta must carry the same Anthropic index as the tool block_start
		const jsonDelta = events.find(
			(e) =>
				e.event === "content_block_delta" &&
				JSON.parse(e.data!).delta?.type === "input_json_delta",
		);
		expect(jsonDelta).toBeDefined();
		expect(JSON.parse(jsonDelta!.data).index).toBe(toolIdx);

		// The content_block_stop for the tool must match too
		const stops = events.filter((e) => e.event === "content_block_stop");
		const stopIndices = stops.map((e) => JSON.parse(e.data!).index);
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
		const raw = await readStream(transformed.body!);
		const events = parseSSEEvents(raw);

		const toolStarts = events.filter(
			(e) =>
				e.event === "content_block_start" &&
				JSON.parse(e.data!).content_block?.type === "tool_use",
		);
		expect(toolStarts).toHaveLength(2);

		const indices = toolStarts.map((e) => JSON.parse(e.data!).index);
		// All indices must be unique
		expect(new Set(indices).size).toBe(2);
		// Must be 0 and 1 (monotonically assigned)
		expect(indices.sort()).toEqual([0, 1]);
	});
});
