import { mapModelName } from "@better-ccflare/core";
import { Logger } from "@better-ccflare/logger";
import type { Account } from "@better-ccflare/types";
import { resolveReasoningEffort } from "./reasoning";
import type {
	AnthropicContent,
	AnthropicContentBlock,
	AnthropicRequest,
	AnthropicResponse,
	AnthropicTextContent,
	AnthropicThinkingContent,
	AnthropicToolResult,
	AnthropicToolUse,
	OpenAIMessage,
	OpenAIRequest,
	OpenAIResponse,
} from "./types";
import { mapOpenAIFinishReason, removeUriFormat } from "./utils";

const log = new Logger("openai-formats/converters");

/**
 * Safely parse JSON with error handling
 */
export function safeParseJSON(jsonString: string): any {
	try {
		return JSON.parse(jsonString);
	} catch (error) {
		log.warn(`Failed to parse JSON: ${jsonString}`, error);
		return {};
	}
}

/**
 * Convert Anthropic request format to OpenAI format
 */
export function convertAnthropicRequestToOpenAI(
	anthropicData: AnthropicRequest,
	account?: Account,
): OpenAIRequest {
	// Map model name if account has custom mappings, otherwise forward as-is
	const mappedModel = account
		? mapModelName(anthropicData.model, account)
		: anthropicData.model;

	const openaiRequest: OpenAIRequest = {
		model: mappedModel,
		messages: [],
	};

	// Map parameters
	if (anthropicData.max_tokens !== undefined) {
		openaiRequest.max_tokens = anthropicData.max_tokens;
	}
	if (anthropicData.temperature !== undefined) {
		openaiRequest.temperature = anthropicData.temperature;
	}
	if (anthropicData.top_p !== undefined) {
		openaiRequest.top_p = anthropicData.top_p;
	}
	if (anthropicData.stop_sequences !== undefined) {
		openaiRequest.stop = anthropicData.stop_sequences;
	}
	if (anthropicData.stream !== undefined) {
		openaiRequest.stream = anthropicData.stream;
		if (anthropicData.stream) {
			openaiRequest.stream_options = { include_usage: true };
		}
	}
	const reasoningResolution = resolveReasoningEffort(
		anthropicData.reasoning?.effort,
		{
			sourceModel: anthropicData.model,
			targetModel: mappedModel,
		},
	);
	if (reasoningResolution.downgrades.length > 0) {
		for (const downgrade of reasoningResolution.downgrades) {
			log.warn(
				`Downgraded reasoning effort for model ${downgrade.model}: ${downgrade.from} -> ${downgrade.to}`,
			);
		}
	}
	if (reasoningResolution.effort !== undefined) {
		openaiRequest.reasoning = { effort: reasoningResolution.effort };
	}

	// Convert tools (only if non-empty — Qwen/DashScope rejects empty tools array)
	if (
		anthropicData.tools &&
		Array.isArray(anthropicData.tools) &&
		anthropicData.tools.length > 0
	) {
		openaiRequest.tools = anthropicData.tools.map((tool) => ({
			type: "function",
			function: {
				name: tool.name,
				description: tool.description,
				parameters: removeUriFormat(tool.input_schema) as Record<
					string,
					unknown
				>,
			},
		}));
	}

	// Convert tool_choice — only emit when tools are present (OpenAI spec requirement)
	if (anthropicData.tool_choice !== undefined && openaiRequest.tools?.length) {
		const tc = anthropicData.tool_choice;
		if (tc.type === "auto") {
			openaiRequest.tool_choice = "auto";
		} else if (tc.type === "any") {
			openaiRequest.tool_choice = "required";
		} else if (tc.type === "none") {
			openaiRequest.tool_choice = "none";
		} else if (tc.type === "tool") {
			openaiRequest.tool_choice = {
				type: "function",
				function: { name: tc.name },
			};
		}
	}

	// Handle system message (Anthropic has it as top-level, OpenAI has it in messages array)
	const messages: OpenAIMessage[] = [];
	if (anthropicData.system) {
		messages.push({
			role: "system",
			content:
				typeof anthropicData.system === "string"
					? anthropicData.system
					: anthropicData.system
							.filter(
								(
									b,
								): b is {
									type: string;
									text: string;
									cache_control?: { type: string };
								} => b.type === "text" && typeof b.text === "string",
							)
							.map((b) => {
								// Preserve cache_control for prompt caching.
								// DashScope (Qwen) uses this for ephemeral cache.
								// Other OpenAI-compatible providers that don't
								// support it should safely ignore the unknown field.
								const part: {
									type: string;
									text: string;
									cache_control?: { type: string };
								} = { type: "text", text: b.text };
								if (b.cache_control) part.cache_control = b.cache_control;
								return part;
							}),
		});
	}

	// Add user/assistant messages
	if (anthropicData.messages && Array.isArray(anthropicData.messages)) {
		for (const message of anthropicData.messages) {
			// Handle content arrays (Anthropic supports rich content)
			if (Array.isArray(message.content)) {
				// Extract tool_use blocks
				const toolUseBlocks = message.content.filter(
					(item): item is AnthropicToolUse => item.type === "tool_use",
				);

				// Extract text content, preserving cache_control if present
				const textBlocks = message.content.filter(
					(part): part is AnthropicTextContent => part.type === "text",
				);
				const hasCacheControl = textBlocks.some((part) => part.cache_control);

				// Extract thinking blocks — needed for DeepSeek/reasoning providers
				// that require reasoning_content to be passed back in conversation history
				const thinkingBlocks = message.content.filter(
					(part): part is AnthropicThinkingContent => part.type === "thinking",
				);

				let content: OpenAIMessage["content"];
				if (hasCacheControl) {
					content = textBlocks.map((part) => {
						const block: {
							type: string;
							text: string;
							cache_control?: { type: string };
						} = { type: "text", text: part.text };
						if (part.cache_control) block.cache_control = part.cache_control;
						return block;
					});
				} else {
					content = textBlocks.map((part) => part.text).join("") || null;
				}

				// Create OpenAI message with tool calls if present
				const openaiMessage: OpenAIMessage = {
					role: message.role,
					content,
				};

				if (toolUseBlocks.length > 0) {
					openaiMessage.tool_calls = toolUseBlocks.map((toolCall) => ({
						id: toolCall.id,
						type: "function",
						function: {
							name: toolCall.name,
							arguments: JSON.stringify(toolCall.input || {}),
						},
					}));
				}

				// Pass reasoning_content back for providers that require it (e.g. DeepSeek)
				if (thinkingBlocks.length > 0) {
					openaiMessage.reasoning_content = thinkingBlocks
						.map((b) => b.thinking)
						.join("");
				}

				// Handle tool_result blocks as separate 'tool' role messages.
				// Must be pushed BEFORE any accompanying text content so that
				// tool messages immediately follow the assistant's tool_calls message
				// (required by DeepSeek and OpenAI spec).
				const toolResults = message.content.filter(
					(item): item is AnthropicToolResult => item.type === "tool_result",
				);
				for (const toolResult of toolResults) {
					let toolContent: string;
					if (typeof toolResult.content === "string") {
						toolContent = toolResult.content;
					} else if (Array.isArray(toolResult.content)) {
						// Array content: serialize non-image items; drop images (not supported in OpenAI tool messages)
						const parts: string[] = [];
						for (const block of toolResult.content as AnthropicContent[]) {
							if (block.type === "text") {
								parts.push(block.text);
							} else if (block.type === "image") {
								// OpenAI tool messages don't support image content — drop with placeholder
								parts.push(
									"[image content not supported in OpenAI tool results]",
								);
							} else {
								// Other structured blocks (tool_use, tool_result, etc.) — serialize as JSON
								parts.push(JSON.stringify(block));
							}
						}
						toolContent = parts.join("\n");
					} else {
						toolContent = "";
					}
					messages.push({
						role: "tool",
						content: toolContent,
						tool_call_id: toolResult.tool_use_id,
					});
				}

				if (
					openaiMessage.content === null &&
					!openaiMessage.tool_calls &&
					thinkingBlocks.length > 0
				) {
					// Preserve thinking-only assistant turns while keeping
					// OpenAI assistant content non-null.
					openaiMessage.content = "";
				}

				if (
					(openaiMessage.content !== null &&
						openaiMessage.content !== undefined) ||
					openaiMessage.tool_calls
				) {
					messages.push(openaiMessage);
				}
			} else {
				// Simple string content
				messages.push({
					role: message.role,
					content: message.content,
				});
			}
		}
	}

	openaiRequest.messages = messages;
	return openaiRequest;
}

/**
 * Convert OpenAI response format to Anthropic format
 */
export function convertOpenAIResponseToAnthropic(
	openaiData: OpenAIResponse,
): AnthropicResponse {
	// Handle error responses
	if (openaiData.error) {
		return {
			type: "error",
			error: {
				type: openaiData.error.type || "api_error",
				message: openaiData.error.message || "An error occurred",
			},
		};
	}

	// Handle successful responses
	const choice = openaiData.choices?.[0];
	if (!choice) {
		return {
			type: "error",
			error: {
				type: "invalid_response",
				message: "Invalid response format from OpenAI provider",
			},
		};
	}

	// Build content array with text and tool calls
	const content: AnthropicContentBlock[] = [];

	// Add text content if present
	if (choice.message?.content) {
		content.push({
			type: "text",
			text: choice.message.content,
		});
	}

	// Add tool calls if present
	const toolCalls = choice.message?.tool_calls || [];
	for (const toolCall of toolCalls) {
		content.push({
			type: "tool_use",
			id: toolCall.id,
			name: toolCall.function.name,
			input: safeParseJSON(toolCall.function.arguments || "{}"),
		});
	}

	return {
		id: openaiData.id || `msg_${Date.now()}`,
		type: "message",
		role: "assistant",
		content,
		model: openaiData.model,
		stop_reason: mapOpenAIFinishReason(choice.finish_reason),
		stop_sequence: undefined,
		usage: {
			input_tokens: openaiData.usage?.prompt_tokens || 0,
			output_tokens: openaiData.usage?.completion_tokens || 0,
		},
	};
}
