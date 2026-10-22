import {
	type AnthropicResponse,
	convertOpenAIResponseToAnthropic,
	type OpenAIMessage,
	type OpenAIResponse,
} from "@better-ccflare/openai-formats";

/**
 * Qoder gateway SSE -> plain OpenAI SSE.
 *
 * The gateway streams `data:` frames of `{headers, body, statusCodeValue,
 * statusCode}` where `body` is itself a JSON **string** holding a normal OpenAI
 * chat-completion chunk. The existing OpenAI->Anthropic emitter
 * (`transformStreamingResponse`) consumes plain OpenAI SSE, so this module only
 * has to re-shape: decode the envelope, rewrite the model, re-emit. Everything
 * downstream (thinking blocks, tool-call buffering, message_start/stop) is the
 * shared emitter's job. Reference: QODER_INTEGRATION.md §6.3.7.
 */

/** Qoder echoes `"auto"` for every request; it does not name the serving model. */
export interface UnwrapOptions {
	/** The wire key that was actually sent (qfmodel, dfmodel, ...). */
	model: string;
}

interface QoderEnvelope {
	body?: unknown;
	statusCodeValue?: unknown;
	statusCode?: unknown;
}

export interface QoderStreamError {
	status: number;
	message: string;
	code?: number;
	/** The envelope's own statusCodeValue, when it was the error's source. */
	upstreamStatus?: number;
}

type DecodedFrame =
	| { ok: true; chunk: OpenAIResponse }
	| { ok: false; error: QoderStreamError }
	| { ok: false; error: null; empty: true; done?: boolean };

/** Qoder's in-band codes, from the reference error table (§5.4). */
export function qoderStatusForCode(code: number | undefined): number {
	if (code === undefined) return 502;
	if (code === 105) return 401;
	if (code === 10605) return 503;
	if (code === 406 || code === 416 || code === 430) return 400;
	if (
		(code >= 110 && code <= 119) ||
		code === 122
	) {
		return 429;
	}
	if (code === 80411 || code === 80412) return 400;
	if (code >= 100400 && code <= 100403) return 400;
	return 502;
}

function openAIErrorType(status: number): string {
	switch (status) {
		case 401:
			return "authentication_error";
		case 429:
			return "rate_limit_error";
		case 400:
			return "invalid_request_error";
		case 503:
			return "overloaded_error";
		default:
			return "api_error";
	}
}

function errorText(body: unknown): string {
	if (typeof body === "string") return body.slice(0, 400);
	if (body && typeof body === "object") {
		const record = body as Record<string, unknown>;
		const nested =
			record.error && typeof record.error === "object"
				? (record.error as Record<string, unknown>).message
				: undefined;
		for (const value of [nested, record.error, record.message, record.msg]) {
			if (typeof value === "string" && value) return value.slice(0, 400);
		}
	}
	return "";
}

function numericCode(body: unknown): number | undefined {
	if (!body || typeof body !== "object") return undefined;
	const code = (body as Record<string, unknown>).code;
	return typeof code === "number" && Number.isFinite(code) ? code : undefined;
}

/**
 * Decode one SSE line of the Qoder stream. Returns `empty` for keep-alives,
 * comments and blank frames — normal, not errors.
 */
export function qoderFrameToOpenAIChunk(line: string): DecodedFrame {
	const trimmed = line.trim();
	if (!trimmed.startsWith("data:")) {
		return { ok: false, error: null, empty: true };
	}
	const payload = trimmed.slice("data:".length).trim();
	if (!payload) return { ok: false, error: null, empty: true };
	if (payload === "[DONE]") {
		return { ok: false, error: null, empty: true, done: true };
	}

	let envelope: QoderEnvelope;
	try {
		envelope = JSON.parse(payload) as QoderEnvelope;
	} catch {
		return { ok: false, error: null, empty: true };
	}
	if (!envelope || typeof envelope !== "object") {
		return { ok: false, error: null, empty: true };
	}

	const upstreamStatus =
		typeof envelope.statusCodeValue === "number"
			? envelope.statusCodeValue
			: typeof envelope.statusCode === "number"
				? envelope.statusCode
				: 200;
	if (upstreamStatus !== 200) {
		const inner =
			typeof envelope.body === "string"
				? tryParse(envelope.body)
				: envelope.body;
		const code = numericCode(inner);
		return {
			ok: false,
			error: {
				status:
					code !== undefined
						? qoderStatusForCode(code)
						: upstreamStatus >= 400
							? upstreamStatus
							: 502,
				message: errorText(inner) || errorText(envelope.body) || "Qoder error",
				upstreamStatus,
				...(code !== undefined ? { code } : {}),
			},
		};
	}

	let inner: unknown;
	try {
		inner = typeof envelope.body === "string" ? JSON.parse(envelope.body) : null;
	} catch {
		return { ok: false, error: null, empty: true };
	}
	if (!inner || typeof inner !== "object") {
		return { ok: false, error: null, empty: true };
	}

	// A 200 envelope can still carry an in-band error object. Qoder sends
	// `error` as an object on some paths and as a bare string on others.
	const record = inner as Record<string, unknown>;
	const hasError = record.error !== undefined && record.error !== null;
	if (hasError && !("choices" in record)) {
		const code = numericCode(record);
		return {
			ok: false,
			error: {
				status: qoderStatusForCode(code),
				message: errorText(record) || "Qoder error",
				...(code !== undefined ? { code } : {}),
			},
		};
	}

	return { ok: true, chunk: inner as OpenAIResponse };
}

function tryParse(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		return text;
	}
}

function encodeErrorChunk(error: QoderStreamError, model: string): string {
	const chunk = {
		id: `chatcmpl-qoder-error-${Date.now()}`,
		object: "chat.completion.chunk",
		model,
		choices: [],
		error: { type: openAIErrorType(error.status), message: error.message },
	};
	return `data: ${JSON.stringify(chunk)}\n\n`;
}

/** Re-emit a decoded frame as a plain OpenAI SSE event for one sent model. */
function encodeChunk(chunk: OpenAIResponse, model: string): string {
	const rewritten = { ...chunk, model };
	return `data: ${JSON.stringify(rewritten)}\n\n`;
}

/**
 * Wrap a Qoder SSE response so it reads as plain OpenAI SSE, with `[DONE]`
 * guaranteed and in-band errors surfaced as an OpenAI error chunk (the shared
 * emitter turns that into an Anthropic `error` event).
 */
export function unwrapQoderSse(
	response: Response,
	options: UnwrapOptions,
): Response {
	if (!response.body) return response;
	const { model } = options;
	const decoder = new TextDecoder();
	const encoder = new TextEncoder();

	// `finished`: the stream's outcome is decided (error, upstream [DONE], or
	// end). `doneSent`: the terminating [DONE] has been written. Both are needed
	// so a frame queued behind an error chunk is still discarded.
	let buffer = "";
	let finished = false;
	let doneSent = false;

	const terminate = (
		controller: TransformStreamDefaultController<Uint8Array>,
	) => {
		if (!doneSent) {
			doneSent = true;
			controller.enqueue(encoder.encode("data: [DONE]\n\n"));
		}
		finished = true;
	};

	const emitLines = (
		lines: string[],
		controller: TransformStreamDefaultController<Uint8Array>,
	) => {
		for (const line of lines) {
			if (finished) return;
			const decoded = qoderFrameToOpenAIChunk(line);
			if ("empty" in decoded) {
				// The gateway does not send [DONE]; if it ever does, honour it and
				// do not append a second one.
				if (decoded.done) terminate(controller);
				continue;
			}
			if (!decoded.ok) {
				controller.enqueue(encoder.encode(encodeErrorChunk(decoded.error, model)));
				terminate(controller);
				return;
			}
			controller.enqueue(encoder.encode(encodeChunk(decoded.chunk, model)));
		}
	};

	const body = response.body.pipeThrough(
		new TransformStream<Uint8Array, Uint8Array>({
			transform(chunk, controller) {
				if (finished) return;
				buffer += decoder.decode(chunk, { stream: true });
				const lines = buffer.split("\n");
				buffer = lines.pop() ?? "";
				emitLines(lines, controller);
			},
			flush(controller) {
				if (!finished && buffer.trim()) emitLines([buffer], controller);
				buffer = "";
				terminate(controller);
			},
		}),
	);

	return new Response(body, {
		status: response.status,
		statusText: response.statusText,
		headers: {
			"content-type": "text/event-stream; charset=utf-8",
			"cache-control": "no-cache",
		},
	});
}

function aggregateError(error: QoderStreamError): Error & { status: number } {
	const err = new Error(error.message) as Error & { status: number };
	err.status = error.status;
	return err;
}

/**
 * Collect a Qoder SSE body into one Anthropic message, for clients that asked
 * for JSON (Qoder is always asked to stream). Mirrors CodeBuddy's
 * `aggregateSseToJson`, reused through the shared response converter so the
 * text / thinking / tool_use assembly cannot drift from the streaming path.
 *
 * @throws Error carrying `.status` when the stream reports an in-band failure
 */
export async function aggregateQoderSse(
	response: Response,
	model: string,
): Promise<AnthropicResponse> {
	const text = await response.text();
	let responseId: string | undefined;
	let finishReason: string | undefined;
	let usage: OpenAIResponse["usage"];
	let content = "";
	let reasoning = "";
	let sawChoice = false;
	let sawDone = false;
	const toolCalls: NonNullable<OpenAIMessage["tool_calls"]> = [];
	const slots = new Map<number, number>();

	for (const line of text.split(/\r?\n/)) {
		const decoded = qoderFrameToOpenAIChunk(line);
		if ("empty" in decoded) {
			if (decoded.done) sawDone = true;
			continue;
		}
		if (!decoded.ok) throw aggregateError(decoded.error);

		const chunk = decoded.chunk;
		responseId ??= chunk.id;
		if (chunk.usage) usage = chunk.usage;
		const choice = chunk.choices?.[0];
		if (choice) sawChoice = true;
		if (choice?.finish_reason) finishReason = choice.finish_reason;
		const delta = choice?.delta;
		if (!delta) continue;

		const thinkingDelta =
			delta.reasoning_content ??
			(delta as { reasoning?: unknown }).reasoning;
		if (typeof thinkingDelta === "string") reasoning += thinkingDelta;
		if (typeof delta.content === "string") content += delta.content;

		for (const call of delta.tool_calls ?? []) {
			const index = typeof call.index === "number" ? call.index : 0;
			let slot = slots.get(index);
			if (slot === undefined) {
				slot = toolCalls.length;
				slots.set(index, slot);
				toolCalls.push({
					id: "",
					type: "function",
					function: { name: "", arguments: "" },
				});
			}
			const target = toolCalls[slot];
			if (call.id && !target.id) target.id = call.id;
			if (call.function?.name && !target.function.name) {
				target.function.name = call.function.name;
			}
			if (call.function?.arguments) {
				target.function.arguments += call.function.arguments;
			}
		}
	}

	if (!sawChoice) throw new Error("Qoder returned an empty stream");
	if (!finishReason && !sawDone) {
		throw new Error("Qoder stream ended before the answer was complete");
	}

	return convertOpenAIResponseToAnthropic(
		{
			id: responseId,
			model,
			usage,
			choices: [
				{
					finish_reason: finishReason,
					message: {
						role: "assistant",
						content,
						...(reasoning ? { reasoning_content: reasoning } : {}),
						...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
					},
				},
			],
		},
		model,
	);
}
