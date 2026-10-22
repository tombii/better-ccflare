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
	/** Called once when an in-band error ends the stream. */
	onError?: (error: QoderStreamError) => void;
	/** Called once when the upstream [DONE] marker is seen. */
	onDone?: () => void;
}

interface QoderEnvelope {
	headers?: unknown;
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
	/** Qoder's own hint (e.g. the busy queue's `retryAfterSeconds`). */
	retryAfterSeconds?: number;
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
	if ((code >= 110 && code <= 119) || code === 122) {
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

/**
 * Qoder's codes are usually numbers but the gateway sometimes stringifies
 * them, and nests its real payload one (or two) JSON layers deeper — a busy
 * response looks like `{code: "403", message: "{\"code\":\"10605\", …}"}`.
 */
function numericCode(body: unknown): number | undefined {
	if (!body || typeof body !== "object") return undefined;
	const raw = (body as Record<string, unknown>).code;
	if (typeof raw === "number" && Number.isFinite(raw)) return raw;
	if (typeof raw === "string" && /^\d+$/.test(raw)) return Number(raw);
	return undefined;
}

function countRetryAfter(...bodies: unknown[]): number | undefined {
	for (const body of bodies) {
		if (!body || typeof body !== "object") continue;
		const value = (body as Record<string, unknown>).retryAfterSeconds;
		if (typeof value === "number" && value > 0) return value;
	}
	return undefined;
}

/**
 * Unwrap the JSON-in-a-string layers Qoder wraps its error bodies in. The
 * decision fields (`code`, `retryAfterSeconds`, …) live at DIFFERENT levels —
 * the outermost layer carries `403`, the next `10605`, the innermost the queue
 * hint — so the layers are merged from the inside out, letting an inner layer
 * override an outer one. Each layer costs a JSON parse, so depth is bounded.
 */
function mergeErrorLayers(body: unknown, depth = 0): Record<string, unknown> {
	if (depth > 8) return {};
	if (typeof body === "string") {
		const parsed = tryParse(body);
		return parsed === body ? {} : mergeErrorLayers(parsed, depth + 1);
	}
	if (!body || typeof body !== "object" || Array.isArray(body)) return {};
	const record = body as Record<string, unknown>;
	const message = record.message;
	const inner =
		typeof message === "string"
			? mergeErrorLayers(tryParse(message), depth + 1)
			: {};
	return { ...record, ...inner };
}

/** Build a stream error from an envelope whose statusCodeValue is not 200. */
function errorFromEnvelope(
	envelope: QoderEnvelope,
	upstreamStatus: number,
): QoderStreamError {
	const outer =
		typeof envelope.body === "string" ? tryParse(envelope.body) : envelope.body;
	const merged = mergeErrorLayers(outer);
	const code = numericCode(merged) ?? numericCode(outer);
	const retryAfterSeconds =
		countRetryAfter(merged, outer) ?? retryAfterHeader(envelope);
	return {
		status: qoderStatusForCode(code),
		message: errorText(merged) || errorText(outer) || "Qoder error",
		upstreamStatus,
		...(code !== undefined ? { code } : {}),
		...(retryAfterSeconds !== undefined ? { retryAfterSeconds } : {}),
	};
}

function retryAfterHeader(envelope: QoderEnvelope): number | undefined {
	const headers = envelope.headers;
	if (!headers || typeof headers !== "object") return undefined;
	const raw = (headers as Record<string, unknown>)["Retry-After"];
	const value = Array.isArray(raw) ? raw[0] : raw;
	const n = Number(value);
	return Number.isFinite(n) && n > 0 ? n : undefined;
}

/**
 * An SSE frame nested inside a 200 one (the gateway does this for its 403
 * busy answer) carries its own statusCodeValue and body.
 */
function decodeEnvelopeStatus(inner: unknown): QoderStreamError | null {
	if (!inner || typeof inner !== "object") return null;
	const nested = inner as QoderEnvelope;
	const status =
		typeof nested.statusCodeValue === "number"
			? nested.statusCodeValue
			: typeof nested.statusCode === "number"
				? nested.statusCode
				: 200;
	if (status === 200) return null;
	return errorFromEnvelope(nested, status);
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
		return { ok: false, error: errorFromEnvelope(envelope, upstreamStatus) };
	}

	let inner: unknown;
	try {
		inner =
			typeof envelope.body === "string" ? JSON.parse(envelope.body) : null;
	} catch {
		return { ok: false, error: null, empty: true };
	}
	if (!inner || typeof inner !== "object") {
		return { ok: false, error: null, empty: true };
	}

	// A 200 envelope can still carry an in-band error: Qoder sends `error` as
	// an object on some paths and as a bare string on others, and wraps some
	// failures in another SSE frame whose own statusCodeValue is the error.
	const requestError = decodeEnvelopeStatus(inner);
	if (requestError) return { ok: false, error: requestError };
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
 * emitter ignores that chunk, which is why `onError` exists — the provider
 * turns an immediate failure into an error response before this point).
 *
 */
export function unwrapQoderSse(
	response: Response,
	options: UnwrapOptions,
): Response {
	if (!response.body) return response;
	const { model, onError, onDone } = options;
	const decoder = new TextDecoder();
	const encoder = new TextEncoder();

	// The undecoded remainder of the last line read.
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
			const frame = qoderFrameToOpenAIChunk(line);
			if ("empty" in frame) {
				// The gateway does not send [DONE]; if it ever does, honour it and
				// do not append a second one.
				if (frame.done) {
					onDone?.();
					terminate(controller);
				}
				continue;
			}
			if (!frame.ok) {
				onError?.(frame.error);
				controller.enqueue(
					encoder.encode(encodeErrorChunk(frame.error, model)),
				);
				terminate(controller);
				return;
			}
			controller.enqueue(encoder.encode(encodeChunk(frame.chunk, model)));
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

/**
 * Read a response body, giving up after `timeoutMs` (30s by default).
 *
 * The provider's outcome peek has already established that the stream opens
 * with content, so this read is waiting for the END of a healthy stream — but
 * the gateway is known to hold a connection open after an error frame, and a
 * non-streaming client must not be wedged by that.
 */
async function readBodyWithTimeout(
	response: Response,
	timeoutMs = 30_000,
): Promise<string> {
	if (!response.body) return "";
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<"TIMEOUT">((resolve) => {
		timer = setTimeout(() => resolve("TIMEOUT"), timeoutMs);
	});
	try {
		const result = await Promise.race([response.text(), timeout]);
		if (result === "TIMEOUT") {
			// Release the socket rather than leaving it open.
			void response.body.cancel().catch(() => {});
			throw new Error(
				`Qoder did not finish the response within ${timeoutMs}ms`,
			);
		}
		return result;
	} finally {
		if (timer) clearTimeout(timer);
	}
}

/** An aggregation failure carrying everything the provider reports on it. */
export class QoderAggregateError extends Error {
	readonly status: number;
	readonly code?: number;
	readonly retryAfterSeconds?: number;

	constructor(error: QoderStreamError) {
		super(error.message);
		this.name = "QoderAggregateError";
		this.status = error.status;
		if (error.code !== undefined) this.code = error.code;
		if (error.retryAfterSeconds !== undefined) {
			this.retryAfterSeconds = error.retryAfterSeconds;
		}
	}
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
	options?: { timeoutMs?: number },
): Promise<AnthropicResponse> {
	// Bounded: the gateway can hold the connection open after an error frame,
	// so a whole-body read must not be able to wait forever.
	const text = await readBodyWithTimeout(response, options?.timeoutMs);
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
		if (!decoded.ok) throw new QoderAggregateError(decoded.error);

		const chunk = decoded.chunk;
		responseId ??= chunk.id;
		if (chunk.usage) usage = chunk.usage;
		const choice = chunk.choices?.[0];
		if (choice) sawChoice = true;
		if (choice?.finish_reason) finishReason = choice.finish_reason;
		const delta = choice?.delta;
		if (!delta) continue;

		const thinkingDelta =
			delta.reasoning_content ?? (delta as { reasoning?: unknown }).reasoning;
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
