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
 * Transform OpenAI Server-Sent Events (SSE) streaming response to Anthropic SSE format
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
							// Send content_block_stop for tool calls or text
							if (context.encounteredToolCall) {
								// Stop all tool call blocks
								for (const idx in context.toolCallAccumulators) {
									const numIdx = Number.parseInt(idx, 10);
									const accumulated =
										context.toolCallAccumulators[numIdx] || "";

									// Repair truncated JSON before closing the block
									const repair = repairTruncatedToolJson(accumulated);
									if (repair) {
										log.warn(
											`Repairing truncated tool call JSON at index ${idx} (appending ${JSON.stringify(repair)})`,
										);
										const repairDelta = {
											type: "content_block_delta",
											index: numIdx,
											delta: {
												type: "input_json_delta",
												partial_json: repair,
											},
										};
										controller.enqueue(
											encoder.encode(`event: content_block_delta\n`),
										);
										controller.enqueue(
											encoder.encode(
												`data: ${JSON.stringify(repairDelta)}\n\n`,
											),
										);
									}

									const contentBlockStop = {
										type: "content_block_stop",
										index: numIdx,
									};
									controller.enqueue(
										encoder.encode(`event: content_block_stop\n`),
									);
									controller.enqueue(
										encoder.encode(
											`data: ${JSON.stringify(contentBlockStop)}\n\n`,
										),
									);
								}
								// Cleanup accumulators after processing
								context.toolCallAccumulators = {};
							} else if (context.hasSentContentBlockStart) {
								const contentBlockStop = {
									type: "content_block_stop",
									index: 0,
								};
								controller.enqueue(
									encoder.encode(`event: content_block_stop\n`),
								);
								controller.enqueue(
									encoder.encode(
										`data: ${JSON.stringify(contentBlockStop)}\n\n`,
									),
								);
							}

							// Send message_delta with appropriate stop_reason
							const messageDelta = {
								type: "message_delta",
								delta: {
									stop_reason: context.encounteredToolCall
										? "tool_use"
										: "end_turn",
									stop_sequence: null,
								},
								usage: {
									input_tokens: context.promptTokens,
									output_tokens: context.completionTokens,
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

							// Cleanup entire context after stream completion to prevent memory leaks
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

							// Handle tool call deltas
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

									// Accumulate and send argument deltas with validation
									const newArgs = toolCall.function?.arguments || "";
									if (newArgs.length > context.maxToolCallLength) {
										log.warn(
											`Tool call arguments exceed max length for index ${idx} (${newArgs.length}/${context.maxToolCallLength})`,
										);
										continue;
									}
									const oldArgs = context.toolCallAccumulators[idx] || "";

									// Validate that new arguments start with old arguments (streaming consistency)
									if (
										newArgs.startsWith(oldArgs) &&
										newArgs.length > oldArgs.length
									) {
										const deltaText = newArgs.substring(oldArgs.length);
										const contentBlockDelta = {
											type: "content_block_delta",
											index: idx,
											delta: {
												type: "input_json_delta",
												partial_json: deltaText,
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
										context.toolCallAccumulators[idx] = newArgs;
									} else if (newArgs.length < oldArgs.length) {
										// Handle case where arguments are reset (rare but possible)
										log.debug(`Tool call arguments reset for index ${idx}`);
										context.toolCallAccumulators[idx] = newArgs;
									} else if (
										!newArgs.startsWith(oldArgs) &&
										newArgs.length > 0
									) {
										// Incremental mode: provider sends only the new chunk,
										// not the full accumulated string. Some providers (e.g. Qwen
										// via DashScope) use this mode. Append to accumulator and
										// forward the chunk as-is.
										const contentBlockDelta = {
											type: "content_block_delta",
											index: idx,
											delta: {
												type: "input_json_delta",
												partial_json: newArgs,
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
										context.toolCallAccumulators[idx] = oldArgs + newArgs;
									}
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

				// Stream ended without [DONE] (e.g. Qwen timeout/truncation).
				// Emit repair + stop events so the client gets a valid response.
				if (
					context.encounteredToolCall &&
					Object.keys(context.toolCallAccumulators).length > 0
				) {
					log.warn(
						"Stream terminated without [DONE] — emitting repair+stop for incomplete tool calls",
					);
					for (const idx in context.toolCallAccumulators) {
						const numIdx = Number.parseInt(idx, 10);
						const accumulated = context.toolCallAccumulators[numIdx] || "";

						const repair = repairTruncatedToolJson(accumulated);
						if (repair) {
							log.warn(
								`flush: Repairing truncated tool call JSON at index ${idx} (appending ${JSON.stringify(repair)})`,
							);
							const repairDelta = {
								type: "content_block_delta",
								index: numIdx,
								delta: {
									type: "input_json_delta",
									partial_json: repair,
								},
							};
							controller.enqueue(
								encoder.encode(`event: content_block_delta\n`),
							);
							controller.enqueue(
								encoder.encode(`data: ${JSON.stringify(repairDelta)}\n\n`),
							);
						}

						const contentBlockStop = {
							type: "content_block_stop",
							index: numIdx,
						};
						controller.enqueue(encoder.encode(`event: content_block_stop\n`));
						controller.enqueue(
							encoder.encode(`data: ${JSON.stringify(contentBlockStop)}\n\n`),
						);
					}

					// Emit message_delta + message_stop
					const messageDelta = {
						type: "message_delta",
						delta: {
							stop_reason: "tool_use",
							stop_sequence: null,
						},
						usage: {
							input_tokens: context.promptTokens,
							output_tokens: context.completionTokens,
						},
					};
					controller.enqueue(encoder.encode(`event: message_delta\n`));
					controller.enqueue(
						encoder.encode(`data: ${JSON.stringify(messageDelta)}\n\n`),
					);
					const messageStop = { type: "message_stop" };
					controller.enqueue(encoder.encode(`event: message_stop\n`));
					controller.enqueue(
						encoder.encode(`data: ${JSON.stringify(messageStop)}\n\n`),
					);
				} else if (
					context.hasSentContentBlockStart &&
					!context.encounteredToolCall
				) {
					// Text stream ended without [DONE]
					log.warn("Stream terminated without [DONE] — closing text block");
					const contentBlockStop = {
						type: "content_block_stop",
						index: 0,
					};
					controller.enqueue(encoder.encode(`event: content_block_stop\n`));
					controller.enqueue(
						encoder.encode(`data: ${JSON.stringify(contentBlockStop)}\n\n`),
					);
					const messageDelta = {
						type: "message_delta",
						delta: { stop_reason: "end_turn", stop_sequence: null },
						usage: {
							input_tokens: context.promptTokens,
							output_tokens: context.completionTokens,
						},
					};
					controller.enqueue(encoder.encode(`event: message_delta\n`));
					controller.enqueue(
						encoder.encode(`data: ${JSON.stringify(messageDelta)}\n\n`),
					);
					const messageStop = { type: "message_stop" };
					controller.enqueue(encoder.encode(`event: message_stop\n`));
					controller.enqueue(
						encoder.encode(`data: ${JSON.stringify(messageStop)}\n\n`),
					);
				}

				(this as any).context = null;
			},
		}),
	);

	// The issue: response.clone() on a pipeThrough'd Response returns the original
	// untransformed body in some environments. Solution: Manually tee the stream
	// and attach the analytics stream as a property for response-handler to use.

	// Tee the transformed stream into two independent streams
	const [clientStream, analyticsStream] = transformedBody.tee();

	// Create the response that will be returned to the client
	const clientResponse = new Response(clientStream, {
		status: response.status,
		statusText: response.statusText,
		headers: sanitizeHeaders(response.headers),
	});

	// Attach the analytics stream as a non-enumerable Symbol property
	// The response-handler will check for this Symbol and use it instead of calling clone()
	Object.defineProperty(clientResponse, ANALYTICS_STREAM_SYMBOL, {
		value: analyticsStream,
		writable: false,
		enumerable: false,
		configurable: false,
	});

	return clientResponse;
}
