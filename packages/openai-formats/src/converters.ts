import { mapModelName } from "@better-ccflare/core";
import { Logger } from "@better-ccflare/logger";
import type { Account } from "@better-ccflare/types";
import { normalizeOpenAIContent } from "./content";
import { resolveReasoningEffort } from "./reasoning";
import type {
	AnthropicContent,
	AnthropicContentBlock,
	AnthropicImageContent,
	AnthropicRequest,
	AnthropicResponse,
	AnthropicTextContent,
	AnthropicThinkingContent,
	AnthropicToolResult,
	AnthropicToolUse,
	OpenAIContentPart,
	OpenAIMessage,
	OpenAIRequest,
	OpenAIResponse,
} from "./types";
import { mapOpenAIFinishReason, sanitizeSchemaForOpenAI } from "./utils";

const log = new Logger("openai-formats/converters");

/**
 * Safely parse JSON with error handling
 */
export function safeParseJSON(jsonString: string): unknown {
	try {
		return JSON.parse(jsonString);
	} catch (error) {
		log.warn(`Failed to parse JSON: ${jsonString}`, error);
		return {};
	}
}

/**
 * Strip cache_control from all system message content blocks and user/assistant
 * message content blocks in an already-converted OpenAI request body.
 * Used for providers that reject unknown fields (e.g. GLM-5.1).
 */
export function stripCacheControlFromOpenAIRequest(body: OpenAIRequest): void {
	if (!Array.isArray(body.messages)) return;
	for (const msg of body.messages) {
		if (Array.isArray(msg.content)) {
			for (const part of msg.content) {
				if (typeof part === "object" && part !== null) {
					delete (part as unknown as Record<string, unknown>).cache_control;
				}
			}
		}
	}
}

/**
 * Map an Anthropic `image` block onto an OpenAI `image_url` content part.
 *
 * Base64 sources become a `data:` URL because that is the only shape every
 * OpenAI-compatible gateway understands for inline bytes; URL sources are
 * forwarded verbatim. Media type falls back to `image/png` when the client
 * omitted it — the field is optional on the Anthropic wire type.
 *
 * Returns null for malformed blocks (no data, no url) so the caller can skip
 * them instead of emitting a part the upstream will reject.
 */
export function toOpenAIImagePart(
	block: AnthropicImageContent,
): OpenAIContentPart | null {
	const source = block.source;
	if (!source || typeof source !== "object") return null;

	if (typeof source.url === "string" && source.url.length > 0) {
		return { type: "image_url", image_url: { url: source.url } };
	}
	if (typeof source.data === "string" && source.data.length > 0) {
		const mediaType =
			typeof source.media_type === "string" && source.media_type.length > 0
				? source.media_type
				: "image/png";
		return {
			type: "image_url",
			image_url: { url: `data:${mediaType};base64,${source.data}` },
		};
	}
	return null;
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
				parameters: sanitizeSchemaForOpenAI(tool.input_schema) as Record<
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

	// Images found inside tool_result blocks. OpenAI's `tool` role is text-only,
	// so these cannot ride along with the tool output.

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

				// Extract image blocks. These used to be dropped here with no trace
				// left in the request, which silently turned a vision prompt into a
				// text-only one. They are now emitted as `image_url` parts, in the
				// same order the client sent them.
				const convertedImages = new Map<string, OpenAIContentPart>();
				for (let index = 0; index < message.content.length; index++) {
					const part = message.content[index];
					if (part?.type !== "image") continue;
					const converted = toOpenAIImagePart(part);
					if (converted) convertedImages.set(String(index), converted);
				}

				let content: OpenAIMessage["content"];
				if (convertedImages.size > 0) {
					const parts: OpenAIContentPart[] = [];
					for (let index = 0; index < message.content.length; index++) {
						const part = message.content[index];
						if (!part) continue;
						if (part.type === "text") {
							const block: OpenAIContentPart = {
								type: "text",
								text: part.text,
							};
							if (part.cache_control) block.cache_control = part.cache_control;
							parts.push(block);
						} else {
							const converted = convertedImages.get(String(index));
							if (converted) parts.push(converted);
						}
					}
					content = parts;
				} else if (hasCacheControl) {
					content = textBlocks.map((part) => {
						const block: OpenAIContentPart = {
							type: "text",
							text: part.text,
						};
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
				// Images hoisted out of THIS message's tool results. Emitted as a
				// user turn immediately after the tool messages and before any later
				// turn, so a screenshot stays beside the tool result that produced it
				// instead of drifting to the end of a long conversation.
				const hoistedToolImages: OpenAIContentPart[] = [];
				for (const toolResult of toolResults) {
					let toolContent: string;
					if (typeof toolResult.content === "string") {
						toolContent = toolResult.content;
					} else if (Array.isArray(toolResult.content)) {
						// Array content: serialize non-image text; images are hoisted out (see below)
						const parts: string[] = [];
						for (const block of toolResult.content as AnthropicContent[]) {
							if (block.type === "text") {
								parts.push(block.text);
							} else if (block.type === "image") {
								// OpenAI tool messages don't support image content, so the
								// tool output keeps a placeholder and the image itself is
								// hoisted into a following user turn (below).
								const hoisted = toOpenAIImagePart(block);
								if (hoisted) hoistedToolImages.push(hoisted);
								// The placeholder must describe what actually happened, so
								// it is chosen after the mapping. A block with no usable
								// source produces no part: claiming the image follows would
								// point the model at a turn that either holds a sibling
								// tool result's image or nothing at all. And when an image
								// DOES follow, the placeholder must not read as "you cannot
								// see this" — the model can, in the next turn.
								parts.push(
									hoisted
										? "[image attached in the following message]"
										: "[image unavailable: the tool result carried none]",
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

				// Emit this message's hoisted tool images now — right after its tool
				// messages, before any later turn. Adding them to the end of the
				// conversation instead would re-present every historical screenshot
				// as fresh input on each subsequent request, detached from the tool
				// result that produced it.
				if (hoistedToolImages.length > 0) {
					messages.push({ role: "user", content: hoistedToolImages });
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
	fallbackModel?: string,
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
		// Flat gateway rejection shape (CodeBuddy): a bare `{code, msg}`
		// envelope with no `error` object and no `choices`. Pass the real
		// message through - masking it as the generic invalid_response text
		// hid the actionable cause (e.g. code 11128 "Illegal API invocation
		// from an unapproved channel") from the client. Terminal
		// invalid_request_error is correct here: the proxy has already
		// exhausted failover by the time the client sees this body.
		const gateway = openaiData as { code?: unknown; msg?: unknown };
		if (typeof gateway.code === "number" && typeof gateway.msg === "string") {
			return {
				type: "error",
				error: {
					type: "invalid_request_error",
					message: `Upstream gateway error ${gateway.code}: ${gateway.msg}`,
				},
			};
		}
		// Mistral-style rejection: pydantic validation errors in a `detail`
		// array. Observed both top-level (`{detail: [...]}`, 2026-11-03 live)
		// and nested under `message`; pass a flattened summary through rather
		// than letting the object fall to the generic text (which would hide
		// why the request was refused).
		const envelope = openaiData as { detail?: unknown; message?: unknown };
		const nestedMessage = envelope.message;
		const detail = Array.isArray(envelope.detail)
			? envelope.detail
			: typeof nestedMessage === "object" && nestedMessage !== null
				? (nestedMessage as { detail?: unknown }).detail
				: undefined;
		if (Array.isArray(detail) && detail.length > 0) {
			const summary = detail
				.map((entry: unknown) => {
					if (typeof entry !== "object" || entry === null) return null;
					const { loc, msg } = entry as { loc?: unknown; msg?: unknown };
					const path = Array.isArray(loc) ? loc.join(".") : "";
					const text = typeof msg === "string" ? msg : "";
					if (!path && !text) return null;
					return path && text ? `${path}: ${text}` : path || text;
				})
				.filter((line): line is string => line !== null)
				.join("; ");
			if (summary) {
				return {
					type: "error",
					error: {
						type: "invalid_request_error",
						message: summary,
					},
				};
			}
		}
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

	// Add thinking content first (Anthropic ordering) — DeepSeek/reasoning
	// providers return reasoning_content on the message in non-streaming responses.
	// OpenRouter-shaped gateways (kilo, openrouter, nanogpt) use `reasoning`
	// instead and document `reasoning_content` as the alias, so accept both in the
	// same precedence as the streaming transform (stream.ts:546). Some gateways
	// (Mistral/GLM) instead return `content` as an array of thinking + text
	// blocks; an explicit reasoning field wins when both carry thinking.
	//
	// Missing the alias cost more than cosmetics. A reasoning model that spends
	// its whole budget thinking returns no `content` at all, so the client saw an
	// empty message with `stop_reason: max_tokens` (observed live against a
	// reasoning model on an OpenRouter-shaped gateway). And whenever reasoning did
	// accompany text, dropping it
	// broke the round-trip: the request side maps Anthropic thinking blocks back
	// to `reasoning_content` for providers that require them, so a client that
	// never receives the thinking cannot echo it on the next turn.
	const normalizedContent = normalizeOpenAIContent(choice.message?.content);
	const thinking =
		choice.message?.reasoning_content ||
		choice.message?.reasoning ||
		normalizedContent.thinking;
	if (thinking) {
		content.push({
			type: "thinking",
			thinking,
		});
	}

	// Add text content if present
	if (normalizedContent.hasContent) {
		content.push({
			type: "text",
			text: normalizedContent.text,
		});
	}

	// Add tool calls if present
	const toolCalls = choice.message?.tool_calls || [];
	for (const toolCall of toolCalls) {
		content.push({
			type: "tool_use",
			id: toolCall.id,
			name: toolCall.function.name,
			// Tool call arguments are always a JSON object per the OpenAI spec;
			// safeParseJSON is intentionally generic (used with arbitrary JSON
			// elsewhere), so narrow the known-object shape here.
			input: safeParseJSON(toolCall.function.arguments || "{}") as Record<
				string,
				unknown
			>,
		});
	}

	// prompt_tokens is cache-inclusive upstream; Anthropic's input_tokens is
	// additive and must exclude the cached subset, otherwise the proxy's usage
	// collector adds input_tokens and cache_read_input_tokens together and
	// records the cached prompt twice. Same normalization as the streaming
	// message_delta in stream.ts.
	const promptTokens = openaiData.usage?.prompt_tokens || 0;
	const cachedTokens = Math.max(
		0,
		Math.min(
			typeof openaiData.usage?.prompt_tokens_details?.cached_tokens === "number"
				? openaiData.usage.prompt_tokens_details.cached_tokens
				: 0,
			promptTokens,
		),
	);

	return {
		id: openaiData.id || `msg_${Date.now()}`,
		type: "message",
		role: "assistant",
		content,
		model: openaiData.model || fallbackModel,
		stop_reason: mapOpenAIFinishReason(choice.finish_reason),
		stop_sequence: undefined,
		usage: {
			input_tokens: promptTokens - cachedTokens,
			output_tokens: openaiData.usage?.completion_tokens || 0,
			cache_read_input_tokens: cachedTokens,
			cache_creation_input_tokens: 0,
		},
	};
}
