import { describe, expect, it } from "bun:test";
import { transformStreamingResponse } from "@better-ccflare/openai-formats";
import {
	aggregateQoderSse,
	QODER_AGGREGATE_TIMEOUT_MS,
	qoderFrameToOpenAIChunk,
	qoderStatusForCode,
	unwrapQoderSse,
} from "../sse-unwrap";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** One Qoder SSE frame: an envelope whose `body` is a JSON *string*. */
function frame(chunk: unknown, statusCodeValue = 200): string {
	return `data: ${JSON.stringify({
		headers: {},
		body: JSON.stringify(chunk),
		statusCodeValue,
		statusCode: statusCodeValue,
	})}\n\n`;
}

function contentChunk(content: string, extra: Record<string, unknown> = {}) {
	return {
		id: "chatcmpl-1",
		object: "chat.completion.chunk",
		model: "auto",
		choices: [{ index: 0, delta: { content }, finish_reason: null }],
		...extra,
	};
}

function streamOf(frames: string[]): Response {
	const encoder = new TextEncoder();
	return new Response(
		new ReadableStream<Uint8Array>({
			start(controller) {
				// Deliver in awkward slices so a frame can straddle reads.
				const whole = frames.join("");
				for (let i = 0; i < whole.length; i += 37) {
					controller.enqueue(encoder.encode(whole.slice(i, i + 37)));
				}
				controller.close();
			},
		}),
		{ headers: { "content-type": "text/event-stream;charset=UTF-8" } },
	);
}

async function readAll(response: Response): Promise<string> {
	return await response.text();
}

/** Parse Anthropic SSE events out of a transformed stream. */
function parseAnthropicSse(text: string): Array<Record<string, unknown>> {
	const events: Array<Record<string, unknown>> = [];
	for (const line of text.split("\n")) {
		if (!line.startsWith("data:")) continue;
		const payload = line.slice(5).trim();
		if (!payload) continue;
		try {
			events.push(JSON.parse(payload));
		} catch {
			// ignore
		}
	}
	return events;
}

// ---------------------------------------------------------------------------
// Frame decoding
// ---------------------------------------------------------------------------

describe("qoderFrameToOpenAIChunk", () => {
	it("decodes the double-encoded envelope", () => {
		const decoded = qoderFrameToOpenAIChunk(frame(contentChunk("ok")).trim());
		expect(decoded.ok).toBe(true);
		if (decoded.ok) {
			expect(decoded.chunk.choices?.[0]?.delta?.content).toBe("ok");
		}
	});

	it("ignores non-data lines and blank payloads", () => {
		expect(qoderFrameToOpenAIChunk("event: ping").ok).toBe(false);
		expect(qoderFrameToOpenAIChunk("data: ").ok).toBe(false);
		expect(qoderFrameToOpenAIChunk("[DONE]").ok).toBe(false);
	});

	it("treats a 200 envelope with a non-JSON body as empty, not an error", () => {
		const decoded = qoderFrameToOpenAIChunk(
			`data: ${JSON.stringify({ body: "not json", statusCodeValue: 200 })}`,
		);
		expect(decoded.ok).toBe(false);
	});

	it("surfaces a non-200 envelope with its upstream error text", () => {
		const decoded = qoderFrameToOpenAIChunk(
			`data: ${JSON.stringify({ body: "quota exceeded", statusCodeValue: 429 })}`,
		);
		expect(decoded.ok).toBe(false);
		if (!decoded.ok) {
			expect(decoded.error.upstreamStatus).toBe(429);
			expect(decoded.error.message).toContain("quota exceeded");
		}
	});

	it("treats a JSON error body inside a 200 envelope as an error", () => {
		const decoded = qoderFrameToOpenAIChunk(
			frame({ code: 10605, error: "busy" }).trim(),
		);
		expect(decoded.ok).toBe(false);
		if (!decoded.ok) {
			expect(decoded.error.code).toBe(10605);
			expect(decoded.error.status).toBe(503);
		}
	});
});

describe("qoderStatusForCode", () => {
	it("maps Qoder's in-band codes to HTTP statuses", () => {
		expect(qoderStatusForCode(105)).toBe(401);
		expect(qoderStatusForCode(110)).toBe(429);
		expect(qoderStatusForCode(112)).toBe(429);
		expect(qoderStatusForCode(116)).toBe(429);
		expect(qoderStatusForCode(119)).toBe(429);
		expect(qoderStatusForCode(122)).toBe(429);
		expect(qoderStatusForCode(10605)).toBe(503);
		expect(qoderStatusForCode(406)).toBe(400);
		expect(qoderStatusForCode(416)).toBe(400);
		expect(qoderStatusForCode(430)).toBe(400);
		expect(qoderStatusForCode(80411)).toBe(400);
		expect(qoderStatusForCode(80412)).toBe(400);
		expect(qoderStatusForCode(100400)).toBe(400);
		expect(qoderStatusForCode(100403)).toBe(400);
	});

	it("unwraps the gateway's stringified, nested busy payload", () => {
		// Captured live (2026-10-22): the real 403 envelope, three JSON layers.
		const inner = JSON.stringify({
			isQueued: true,
			modelKey: "qfmodel",
			queueCount: 0,
			queueType: "p3",
			retryAfterSeconds: 3,
			serviceAvailable: false,
			subCode: "RESOURCE_LIMIT",
			waitTime: 3,
		});
		const middle = JSON.stringify({
			code: "10605",
			message: inner,
			subCode: "RESOURCE_LIMIT",
		});
		const envelope = {
			headers: { "Content-Type": ["application/json"], "Retry-After": ["3"] },
			// Captured live: the payload is a JSON string that itself holds a
			// JSON string (`deepestErrorBody` bounds this nested parsing).
			body: JSON.stringify({ code: "403", message: middle }),
			statusCodeValue: 403,
			statusCode: "FORBIDDEN",
		};
		const decoded = qoderFrameToOpenAIChunk(
			`data:${JSON.stringify({ body: JSON.stringify(envelope), statusCodeValue: 200 })}`,
		);
		expect(decoded.ok).toBe(false);
		if (!decoded.ok && decoded.error) {
			expect(decoded.error.code).toBe(10605);
			expect(decoded.error.status).toBe(503);
			expect(decoded.error.retryAfterSeconds).toBe(3);
			expect(decoded.error.upstreamStatus).toBe(403);
		}
	});

	it("falls back to 502 for unknown codes", () => {
		expect(qoderStatusForCode(99999)).toBe(502);
		expect(qoderStatusForCode(undefined)).toBe(502);
	});
});

// ---------------------------------------------------------------------------
// Streaming unwrap
// ---------------------------------------------------------------------------

describe("unwrapQoderSse", () => {
	it("re-emits plain OpenAI SSE with the sent model key", async () => {
		const response = streamOf([
			frame(contentChunk("he")),
			frame(contentChunk("llo")),
			frame({
				model: "auto",
				choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
			}),
			frame({
				model: "auto",
				choices: [],
				usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
			}),
			"data: [DONE]\n\n",
		]);

		const text = await readAll(unwrapQoderSse(response, { model: "qfmodel" }));
		const chunks = text
			.split("\n")
			.filter((l) => l.startsWith("data:"))
			.map((l) => l.slice(5).trim())
			.filter((l) => l && l !== "[DONE]")
			.map((l) => JSON.parse(l));
		expect(chunks).toHaveLength(4);
		for (const chunk of chunks) {
			expect(chunk.model).toBe("qfmodel");
		}
		expect(chunks[0].choices[0].delta.content).toBe("he");
		expect(chunks[3].usage.prompt_tokens).toBe(5);
		// The OpenAI emitter relies on the [DONE] marker to flush tool calls and
		// emit message_stop; the unwrap must supply it.
		expect(text.trimEnd().endsWith("data: [DONE]")).toBe(true);
	});

	it("does not duplicate a [DONE] the upstream already sent", async () => {
		const text = await readAll(
			unwrapQoderSse(streamOf([frame(contentChunk("x")), "data: [DONE]\n\n"]), {
				model: "qfmodel",
			}),
		);
		expect(text.match(/\[DONE\]/g)).toHaveLength(1);
	});

	it("drops keep-alive events and blank frames", async () => {
		const text = await readAll(
			unwrapQoderSse(
				streamOf([
					": keepalive\n\n",
					"event: ping\n\n",
					frame(contentChunk("x")),
					`data: ${JSON.stringify({ body: "", statusCodeValue: 200 })}\n\n`,
				]),
				{ model: "qfmodel" },
			),
		);
		const dataLines = text
			.split("\n")
			.filter((l) => l.startsWith("data:") && !l.includes("[DONE]"));
		expect(dataLines).toHaveLength(1);
	});

	it("surfaces an in-band error as an OpenAI error chunk and closes the stream", async () => {
		const text = await readAll(
			unwrapQoderSse(
				streamOf([
					frame(contentChunk("partial")),
					frame({ code: 116, error: "quota exceeded" }),
					frame(contentChunk("never")),
				]),
				{ model: "qfmodel" },
			),
		);
		expect(text).toContain('"error"');
		expect(text).toContain("[DONE]");
		expect(text).not.toContain("never");
		expect(text).toContain("partial");
	});

	it("emits a single error chunk when the very first frame fails", async () => {
		const text = await readAll(
			unwrapQoderSse(streamOf([frame({ code: 10605, error: "busy" })]), {
				model: "qfmodel",
			}),
		);
		const payloads = text
			.split("\n")
			.filter((l) => l.startsWith("data:") && !l.includes("[DONE]"))
			.map((l) => JSON.parse(l.slice(5)));
		expect(payloads).toHaveLength(1);
		expect(payloads[0].error.type).toBe("overloaded_error");
	});

	it("closes the stream on an abrupt end without [DONE]", async () => {
		const text = await readAll(
			unwrapQoderSse(streamOf([frame(contentChunk("a"))]), {
				model: "qfmodel",
			}),
		);
		expect(text).toContain('"content":"a"');
		expect(text).toContain("[DONE]");
	});

	it("keeps split SSE field lines together", async () => {
		// Multi-line data fields are not used by Qoder, but a frame split across
		// reads must still be reassembled; streamOf() slices every 37 chars.
		const text = await readAll(
			unwrapQoderSse(
				streamOf([
					frame(contentChunk("0123456789abcdef")),
					frame(contentChunk("ghijklmnopqrstuv")),
				]),
				{ model: "dfmodel" },
			),
		);
		expect(text).toContain("0123456789abcdef");
		expect(text).toContain("ghijklmnopqrstuv");
	});
});

// ---------------------------------------------------------------------------
// The end-to-end pairing: unwrap -> existing Anthropic emitter
// ---------------------------------------------------------------------------

describe("unwrapQoderSse -> transformStreamingResponse", () => {
	it("produces a well-formed Anthropic message with thinking before text", async () => {
		const response = streamOf([
			frame({
				model: "auto",
				choices: [{ index: 0, delta: { reasoning_content: "let me think. " } }],
			}),
			frame(contentChunk("ok")),
			frame({
				model: "auto",
				choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
			}),
			frame({
				model: "auto",
				choices: [],
				usage: {
					billable: false,
					credits: 0.000967,
					prompt_tokens: 68,
					completion_tokens: 30,
					total_tokens: 98,
				},
			}),
			"data: [DONE]\n\n",
		]);

		const anthropic = transformStreamingResponse(
			unwrapQoderSse(response, { model: "qfmodel" }),
			{ fallbackModel: "qfmodel" },
		);
		const events = parseAnthropicSse(await readAll(anthropic));

		const start = events.find((e) => e.type === "message_start");
		expect(start?.message).toBeDefined();
		expect((start?.message as { model?: string }).model).toBe("qfmodel");

		const types = events.map((e) => e.type);
		expect(types[0]).toBe("message_start");
		expect(types[types.length - 1]).toBe("message_stop");

		const thinking = events.find(
			(e) =>
				e.type === "content_block_delta" &&
				(e.delta as { type?: string }).type === "thinking_delta",
		);
		expect((thinking?.delta as { thinking?: string }).thinking).toBe(
			"let me think. ",
		);
		const text = events.find(
			(e) =>
				e.type === "content_block_delta" &&
				(e.delta as { type?: string }).type === "text_delta",
		);
		expect((text?.delta as { text?: string }).text).toBe("ok");

		const end = events.find((e) => e.type === "message_delta");
		const usage = (end as { usage?: { input_tokens?: number } } | undefined)
			?.usage;
		expect(usage?.input_tokens).toBe(68);
	});

	it("turns Qoder tool calls into an Anthropic tool_use block", async () => {
		const response = streamOf([
			frame({
				model: "auto",
				choices: [
					{
						index: 0,
						delta: {
							tool_calls: [
								{
									index: 0,
									id: "call_1",
									type: "function",
									function: { name: "Bash", arguments: "" },
								},
							],
						},
					},
				],
			}),
			frame({
				model: "auto",
				choices: [
					{
						index: 0,
						delta: {
							tool_calls: [{ index: 0, function: { arguments: '{"comm' } }],
						},
					},
				],
			}),
			frame({
				model: "auto",
				choices: [
					{
						index: 0,
						delta: {
							tool_calls: [{ index: 0, function: { arguments: 'and":"ls"}' } }],
						},
					},
				],
			}),
			frame({
				model: "auto",
				choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
			}),
			"data: [DONE]\n\n",
		]);

		const anthropic = transformStreamingResponse(
			unwrapQoderSse(response, { model: "qfmodel" }),
			{ fallbackModel: "qfmodel" },
		);
		const events = parseAnthropicSse(await readAll(anthropic));

		const blockStart = events.find(
			(e) =>
				e.type === "content_block_start" &&
				(e.content_block as { type?: string })?.type === "tool_use",
		);
		expect(blockStart).toBeDefined();
		const block = blockStart?.content_block as {
			id?: string;
			name?: string;
		};
		expect(block.name).toBe("Bash");
		expect(block.id).toBe("call_1");

		const jsonDelta = events.find(
			(e) =>
				e.type === "content_block_delta" &&
				(e.delta as { type?: string }).type === "input_json_delta",
		);
		expect((jsonDelta?.delta as { partial_json?: string }).partial_json).toBe(
			'{"command":"ls"}',
		);

		const end = events.find((e) => e.type === "message_delta");
		expect(
			(end as { delta?: { stop_reason?: string } })?.delta?.stop_reason,
		).toBe("tool_use");
	});

	// The shared emitter has no error-event path: it assumes every chunk is a
	// completion chunk. So an in-band failure must be caught BEFORE the emitter
	// — the provider reports it as a JSON error response (with a real HTTP
	// status) when nothing was generated, and logs it when content already went
	// out. See QoderProvider.processResponse.
	it("turns an immediate in-band error into an Anthropic error object", async () => {
		const message = await aggregateQoderSse(
			streamOf([frame({ code: 116, error: "quota exceeded" })]),
			"qfmodel",
		).catch((error: unknown) => error);
		expect(message).toBeInstanceOf(Error);
		expect(String(message)).toContain("quota");
		expect((message as Error & { status: number }).status).toBe(429);
	});
});

// ---------------------------------------------------------------------------
// Non-streaming aggregation
// ---------------------------------------------------------------------------

describe("aggregateQoderSse", () => {
	const fullStream = (): Response =>
		streamOf([
			frame({
				model: "auto",
				choices: [{ delta: { reasoning_content: "hmm" } }],
			}),
			frame(contentChunk("ok")),
			frame({
				model: "auto",
				choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
			}),
			frame({
				model: "auto",
				choices: [],
				usage: { billable: false, prompt_tokens: 68, completion_tokens: 30 },
			}),
			"data: [DONE]\n\n",
		]);

	it("assembles text, reasoning and usage into one Anthropic message", async () => {
		const message = await aggregateQoderSse(fullStream(), "qfmodel");
		expect(message.model).toBe("qfmodel");
		expect(message.content).toHaveLength(2);
		expect(message.content[0]).toMatchObject({
			type: "thinking",
			thinking: "hmm",
		});
		expect(message.content[1]).toEqual({ type: "text", text: "ok" });
		expect(message.usage?.input_tokens).toBe(68);
		expect(message.usage?.output_tokens).toBe(30);
		expect(message.stop_reason).toBe("end_turn");
	});

	it("assembles tool calls into tool_use blocks with parsed input", async () => {
		const response = streamOf([
			frame({
				model: "auto",
				choices: [
					{
						index: 0,
						delta: {
							tool_calls: [
								{
									index: 0,
									id: "call_1",
									type: "function",
									function: { name: "Read", arguments: "" },
								},
							],
						},
					},
				],
			}),
			frame({
				model: "auto",
				choices: [
					{
						index: 0,
						delta: {
							tool_calls: [
								{ index: 0, function: { arguments: '{"path":"a.ts"}' } },
							],
						},
					},
				],
			}),
			frame({
				model: "auto",
				choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
			}),
			"data: [DONE]\n\n",
		]);
		const message = await aggregateQoderSse(response, "qfmodel");
		expect(message.stop_reason).toBe("tool_use");
		expect(message.content).toEqual([
			{
				type: "tool_use",
				id: "call_1",
				name: "Read",
				input: { path: "a.ts" },
			},
		]);
	});

	it("throws a status-carrying error on an in-band failure", async () => {
		const response = streamOf([frame({ code: 10605, error: "busy" })]);
		let caught: unknown;
		try {
			await aggregateQoderSse(response, "qfmodel");
		} catch (error) {
			caught = error;
		}
		expect(caught).toBeInstanceOf(Error);
		expect((caught as Error & { status?: number }).status).toBe(503);
	});

	it("throws when the stream ends before the answer completes", async () => {
		const response = streamOf([frame(contentChunk("partial"))]);
		await expect(aggregateQoderSse(response, "qfmodel")).rejects.toThrow(
			/complete|ended/i,
		);
	});

	it("gives a reasoning model five minutes, not thirty seconds", () => {
		// The 30s cap turned a slow-but-healthy answer into a 502; the held-open
		// connection it guarded against is handled by the provider's peek.
		expect(QODER_AGGREGATE_TIMEOUT_MS).toBe(300_000);
	});

	it("cancels the upstream when the aggregation deadline passes", async () => {
		let cancelled = false;
		const encoder = new TextEncoder();
		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(encoder.encode(frame(contentChunk("partial"))));
				// The gateway holds the connection open: it never closes.
			},
			cancel() {
				cancelled = true;
			},
		});
		const response = new Response(body, {
			headers: { "content-type": "text/event-stream" },
		});
		await expect(
			aggregateQoderSse(response, "qfmodel", { timeoutMs: 50 }),
		).rejects.toThrow(/within 50ms/);
		// A whole-body read would have left the socket open: the body is read
		// through a reader precisely so it can be cancelled.
		expect(cancelled).toBe(true);
	});

	it("throws when the stream carries no choices at all", async () => {
		const response = streamOf(["data: [DONE]\n\n"]);
		await expect(aggregateQoderSse(response, "qfmodel")).rejects.toThrow(
			/empty/i,
		);
	});
});
