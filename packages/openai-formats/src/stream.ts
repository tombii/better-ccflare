import { ANALYTICS_STREAM_SYMBOL } from "@better-ccflare/http-common/symbols";
import { Logger } from "@better-ccflare/logger";
import type { TransformStreamContext } from "./types";
import { repairTruncatedToolJson } from "./utils";

const log = new Logger("openai-formats");

/**
 * Sanitize headers by removing provider-specific headers
 */
export function sanitizeHeaders(headers: Headers): Headers {
	const sanitized = new Headers();

	for (const [key, value] of headers.entries()) {
		// Skip provider-specific headers
		if (
			!key.startsWith("x-ratelimit-") &&
			!key.startsWith("openai-") &&
			key !== "access-control-expose-headers"
		) {
			sanitized.set(key, value);
		}
	}

	// Add back important headers that should be preserved
	sanitized.set(
		"content-type",
		headers.get("content-type") || "application/json",
	);

	return sanitized;
}

/**
 * Emit a single content_block_delta event with the complete accumulated JSON.
 * Mirrors qwen-code's StreamingToolCallParser: buffer all chunks, emit at stream end.
 */
function emitToolCallJson(
	controller: TransformStreamDefaultController,
	encoder: TextEncoder,
	index: number,
	accumulated: string,
) {
	const repair = repairTruncatedToolJson(accumulated);
	const finalJson = accumulated + repair;

	// Validate the result is parseable JSON
	try {
		JSON.parse(finalJson);
	} catch {
		log.warn(
			`Tool call JSON at index ${index} still invalid after repair: ${finalJson.slice(0, 200)}`,
		);
	}

	const contentBlockDelta = {
		type: "content_block_delta",
		index,
		delta: {
			type: "input_json_delta",
			partial_json: finalJson,
		},
	};
	controller.enqueue(encoder.encode(`event: content_block_delta\n`));
	controller.enqueue(
		encoder.encode(`data: ${JSON.stringify(contentBlockDelta)}\n\n`),
	);
}

/**
 * Emit content_block_stop, message_delta, and message_stop events.
 * Shared between [DONE] handler and flush handler.
 */
function emitStreamEnd(
	controller: TransformStreamDefaultController,
	encoder: TextEncoder,
	stopReason: "tool_use" | "end_turn",
	promptTokens: number,
	completionTokens: number,
	toolCallAccumulators: Record<number, string> | null,
	cacheReadInputTokens: number,
	cacheCreationInputTokens: number,
) {
	// Send content_block_stop for all blocks
	if (toolCallAccumulators) {
		// Tool call blocks
		for (const idx in toolCallAccumulators) {
			const numIdx = Number.parseInt(idx, 10);
			const contentBlockStop = {
				type: "content_block_stop",
				index: numIdx,
			};
			controller.enqueue(
				encoder.encode(`event: content_block_stop
`),
			);
			controller.enqueue(
				encoder.encode(`data: ${JSON.stringify(contentBlockStop)}

`),
			);
		}
	} else if (stopReason === "end_turn") {
		// Text block at index 0
		const contentBlockStop = {
			type: "content_block_stop",
			index: 0,
		};
		controller.enqueue(
			encoder.encode(`event: content_block_stop
`),
		);
		controller.enqueue(
			encoder.encode(`data: ${JSON.stringify(contentBlockStop)}

`),
		);
	}

	// Send message_delta with appropriate stop_reason
	const messageDelta = {
		type: "message_delta",
		delta: {
			stop_reason: stopReason,
			stop_sequence: null,
		},
		usage: {
			input_tokens: promptTokens,
			output_tokens: completionTokens,
			cache_read_input_tokens: cacheReadInputTokens,
			cache_creation_input_tokens: cacheCreationInputTokens,
		},
	};
	controller.enqueue(encoder.encode(`event: message_delta\n`));
	controller.enqueue(
		encoder.encode(`data: ${JSON.stringify(messageDelta)}\n\n`),
	);

	// Send message_stop
	const messageStop = {
		type: "message_stop",
	};
	controller.enqueue(encoder.encode(`event: message_stop\n`));
	controller.enqueue(
		encoder.encode(`data: ${JSON.stringify(messageStop)}\n\n`),
	);
}

/**
 * Transform OpenAI Server-Sent Events (SSE) streaming response to Anthropic SSE format.
 *
 * Tool call handling mirrors qwen-code's StreamingToolCallParser:
 * ALL argument chunks are buffered (appended), no deltas are emitted during streaming.
 * The complete accumulated JSON is emitted as a single input_json_delta at [DONE] or flush.
 */
export function transformStreamingResponse(response: Response): Response {
	if (!response.body) {
		return response;
	}

	const encoder = new TextEncoder();
	const decoder = new TextDecoder();

	// Use pipeThrough to transform the stream while preserving clonability
	const transformedBody = response.body.pipeThrough(
		new TransformStream<Uint8Array, Uint8Array>({
			start(_controller) {
				// Initialize context object for streaming state
				(this as any).context = {
					buffer: "",
					hasStarted: false,
					extractedModel: "unknown",
					hasSentStart: false,
					hasSentContentBlockStart: false,
					promptTokens: 0,
					completionTokens: 0,
					cacheReadInputTokens: 0,
					cacheCreationInputTokens: 0,
					encounteredToolCall: false,
					toolCallAccumulators: {},
					maxToolCallLength: 1_000_000,
					maxToolCallIndex: 100,
				} as TransformStreamContext;
			},
			transform(chunk, controller) {
				try {
					const context = (this as any).context as TransformStreamContext;
					if (!context) {
						log.error("TransformStream context not initialized");
						return;
					}
					// Decode the chunk and add to buffer
					context.buffer += decoder.decode(chunk, { stream: true });
					const lines = context.buffer.split("\n");
					// Keep incomplete line in buffer
					context.buffer = lines.pop() || "";

					for (const line of lines) {
						const trimmed = line.trim();
						if (!trimmed?.startsWith("data:")) continue;

						const dataStr = trimmed.slice(5).trim();

						// Handle [DONE] marker
						if (dataStr === "[DONE]") {
							if (context.encounteredToolCall) {
								// Emit buffered JSON for all tool calls, then stop events
								for (const idx in context.toolCallAccumulators) {
									const numIdx = Number.parseInt(idx, 10);
									const accumulated =
										context.toolCallAccumulators[numIdx] || "";
									emitToolCallJson(controller, encoder, numIdx, accumulated);
								}
								emitStreamEnd(
									controller,
									encoder,
									"tool_use",
									context.promptTokens,
									context.completionTokens,
									context.toolCallAccumulators,
									context.cacheReadInputTokens,
									context.cacheCreationInputTokens,
								);
							} else if (context.hasSentContentBlockStart) {
								emitStreamEnd(
									controller,
									encoder,
									"end_turn",
									context.promptTokens,
									context.completionTokens,
									null,
									context.cacheReadInputTokens,
									context.cacheCreationInputTokens,
								);
							}

							// Cleanup entire context after stream completion
							(this as any).context = null;
							continue;
						}

						// Parse OpenAI chunk
						try {
							const data = JSON.parse(dataStr);

							// Extract model from first chunk
							if (!context.hasStarted && data.model) {
								context.extractedModel = data.model;
								context.hasStarted = true;
							}

							// Extract usage data if present (typically in last chunk before [DONE])
							if (data.usage) {
								if (data.usage.prompt_tokens) {
									context.promptTokens = data.usage.prompt_tokens;
								}
								if (data.usage.completion_tokens) {
									context.completionTokens = data.usage.completion_tokens;
								}
								// Extract cache statistics from prompt_tokens_details (Qwen/DashScope)
								if (data.usage.prompt_tokens_details) {
									const details = data.usage.prompt_tokens_details as {
										cache_creation_input_tokens?: number;
										cached_tokens?: number;
									};
									if (details.cache_creation_input_tokens) {
										context.cacheCreationInputTokens =
											details.cache_creation_input_tokens;
									}
									if (details.cached_tokens) {
										context.cacheReadInputTokens = details.cached_tokens;
									}
								}
							}

							// Send message_start on first chunk
							if (!context.hasSentStart) {
								context.hasSentStart = true;
								const messageStart = {
									type: "message_start",
									message: {
										id: `msg_${Date.now()}`,
										type: "message",
										role: "assistant",
										content: [],
										model: context.extractedModel,
										stop_reason: null,
										stop_sequence: null,
										usage: {
											input_tokens: 0,
											output_tokens: 0,
										},
									},
								};
								controller.enqueue(encoder.encode(`event: message_start\n`));
								controller.enqueue(
									encoder.encode(`data: ${JSON.stringify(messageStart)}\n\n`),
								);

								// Send ping
								const ping = { type: "ping" };
								controller.enqueue(encoder.encode(`event: ping\n`));
								controller.enqueue(
									encoder.encode(`data: ${JSON.stringify(ping)}\n\n`),
								);
							}

							const delta = data.choices?.[0]?.delta;

							// Handle tool call deltas — always buffer, never emit
							if (delta?.tool_calls) {
								for (const toolCall of delta.tool_calls) {
									context.encounteredToolCall = true;
									const idx = toolCall.index;

									// Validate tool call index bounds
									if (
										typeof idx !== "number" ||
										idx < 0 ||
										idx >= context.maxToolCallIndex
									) {
										log.warn(
											`Invalid tool call index: ${idx} (max: ${context.maxToolCallIndex})`,
										);
										continue;
									}

									// Send content_block_start on first tool call chunk
									if (context.toolCallAccumulators[idx] === undefined) {
										if (!toolCall.id || !toolCall.function?.name) {
											log.warn(
												`Missing tool call id or name for index: ${idx}`,
											);
											continue;
										}
										context.toolCallAccumulators[idx] = "";
										const contentBlockStart = {
											type: "content_block_start",
											index: idx,
											content_block: {
												type: "tool_use",
												id: toolCall.id,
												name: toolCall.function.name,
												input: {},
											},
										};
										controller.enqueue(
											encoder.encode(`event: content_block_start\n`),
										);
										controller.enqueue(
											encoder.encode(
												`data: ${JSON.stringify(contentBlockStart)}\n\n`,
											),
										);
									}

									// Buffer argument chunk (mirrors qwen-code's StreamingToolCallParser:
									// currentBuffer + chunk, emit complete JSON at stream end)
									const newArgs = toolCall.function?.arguments || "";
									if (newArgs.length > context.maxToolCallLength) {
										log.warn(
											`Tool call arguments exceed max length for index ${idx} (${newArgs.length}/${context.maxToolCallLength})`,
										);
										continue;
									}
									context.toolCallAccumulators[idx] =
										(context.toolCallAccumulators[idx] || "") + newArgs;
								}
							} else if (delta?.content) {
								// Send content_block_start on first content
								if (!context.hasSentContentBlockStart) {
									context.hasSentContentBlockStart = true;
									const contentBlockStart = {
										type: "content_block_start",
										index: 0,
										content_block: {
											type: "text",
											text: "",
										},
									};
									controller.enqueue(
										encoder.encode(`event: content_block_start\n`),
									);
									controller.enqueue(
										encoder.encode(
											`data: ${JSON.stringify(contentBlockStart)}\n\n`,
										),
									);
								}

								// Send content delta
								const contentBlockDelta = {
									type: "content_block_delta",
									index: 0,
									delta: {
										type: "text_delta",
										text: delta.content,
									},
								};
								controller.enqueue(
									encoder.encode(`event: content_block_delta\n`),
								);
								controller.enqueue(
									encoder.encode(
										`data: ${JSON.stringify(contentBlockDelta)}\n\n`,
									),
								);
							}
						} catch (_parseError) {
							// Ignore JSON parse errors for malformed chunks
						}
					}
				} catch (error) {
					log.error("Error in transform:", error);
				}
			},
			flush(controller) {
				const context = (this as any).context as TransformStreamContext;
				if (!context) return;

				// Stream ended without [DONE] (e.g. timeout/truncation).
				// Emit buffered JSON + stop events so the client gets a valid response.
				if (
					context.encounteredToolCall &&
					Object.keys(context.toolCallAccumulators).length > 0
				) {
					log.warn(
						"Stream terminated without [DONE] — emitting buffered tool calls + stop events",
					);
					for (const idx in context.toolCallAccumulators) {
						const numIdx = Number.parseInt(idx, 10);
						const accumulated = context.toolCallAccumulators[numIdx] || "";
						emitToolCallJson(controller, encoder, numIdx, accumulated);
					}
					emitStreamEnd(
						controller,
						encoder,
						"tool_use",
						context.promptTokens,
						context.completionTokens,
						context.toolCallAccumulators,
						context.cacheReadInputTokens,
						context.cacheCreationInputTokens,
					);
				} else if (
					context.hasSentContentBlockStart &&
					!context.encounteredToolCall
				) {
					log.warn("Stream terminated without [DONE] — closing text block");
					emitStreamEnd(
						controller,
						encoder,
						"end_turn",
						context.promptTokens,
						context.completionTokens,
						null,
						context.cacheReadInputTokens,
						context.cacheCreationInputTokens,
					);
				}

				(this as any).context = null;
			},
		}),
	);

	// Tee the transformed stream into two independent streams
	const [clientStream, analyticsStream] = transformedBody.tee();

	// Create the response that will be returned to the client
	const clientResponse = new Response(clientStream, {
		status: response.status,
		statusText: response.statusText,
		headers: sanitizeHeaders(response.headers),
	});

	// Attach the analytics stream as a non-enumerable Symbol property
	Object.defineProperty(clientResponse, ANALYTICS_STREAM_SYMBOL, {
		value: analyticsStream,
		writable: false,
		enumerable: false,
		configurable: false,
	});

	return clientResponse;
}
