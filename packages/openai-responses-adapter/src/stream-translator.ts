import { Logger } from "@better-ccflare/logger";

const log = new Logger("openai-responses-adapter");

interface State {
	lineBuffer: string;
	hasSentCreated: boolean;
	responseId: string;
	model: string;
	outputIndex: number;
	sequenceNumber: number;
	blockIndexToOutput: Map<number, number>;
	textByBlock: Map<number, string>;
	toolByBlock: Map<number, { callId: string; name: string; argsBuf: string }>;
	inputTokens: number;
	outputTokens: number;
	doneSent: boolean;
	outputItems: Array<Record<string, unknown>>;
	streamError: { type: string; message: string } | null;
}

const encoder = new TextEncoder();

function emitSse(
	controller: TransformStreamDefaultController,
	eventType: string,
	data: unknown,
	state: State,
): void {
	const payload = Object.assign(
		{ sequence_number: state.sequenceNumber++ },
		data as object,
	);
	controller.enqueue(
		encoder.encode(`event: ${eventType}\ndata: ${JSON.stringify(payload)}\n\n`),
	);
}

function emitDone(
	controller: TransformStreamDefaultController,
	state: State,
): void {
	if (state.doneSent) return;
	state.doneSent = true;

	emitSse(
		controller,
		"response.completed",
		{
			type: "response.completed",
			response: {
				id: state.responseId,
				object: "response",
				created_at: Math.floor(Date.now() / 1000),
				model: state.model,
				status: "completed",
				output: state.outputItems,
				usage: {
					input_tokens: state.inputTokens,
					output_tokens: state.outputTokens,
					total_tokens: state.inputTokens + state.outputTokens,
				},
			},
		},
		state,
	);
}

function processEvent(
	eventType: string,
	data: Record<string, unknown>,
	controller: TransformStreamDefaultController,
	state: State,
): void {
	if (eventType === "message_start") {
		const message = data.message as Record<string, unknown> | undefined;
		const usage = message?.usage as Record<string, number> | undefined;
		if (usage) {
			state.inputTokens = usage.input_tokens ?? 0;
		}

		if (!state.hasSentCreated) {
			state.hasSentCreated = true;
			const createdAt = Math.floor(Date.now() / 1000);
			const responseShape = {
				id: state.responseId,
				object: "response",
				created_at: createdAt,
				model: state.model,
				status: "in_progress",
				output: [],
			};
			emitSse(
				controller,
				"response.created",
				{ type: "response.created", response: responseShape },
				state,
			);
			emitSse(
				controller,
				"response.in_progress",
				{ type: "response.in_progress", response: responseShape },
				state,
			);
		}
		return;
	}

	if (eventType === "content_block_start") {
		const blockIndex = data.index as number;
		const contentBlock = data.content_block as Record<string, unknown>;

		// Only allocate an output slot for block types we emit events for.
		// Incrementing unconditionally (e.g. for "thinking" blocks) leaves gaps in
		// output_index that confuse clients expecting a contiguous sequence.
		if (contentBlock.type !== "text" && contentBlock.type !== "tool_use") {
			return;
		}

		const outputIdx = state.outputIndex++;
		state.blockIndexToOutput.set(blockIndex, outputIdx);

		if (contentBlock.type === "text") {
			state.textByBlock.set(blockIndex, "");
			emitSse(
				controller,
				"response.output_item.added",
				{
					type: "response.output_item.added",
					output_index: outputIdx,
					item: {
						type: "message",
						id: `${state.responseId}_msg_${outputIdx}`,
						role: "assistant",
						content: [],
						status: "in_progress",
					},
				},
				state,
			);
			emitSse(
				controller,
				"response.content_part.added",
				{
					type: "response.content_part.added",
					item_id: `${state.responseId}_msg_${outputIdx}`,
					output_index: outputIdx,
					content_index: 0,
					part: { type: "output_text", text: "" },
				},
				state,
			);
		} else if (contentBlock.type === "tool_use") {
			state.toolByBlock.set(blockIndex, {
				callId: contentBlock.id as string,
				name: contentBlock.name as string,
				argsBuf: "",
			});
			emitSse(
				controller,
				"response.output_item.added",
				{
					type: "response.output_item.added",
					output_index: outputIdx,
					item: {
						type: "function_call",
						id: `${state.responseId}_fc_${outputIdx}`,
						call_id: contentBlock.id as string,
						name: contentBlock.name as string,
						arguments: "",
						status: "in_progress",
					},
				},
				state,
			);
		}
		return;
	}

	if (eventType === "content_block_delta") {
		const blockIndex = data.index as number;
		const delta = data.delta as Record<string, unknown>;
		const outputIdx = state.blockIndexToOutput.get(blockIndex);

		if (outputIdx === undefined) {
			log.warn(`content_block_delta for unknown block index ${blockIndex}`);
			return;
		}

		if (delta.type === "text_delta") {
			const text = delta.text as string;
			const current = state.textByBlock.get(blockIndex) ?? "";
			state.textByBlock.set(blockIndex, current + text);

			emitSse(
				controller,
				"response.output_text.delta",
				{
					type: "response.output_text.delta",
					item_id: `${state.responseId}_msg_${outputIdx}`,
					output_index: outputIdx,
					content_index: 0,
					delta: text,
				},
				state,
			);
		} else if (delta.type === "input_json_delta") {
			const partial = (delta.partial_json as string) ?? "";
			const tool = state.toolByBlock.get(blockIndex);
			if (tool) {
				tool.argsBuf += partial;
				emitSse(
					controller,
					"response.function_call_arguments.delta",
					{
						type: "response.function_call_arguments.delta",
						item_id: `${state.responseId}_fc_${outputIdx}`,
						output_index: outputIdx,
						call_id: tool.callId,
						delta: partial,
					},
					state,
				);
			}
		}
		return;
	}

	if (eventType === "content_block_stop") {
		const blockIndex = data.index as number;
		const outputIdx = state.blockIndexToOutput.get(blockIndex);

		if (outputIdx === undefined) {
			log.warn(`content_block_stop for unknown block index ${blockIndex}`);
			return;
		}

		if (state.textByBlock.has(blockIndex)) {
			const fullText = state.textByBlock.get(blockIndex) ?? "";
			emitSse(
				controller,
				"response.output_text.done",
				{
					type: "response.output_text.done",
					item_id: `${state.responseId}_msg_${outputIdx}`,
					output_index: outputIdx,
					content_index: 0,
					text: fullText,
				},
				state,
			);
			emitSse(
				controller,
				"response.content_part.done",
				{
					type: "response.content_part.done",
					item_id: `${state.responseId}_msg_${outputIdx}`,
					output_index: outputIdx,
					content_index: 0,
					part: { type: "output_text", text: fullText },
				},
				state,
			);
			const doneItem: Record<string, unknown> = {
				type: "message",
				id: `${state.responseId}_msg_${outputIdx}`,
				role: "assistant",
				content: [{ type: "output_text", text: fullText }],
				status: "completed",
			};
			state.outputItems.push(doneItem);
			emitSse(
				controller,
				"response.output_item.done",
				{
					type: "response.output_item.done",
					output_index: outputIdx,
					item: doneItem,
				},
				state,
			);
		} else if (state.toolByBlock.has(blockIndex)) {
			const tool = state.toolByBlock.get(blockIndex)!;
			emitSse(
				controller,
				"response.function_call_arguments.done",
				{
					type: "response.function_call_arguments.done",
					item_id: `${state.responseId}_fc_${outputIdx}`,
					output_index: outputIdx,
					call_id: tool.callId,
					name: tool.name,
					arguments: tool.argsBuf,
				},
				state,
			);
			const doneItem: Record<string, unknown> = {
				type: "function_call",
				id: `${state.responseId}_fc_${outputIdx}`,
				call_id: tool.callId,
				name: tool.name,
				arguments: tool.argsBuf,
				status: "completed",
			};
			state.outputItems.push(doneItem);
			emitSse(
				controller,
				"response.output_item.done",
				{
					type: "response.output_item.done",
					output_index: outputIdx,
					item: doneItem,
				},
				state,
			);
		}
		return;
	}

	if (eventType === "message_delta") {
		const usage = data.usage as Record<string, number> | undefined;
		if (usage) {
			state.outputTokens = usage.output_tokens ?? 0;
		}
		return;
	}

	if (eventType === "message_stop") {
		emitDone(controller, state);
		return;
	}

	if (eventType === "error") {
		const err = data.error as Record<string, unknown> | undefined;
		const errType = (err?.type as string) ?? "api_error";
		const errMsg =
			(err?.message as string) ?? "An error occurred during streaming";
		state.streamError = { type: errType, message: errMsg };
		state.doneSent = true;
		emitSse(
			controller,
			"response.failed",
			{
				type: "response.failed",
				response: {
					id: state.responseId,
					object: "response",
					created_at: Math.floor(Date.now() / 1000),
					model: state.model,
					status: "failed",
					error: { code: errType, message: errMsg },
					output: state.outputItems,
					usage: {
						input_tokens: state.inputTokens,
						output_tokens: state.outputTokens,
						total_tokens: state.inputTokens + state.outputTokens,
					},
				},
			},
			state,
		);
		return;
	}
}

function parseAndProcessChunk(
	chunk: string,
	controller: TransformStreamDefaultController,
	state: State,
): void {
	// Split on double newline to get complete SSE events
	const rawEvents = chunk.split("\n\n");

	for (const rawEvent of rawEvents) {
		if (!rawEvent.trim()) continue;

		const lines = rawEvent.split("\n");
		let eventType = "";
		let dataStr = "";

		for (const line of lines) {
			if (line.startsWith("event: ")) {
				eventType = line.slice(7).trim();
			} else if (line.startsWith("data: ")) {
				dataStr = line.slice(6).trim();
			}
		}

		if (!eventType || !dataStr) continue;

		try {
			const data = JSON.parse(dataStr) as Record<string, unknown>;
			processEvent(eventType, data, controller, state);
		} catch {
			log.warn(
				`Failed to parse SSE data for event ${eventType}: ${dataStr.slice(0, 200)}`,
			);
		}
	}
}

export function translateAnthropicStreamToResponses(
	anthropicResponse: Response,
	responseId: string,
	model: string,
): Response {
	if (!anthropicResponse.body) {
		return new Response(null, { status: anthropicResponse.status });
	}

	// Per-request decoder: TextDecoder is stateful (buffers incomplete UTF-8
	// sequences across chunks), so a shared singleton would corrupt concurrent streams.
	const decoder = new TextDecoder();

	const state: State = {
		lineBuffer: "",
		hasSentCreated: false,
		responseId,
		model,
		outputIndex: 0,
		sequenceNumber: 0,
		blockIndexToOutput: new Map(),
		textByBlock: new Map(),
		toolByBlock: new Map(),
		inputTokens: 0,
		outputTokens: 0,
		doneSent: false,
		outputItems: [],
		streamError: null,
	};

	const transformedBody = anthropicResponse.body.pipeThrough(
		new TransformStream<Uint8Array, Uint8Array>({
			transform(chunk, controller) {
				try {
					state.lineBuffer += decoder.decode(chunk, { stream: true });

					// Process complete events (delimited by \n\n), keep remainder in buffer
					const lastDoubleNewline = state.lineBuffer.lastIndexOf("\n\n");
					if (lastDoubleNewline === -1) return;

					const complete = state.lineBuffer.slice(0, lastDoubleNewline + 2);
					state.lineBuffer = state.lineBuffer.slice(lastDoubleNewline + 2);

					parseAndProcessChunk(complete, controller, state);
				} catch (err) {
					log.warn(`Stream transform error: ${String(err)}`);
				}
			},

			flush(controller) {
				try {
					// Flush remaining buffered UTF-8 bytes and release decoder's internal buffer
					const remaining = decoder.decode();
					if (remaining) state.lineBuffer += remaining;

					// Process any remaining buffered content
					if (state.lineBuffer.trim()) {
						parseAndProcessChunk(`${state.lineBuffer}\n\n`, controller, state);
						state.lineBuffer = "";
					}
					// Ensure done event is always emitted
					emitDone(controller, state);
				} catch (err) {
					log.warn(`Stream flush error: ${String(err)}`);
				}
			},
		}),
	);

	return new Response(transformedBody, {
		status: anthropicResponse.status,
		headers: {
			"Content-Type": "text/event-stream",
			"Cache-Control": "no-cache",
			Connection: "keep-alive",
		},
	});
}
