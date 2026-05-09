type AnthropicContentBlock =
	| { type: "text"; text: string }
	| { type: "thinking"; thinking: string }
	| {
			type: "image";
			source: { type: "base64"; data: string } | { type: "url"; url: string };
	  }
	| {
			type: "tool_use";
			id?: string;
			name: string;
			input: Record<string, unknown>;
	  }
	| {
			type: "tool_result";
			tool_use_id: string;
			content: string | AnthropicContentBlock[];
	  };

type AnthropicMessage = {
	role: "user" | "assistant";
	content: string | AnthropicContentBlock[];
};

type OllamaMessage = {
	role: "system" | "user" | "assistant";
	content: string;
	images?: string[];
	tool_calls?: {
		type: "function";
		function: {
			name: string;
			arguments: string | Record<string, unknown>;
		};
	}[];
	tool_call_id?: string;
};

type OllamaTool = {
	type: "function";
	function: {
		name: string;
		description: string;
		parameters: Record<string, unknown>;
	};
};

type OllamaRequest = {
	model: string;
	messages: OllamaMessage[];
	stream?: boolean;
	tools?: OllamaTool[];
	options?: Record<string, unknown>;
};

type OllamaResponseChunk = {
	model: string;
	message: OllamaMessage;
	done: boolean;
	done_reason?: string;
	total_duration?: number;
};

type AnthropicTool = {
	type: "function";
	function: {
		name: string;
		description?: string;
		parameters?: Record<string, unknown>;
	};
};
// Local type aliases for Anthropic SDK types
type ContentBlock = AnthropicContentBlock;
type Message = AnthropicMessage;
type Tool = AnthropicTool;
type ToolUseBlockParam = AnthropicContentBlock & {
	type: "tool_use";
	id?: string;
};
type ToolResultBlockParam = AnthropicContentBlock & { type: "tool_result" };

// Local type aliases for Ollama types used in response conversion
type OllamaResponseChunkWithContent = OllamaResponseChunk & {
	message: {
		role: string;
		content: string;
		tool_calls?: {
			function: { name: string; arguments: string | Record<string, unknown> };
		}[];
	};
};

function extractTextContent(content: ContentBlock | string): string {
	if (typeof content === "string") return content;
	if (content.type === "text") return content.text;
	if (content.type === "thinking") return content.thinking || "";
	return "";
}

/**
 * Extract base64 image data from Anthropic content block
 */
function extractImageBase64(content: ContentBlock): string | null {
	if (content.type !== "image") return null;
	if (content.source.type === "base64") return content.source.data;
	if (content.source.type === "url") {
		const url = content.source.url;
		const match = url.match(/^data:image\/[^;]+;base64,(.+)$/);
		return match ? match[1] : null;
	}
	return null;
}

/**
 * Convert Anthropic messages array to Ollama /api/chat format
 */
export function anthropicToOllama(
	body: Record<string, unknown>,
): OllamaRequest {
	const model = (body.model as string) || "unknown";
	const messages = (body.messages as Message[]) || [];
	const systemBlock = body.system;

	const ollamaMessages: OllamaMessage[] = [];

	// System prompt: Anthropic has it as separate field, Ollama as system message
	if (systemBlock) {
		if (typeof systemBlock === "string") {
			ollamaMessages.push({ role: "system", content: systemBlock });
		} else if (Array.isArray(systemBlock)) {
			const sysText = (systemBlock as ContentBlock[])
				.map(extractTextContent)
				.join("\n");
			if (sysText) ollamaMessages.push({ role: "system", content: sysText });
		}
	}

	for (const msg of messages) {
		const role = msg.role as "user" | "assistant";
		const content = msg.content;

		if (typeof content === "string") {
			ollamaMessages.push({ role, content });
			continue;
		}

		if (Array.isArray(content)) {
			let textParts: string[] = [];
			const images: string[] = [];

			for (const block of content as ContentBlock[]) {
				if (block.type === "text") {
					textParts.push(block.text);
				} else if (block.type === "thinking") {
					textParts.push(`<thinking>${block.thinking}</thinking>`);
				} else if (block.type === "image") {
					const b64 = extractImageBase64(block);
					if (b64) images.push(b64);
				} else if (block.type === "tool_use") {
					// Flush text before tool_use
					if (textParts.length > 0) {
						ollamaMessages.push({ role, content: textParts.join("\n") });
						textParts = [];
					}
					const toolUse = block as ToolUseBlockParam;
					ollamaMessages.push({
						role: "assistant",
						content: "",
						tool_calls: [
							{
								type: "function",
								function: {
									name: toolUse.name,
									arguments: (toolUse.input ?? {}) as Record<string, unknown>,
								},
							},
						],
					});
				} else if (block.type === "tool_result") {
					if (textParts.length > 0) {
						ollamaMessages.push({ role, content: textParts.join("\n") });
						textParts = [];
					}
					const toolResult = block as ToolResultBlockParam;
					const toolContent =
						typeof toolResult.content === "string"
							? toolResult.content
							: Array.isArray(toolResult.content)
								? toolResult.content.map(extractTextContent).join("\n")
								: "";
					ollamaMessages.push({
						role: "user",
						content: toolContent,
						tool_call_id: toolResult.tool_use_id,
					});
				}
			}

			if (textParts.length > 0) {
				ollamaMessages.push({
					role,
					content: textParts.join("\n"),
					...(images.length > 0 ? { images } : {}),
				});
			}
		}
	}

	// Build tools if provided
	const tools: OllamaTool[] = [];
	if (Array.isArray(body.tools)) {
		for (const tool of body.tools as Tool[]) {
			if (tool.type === "function" && tool.function) {
				tools.push({
					type: "function",
					function: {
						name: tool.function.name,
						description: tool.function.description || "",
						parameters:
							(tool.function.parameters as Record<string, unknown>) || {},
					},
				});
			}
		}
	}

	const req: OllamaRequest = {
		model,
		messages: ollamaMessages,
		stream: (body.stream as boolean) ?? true,
	};

	if (tools.length > 0) req.tools = tools;

	// Pass through Ollama-specific options
	if (body.options && typeof body.options === "object") {
		req.options = body.options as Record<string, unknown>;
	}

	// Map common params
	if (typeof body.temperature === "number") {
		req.options = req.options || {};
		req.options.temperature = body.temperature;
	}
	if (typeof body.top_p === "number") {
		req.options = req.options || {};
		req.options.top_p = body.top_p;
	}
	if (typeof body.top_k === "number") {
		req.options = req.options || {};
		req.options.top_k = body.top_k;
	}
	if (typeof body.max_tokens === "number") {
		req.options = req.options || {};
		req.options.num_predict = body.max_tokens;
	}

	return req;
}

/**
 * State tracker for streaming SSE transformation.
 * Ollama sends cumulative content chunks; we need to emit proper
 * Anthropic SSE events with stateful indexing.
 */
export type SSEStreamState = {
	messageStarted: boolean;
	contentBlockIndex: number;
	lastTextContent: string;
	hasEmittedContentBlockStart: boolean;
};

/**
 * Convert a single Ollama response chunk to Anthropic SSE event line(s).
 * Requires a mutable state object that tracks stream position across calls.
 */
export function ollamaChunkToAnthropicSSE(
	chunk: OllamaResponseChunk,
	streamId: string,
	state: SSEStreamState,
): string {
	const events: string[] = [];

	// Emit message_start on first chunk
	if (!state.messageStarted) {
		state.messageStarted = true;
		events.push(
			`event: message_start`,
			`data: ${JSON.stringify({
				type: "message_start",
				message: {
					id: `msg_${streamId}`,
					type: "message",
					role: "assistant",
					model: chunk.model,
					content: [],
					stop_reason: null,
					stop_sequence: null,
					usage: { input_tokens: 0, output_tokens: 0 },
				},
			})}`,
			``,
		);
	}

	if (chunk.done) {
		// Close any open content blocks
		if (state.hasEmittedContentBlockStart) {
			events.push(
				`event: content_block_stop`,
				`data: ${JSON.stringify({
					type: "content_block_stop",
					index: state.contentBlockIndex - 1,
				})}`,
				``,
			);
		}

		const usage = {
			input_tokens: 0,
			output_tokens: 0,
		};
		events.push(
			`event: message_delta`,
			`data: ${JSON.stringify({
				type: "message_delta",
				delta: {
					stop_reason: chunk.done_reason || "end_turn",
					stop_sequence: null,
				},
				usage,
			})}`,
			``,
			`event: message_stop`,
			`data: ${JSON.stringify({ type: "message_stop" })}`,
			``,
		);
		return `${events.join("\n")}\n`;
	}

	const content = chunk.message.content || "";

	// Handle tool calls — emit as a separate content block
	if (chunk.message.tool_calls && chunk.message.tool_calls.length > 0) {
		if (!state.hasEmittedContentBlockStart) {
			state.hasEmittedContentBlockStart = true;
			events.push(
				`event: content_block_start`,
				`data: ${JSON.stringify({
					type: "content_block_start",
					index: state.contentBlockIndex,
					content_block: {
						type: "tool_use",
						id: `toolu_${streamId}_${state.contentBlockIndex}`,
						name: chunk.message.tool_calls[0].function.name,
						input: {},
					},
				})}`,
				``,
			);
		}

		const tc = chunk.message.tool_calls[0];
		let inputObj: Record<string, unknown> = {};
		// Ollama sends arguments as an object, not a string — use as-is
		if (
			typeof tc.function.arguments === "object" &&
			tc.function.arguments !== null
		) {
			inputObj = tc.function.arguments as Record<string, unknown>;
		} else if (typeof tc.function.arguments === "string") {
			try {
				inputObj = JSON.parse(tc.function.arguments);
			} catch {
				// keep empty
			}
		}

		events.push(
			`event: content_block_delta`,
			`data: ${JSON.stringify({
				type: "content_block_delta",
				index: state.contentBlockIndex,
				delta: {
					type: "input_json_delta",
					partial_json: JSON.stringify(inputObj),
				},
			})}`,
			``,
		);
		state.contentBlockIndex++;
		return `${events.join("\n")}\n`;
	}

	// Handle text content — only emit delta if content is new (cumulative chunks)
	if (content && content !== state.lastTextContent) {
		const deltaText = content.slice(state.lastTextContent.length);
		state.lastTextContent = content;

		if (!state.hasEmittedContentBlockStart) {
			state.hasEmittedContentBlockStart = true;
			events.push(
				`event: content_block_start`,
				`data: ${JSON.stringify({
					type: "content_block_start",
					index: state.contentBlockIndex,
					content_block: { type: "text", text: "" },
				})}`,
				``,
			);
		}

		if (deltaText) {
			events.push(
				`event: content_block_delta`,
				`data: ${JSON.stringify({
					type: "content_block_delta",
					index: state.contentBlockIndex,
					delta: { type: "text_delta", text: deltaText },
				})}`,
				``,
			);
		}
	}

	return `${events.join("\n")}\n`;
}

/**
 * Convert non-streaming Ollama response to Anthropic messages response format
 */
export function ollamaResponseToAnthropic(
	chunk: OllamaResponseChunk,
): Record<string, unknown> {
	const content: ContentBlock[] = [];

	if (chunk.message.content) {
		content.push({ type: "text", text: chunk.message.content });
	}

	if (chunk.message.tool_calls && chunk.message.tool_calls.length > 0) {
		for (const [idx, tc] of chunk.message.tool_calls.entries()) {
			let parsedInput: Record<string, unknown> = {};
			if (
				typeof tc.function.arguments === "object" &&
				tc.function.arguments !== null
			) {
				parsedInput = tc.function.arguments as Record<string, unknown>;
			} else if (typeof tc.function.arguments === "string") {
				try {
					parsedInput = JSON.parse(tc.function.arguments);
				} catch {
					// keep empty
				}
			}
			content.push({
				type: "tool_use",
				id: `toolu_ollama_${idx}`,
				name: tc.function.name,
				input: parsedInput,
			});
		}
	}

	return {
		id: `ollama_${Date.now()}`,
		type: "message",
		role: "assistant",
		content,
		model: chunk.model,
		stop_reason: chunk.done_reason || "end_turn",
		stop_sequence: null,
		usage: {
			input_tokens: 0,
			output_tokens: 0,
		},
	};
}

/**
 * Detect if a base URL points to Ollama Cloud
 */
export function isOllamaCloudEndpoint(baseUrl: string): boolean {
	try {
		const url = new URL(baseUrl);
		return url.hostname === "ollama.com";
	} catch {
		return false;
	}
}
