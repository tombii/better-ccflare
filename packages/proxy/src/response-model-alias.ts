const encoder = new TextEncoder();

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Present an Anthropic Messages response under the model id the client used.
 * This is a wire-compatibility alias only; upstream accounting keeps the
 * provider's original response before this client-facing transform.
 */
export function rewriteAnthropicMessageJsonModel(
	body: string,
	requestedModel: string,
): string {
	try {
		const parsed: unknown = JSON.parse(body);
		if (
			!isRecord(parsed) ||
			parsed.type !== "message" ||
			typeof parsed.model !== "string"
		) {
			return body;
		}
		parsed.model = requestedModel;
		return JSON.stringify(parsed);
	} catch {
		return body;
	}
}

function rewriteSseEvent(event: string, requestedModel: string): string {
	const newline = event.includes("\r\n") ? "\r\n" : "\n";
	const lines = event.split(newline);
	const eventName = lines
		.find((line) => line.startsWith("event:"))
		?.slice("event:".length)
		.trim();
	if (eventName !== "message_start") return event;

	const dataIndexes = lines
		.map((line, index) => (line.startsWith("data:") ? index : -1))
		.filter((index) => index >= 0);
	if (dataIndexes.length !== 1) return event;

	const dataIndex = dataIndexes[0];
	const line = lines[dataIndex];
	const prefixMatch = /^data:\s?/.exec(line);
	if (!prefixMatch) return event;
	const prefix = prefixMatch[0];

	try {
		const parsed: unknown = JSON.parse(line.slice(prefix.length));
		if (
			!isRecord(parsed) ||
			parsed.type !== "message_start" ||
			!isRecord(parsed.message) ||
			parsed.message.type !== "message" ||
			typeof parsed.message.model !== "string"
		) {
			return event;
		}
		parsed.message.model = requestedModel;
		lines[dataIndex] = `${prefix}${JSON.stringify(parsed)}`;
		return lines.join(newline);
	} catch {
		return event;
	}
}

/** Rewrite only the Message.model inside Anthropic's message_start SSE event. */
export function rewriteAnthropicMessageSseModel(
	upstream: ReadableStream<Uint8Array>,
	requestedModel: string,
): ReadableStream<Uint8Array> {
	const reader = upstream.getReader();
	let buffered = new Uint8Array();
	let finished = false;

	const append = (chunk: Uint8Array): void => {
		const combined = new Uint8Array(buffered.length + chunk.length);
		combined.set(buffered);
		combined.set(chunk, buffered.length);
		buffered = combined;
	};

	const findDelimiter = (): { index: number; length: number } | null => {
		for (let index = 0; index < buffered.length - 1; index++) {
			if (buffered[index] !== 10) continue;
			if (buffered[index + 1] === 10) return { index, length: 2 };
			if (
				index >= 1 &&
				buffered[index - 1] === 13 &&
				buffered[index + 1] === 13 &&
				buffered[index + 2] === 10
			) {
				return { index: index - 1, length: 4 };
			}
		}
		return null;
	};

	const flushNextEvent = (
		controller: ReadableStreamDefaultController<Uint8Array>,
	): "none" | "emitted" | "finished" => {
		const delimiter = findDelimiter();
		if (!delimiter) return "none";

		const eventBytes = buffered.slice(0, delimiter.index);
		const delimiterBytes = buffered.slice(
			delimiter.index,
			delimiter.index + delimiter.length,
		);
		buffered = buffered.slice(delimiter.index + delimiter.length);
		const event = new TextDecoder().decode(eventBytes);
		const rewritten = rewriteSseEvent(event, requestedModel);
		controller.enqueue(
			rewritten === event ? eventBytes : encoder.encode(rewritten),
		);
		controller.enqueue(delimiterBytes);
		if (rewritten === event) return "emitted";

		// Once message_start is rewritten, every subsequent upstream byte is
		// opaque pass-through. Flush the already-read suffix as bytes rather than
		// text so an incomplete multibyte UTF-8 sequence cannot be corrupted.
		finished = true;
		if (buffered.length > 0) {
			controller.enqueue(buffered);
			buffered = new Uint8Array();
		}
		return "finished";
	};

	return new ReadableStream<Uint8Array>({
		async pull(controller) {
			try {
				if (finished) {
					const { value, done } = await reader.read();
					if (done) {
						controller.close();
						reader.releaseLock();
					} else {
						controller.enqueue(value);
					}
					return;
				}

				while (true) {
					const flushed = flushNextEvent(controller);
					if (flushed !== "none") return;
					if (buffered.length > 64 * 1024) {
						finished = true;
						controller.enqueue(buffered);
						buffered = new Uint8Array();
						return;
					}

					const { value, done } = await reader.read();
					if (done) {
						if (buffered.length > 0) controller.enqueue(buffered);
						buffered = new Uint8Array();
						controller.close();
						reader.releaseLock();
						return;
					}
					append(value);
				}
			} catch (error) {
				controller.error(error);
				reader.releaseLock();
			}
		},
		cancel(reason) {
			return reader.cancel(reason).finally(() => reader.releaseLock());
		},
	});
}

/**
 * Buffer one non-streaming response, then rewrite only a valid Message object.
 * JSON cannot be safely changed before the complete object is available, so
 * this intentionally retains the response body just as Response.json() would.
 */
export function rewriteAnthropicMessageJsonModelStream(
	upstream: ReadableStream<Uint8Array>,
	requestedModel: string,
): ReadableStream<Uint8Array> {
	const reader = upstream.getReader();
	let chunks: Uint8Array[] = [];
	let totalBytes = 0;
	let settled = false;

	return new ReadableStream<Uint8Array>({
		async pull(controller) {
			if (settled) return;
			try {
				while (true) {
					const { value, done } = await reader.read();
					if (settled) return;
					if (done) break;
					chunks.push(value);
					totalBytes += value.length;
				}
				settled = true;
				reader.releaseLock();
				const bodyBytes = new Uint8Array(totalBytes);
				let offset = 0;
				for (const chunk of chunks) {
					bodyBytes.set(chunk, offset);
					offset += chunk.length;
				}
				chunks = [];
				totalBytes = 0;
				const body = new TextDecoder().decode(bodyBytes);
				controller.enqueue(
					encoder.encode(
						rewriteAnthropicMessageJsonModel(body, requestedModel),
					),
				);
				controller.close();
			} catch (error) {
				settled = true;
				reader.releaseLock();
				controller.error(error);
			}
		},
		async cancel(reason) {
			if (settled) return;
			settled = true;
			chunks = [];
			totalBytes = 0;
			try {
				await reader.cancel(reason);
			} finally {
				reader.releaseLock();
			}
		},
	});
}
