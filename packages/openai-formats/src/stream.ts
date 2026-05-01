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
 *
 * @param toolCallBlockIndices - Maps OpenAI tool_call delta index → Anthropic block index.
 *   Pass null when stopReason is "end_turn" (text-only response).
 * @param textBlockIndex - Anthropic block index used for the text content block.
 *   Only used when stopReason is "end_turn".
 */
function emitStreamEnd(
	controller: TransformStreamDefaultController,
	encoder: TextEncoder,
	stopReason: "tool_use" | "end_turn",
	promptTokens: number,
	completionTokens: number,
	toolCallBlockIndices: Record<number, number> | null,
	cacheReadInputTokens: number,
	cacheCreationInputTokens: number,
	textBlockIndex = 0,
) {
	// Send content_block_stop for all blocks
	if (toolCallBlockIndices) {
		// Tool call blocks — use Anthropic block indices (not OpenAI tool_call indices)
		for (const anthropicIdx of Object.values(toolCallBlockIndices)) {
			const contentBlockStop = {
				type: "content_block_stop",
				index: anthropicIdx,
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
		// Text block — use the assigned Anthropic block index
		const contentBlockStop = {
			type: "content_block_stop",
			index: textBlockIndex,
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
					hasSentThinkingBlockStart: false,
					thinkingBlockClosed: false,
					textBlockClosed: false,
					thinkingBlockIndex: 0,
					textBlockIndex: 0,
					promptTokens: 0,
					completionTokens: 0,
					cacheReadInputTokens: 0,
					cacheCreationInputTokens: 0,
					encounteredToolCall: false,
					toolCallAccumulators: {},
					nextBlockIndex: 0,
					toolCallBlockIndices: {},
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
								// Emit buffered JSON for all tool calls, then stop events.
								// Use Anthropic block indices (from toolCallBlockIndices), not OpenAI tool_call indices.
								for (const [openaiIdx, anthropicIdx] of Object.entries(
									context.toolCallBlockIndices,
								)) {
									const numIdx = Number.parseInt(openaiIdx, 10);
									const accumulated =
										context.toolCallAccumulators[numIdx] || "";
									emitToolCallJson(
										controller,
										encoder,
										anthropicIdx,
										accumulated,
									);
								}
								emitStreamEnd(
									controller,
									encoder,
									"tool_use",
									context.promptTokens,
									context.completionTokens,
									context.toolCallBlockIndices,
									context.cacheReadInputTokens,
									context.cacheCreationInputTokens,
								);
							} else if (context.hasSentContentBlockStart) {
								// If text block was closed mid-stream (content→thinking transition),
								// close the thinking block instead
								const lastBlockIndex =
									context.textBlockClosed
										? context.thinkingBlockIndex
										: context.textBlockIndex;
								emitStreamEnd(
									controller,
									encoder,
									"end_turn",
									context.promptTokens,
									context.completionTokens,
									null,
									context.cacheReadInputTokens,
									context.cacheCreationInputTokens,
									lastBlockIndex,
								);
							} else if (context.hasSentThinkingBlockStart) {
								// Reasoning-only stream: emitStreamEnd closes block via end_turn branch
								emitStreamEnd(
									controller,
									encoder,
									"end_turn",
									context.promptTokens,
									context.completionTokens,
									null,
									context.cacheReadInputTokens,
									context.cacheCreationInputTokens,
									context.thinkingBlockIndex,
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

									// Send content_block_start on first tool call chunk.
									// Assign a monotonic Anthropic block index — do NOT reuse the
									// OpenAI tool_call delta index, which always starts at 0 and
									// would collide with a text content block also at index 0.
									if (context.toolCallAccumulators[idx] === undefined) {
										if (!toolCall.id || !toolCall.function?.name) {
											log.warn(
												`Missing tool call id or name for index: ${idx}`,
											);
											continue;
										}
										// Close thinking block before first tool block if not already closed
										if (
											context.hasSentThinkingBlockStart &&
											!context.thinkingBlockClosed
										) {
											context.thinkingBlockClosed = true;
											const thinkingStop = {
												type: "content_block_stop",
												index: context.thinkingBlockIndex,
											};
											controller.enqueue(
												encoder.encode(`event: content_block_stop\n`),
											);
											controller.enqueue(
												encoder.encode(
													`data: ${JSON.stringify(thinkingStop)}\n\n`,
												),
											);
										}
										// Close text block before first tool block if not already closed
										if (
											context.hasSentContentBlockStart &&
											!context.textBlockClosed
										) {
											context.textBlockClosed = true;
											const textStop = {
												type: "content_block_stop",
												index: context.textBlockIndex,
											};
											controller.enqueue(
												encoder.encode(`event: content_block_stop\n`),
											);
											controller.enqueue(
												encoder.encode(
													`data: ${JSON.stringify(textStop)}\n\n`,
												),
											);
										}
										context.toolCallAccumulators[idx] = "";
										const anthropicBlockIdx = context.nextBlockIndex++;
										context.toolCallBlockIndices[idx] = anthropicBlockIdx;
										const contentBlockStart = {
											type: "content_block_start",
											index: anthropicBlockIdx,
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
							} else if (delta?.reasoning_content) {
								// DeepSeek/reasoning providers emit reasoning_content before text.
								// Map to Anthropic thinking block using monotonic nextBlockIndex.
								if (!context.hasSentThinkingBlockStart) {
									context.hasSentThinkingBlockStart = true;
									// Close text block first if one was already emitted
									if (context.hasSentContentBlockStart && !context.textBlockClosed) {
										context.textBlockClosed = true;
										const textStop = {
											type: "content_block_stop",
											index: context.textBlockIndex,
										};
										controller.enqueue(
											encoder.encode(`event: content_block_stop\n`),
										);
										controller.enqueue(
											encoder.encode(
												`data: ${JSON.stringify(textStop)}\n\n`,
											),
										);
									}
									context.thinkingBlockIndex = context.nextBlockIndex++;
									const thinkingBlockStart = {
										type: "content_block_start",
										index: context.thinkingBlockIndex,
										content_block: {
											type: "thinking",
											thinking: "",
										},
									};
									controller.enqueue(
										encoder.encode(`event: content_block_start\n`),
									);
									controller.enqueue(
										encoder.encode(
											`data: ${JSON.stringify(thinkingBlockStart)}\n\n`,
										),
									);
								}

								const thinkingDelta = {
									type: "content_block_delta",
									index: context.thinkingBlockIndex,
									delta: {
										type: "thinking_delta",
										thinking: delta.reasoning_content,
									},
								};
								controller.enqueue(
									encoder.encode(`event: content_block_delta\n`),
								);
								controller.enqueue(
									encoder.encode(`data: ${JSON.stringify(thinkingDelta)}\n\n`),
								);
							} else if (delta?.content) {
								// Send content_block_start on first content.
								// Use the monotonic nextBlockIndex so the text block index
								// never collides with any tool_use blocks.
								if (!context.hasSentContentBlockStart) {
									context.hasSentContentBlockStart = true;
									context.textBlockIndex = context.nextBlockIndex++;

									// Close thinking block first if one was emitted
									if (context.hasSentThinkingBlockStart && !context.thinkingBlockClosed) {
										context.thinkingBlockClosed = true;
										const thinkingStop = {
											type: "content_block_stop",
											index: context.thinkingBlockIndex,
										};
										controller.enqueue(
											encoder.encode(`event: content_block_stop\n`),
										);
										controller.enqueue(
											encoder.encode(
												`data: ${JSON.stringify(thinkingStop)}\n\n`,
											),
										);
									}

									const contentBlockStart = {
										type: "content_block_start",
										index: context.textBlockIndex,
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
									index: context.textBlockIndex,
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
					for (const [openaiIdx, anthropicIdx] of Object.entries(
						context.toolCallBlockIndices,
					)) {
						const numIdx = Number.parseInt(openaiIdx, 10);
						const accumulated = context.toolCallAccumulators[numIdx] || "";
						emitToolCallJson(controller, encoder, anthropicIdx, accumulated);
					}
					emitStreamEnd(
						controller,
						encoder,
						"tool_use",
						context.promptTokens,
						context.completionTokens,
						context.toolCallBlockIndices,
						context.cacheReadInputTokens,
						context.cacheCreationInputTokens,
					);
				} else if (
					context.hasSentContentBlockStart &&
					!context.encounteredToolCall
				) {
					log.warn("Stream terminated without [DONE] — closing last open block");
					const lastBlockIndex =
						context.textBlockClosed
							? context.thinkingBlockIndex
							: context.textBlockIndex;
					emitStreamEnd(
						controller,
						encoder,
						"end_turn",
						context.promptTokens,
						context.completionTokens,
						null,
						context.cacheReadInputTokens,
						context.cacheCreationInputTokens,
						lastBlockIndex,
					);
				} else if (context.hasSentThinkingBlockStart) {
					log.warn(
						"Stream terminated without [DONE] — closing reasoning-only thinking block",
					);
					// emitStreamEnd closes the block via end_turn branch — no manual emit needed
					emitStreamEnd(
						controller,
						encoder,
						"end_turn",
						context.promptTokens,
						context.completionTokens,
						null,
						context.cacheReadInputTokens,
						context.cacheCreationInputTokens,
						context.thinkingBlockIndex,
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
