// OpenAI API Requests/Response Types

export interface OpenAIToolCall {
	id: string;
	type: "function";
	function: {
		name: string;
		arguments: string;
	};
}

/**
 * One entry of an OpenAI chat-completions content array. Text parts carry
 * `text`; image parts carry `image_url` instead. Anthropic `image` blocks are
 * converted into this shape so vision-capable models actually receive them.
 */
export interface OpenAIContentPart {
	type: string;
	text?: string;
	cache_control?: { type: string };
	/** Present when `type === "image_url"`. */
	image_url?: { url: string };
}

export interface OpenAIMessage {
	role: "system" | "user" | "assistant" | "tool";
	content: string | null | OpenAIContentPart[];
	tool_calls?: OpenAIToolCall[];
	tool_call_id?: string;
	reasoning_content?: string;
}

export interface OpenAITool {
	type: "function";
	function: {
		name: string;
		description?: string;
		parameters?: Record<string, unknown>;
	};
}

export type OpenAIToolChoice =
	| "auto"
	| "none"
	| "required"
	| { type: "function"; function: { name: string } };

export interface OpenAIRequest {
	model: string;
	messages: OpenAIMessage[];
	max_tokens?: number;
	temperature?: number;
	top_p?: number;
	stop?: string | string[];
	stream?: boolean;
	stream_options?: { include_usage: boolean };
	tools?: OpenAITool[];
	tool_choice?: OpenAIToolChoice;
	reasoning?: { effort?: string };
}

export interface AnthropicTextContent {
	type: "text";
	text: string;
	cache_control?: { type: string };
}

export interface AnthropicThinkingContent {
	type: "thinking";
	thinking: string;
}

export interface AnthropicImageContent {
	type: "image";
	source: {
		type: "base64" | "url";
		media_type?: string;
		data?: string;
		url?: string;
	};
}

export interface AnthropicToolUse {
	type: "tool_use";
	id: string;
	name: string;
	input?: Record<string, unknown>;
}

export interface AnthropicToolResult {
	type: "tool_result";
	tool_use_id: string;
	content?: string | AnthropicContent[];
}

/**
 * Union of all Anthropic content block types that can appear in tool results
 * or message content arrays.
 */
export type AnthropicContent =
	| AnthropicTextContent
	| AnthropicImageContent
	| AnthropicThinkingContent
	| AnthropicToolUse
	| AnthropicToolResult;

export type AnthropicContentBlock =
	| AnthropicTextContent
	| AnthropicThinkingContent
	| AnthropicToolUse
	| AnthropicToolResult;

export interface AnthropicMessage {
	role: "user" | "assistant";
	/**
	 * `AnthropicContent` (not `AnthropicContentBlock`): the two differ only in
	 * that this admits `image`, and handing images to an OpenAI-compatible
	 * gateway is exactly what `toOpenAIImagePart` exists for. Keeping the
	 * narrower type here would make the image branch unrepresentable.
	 */
	content: string | AnthropicContent[];
}

export interface AnthropicTool {
	name: string;
	description?: string;
	input_schema?: Record<string, unknown>;
}

export type AnthropicToolChoice =
	| { type: "auto" }
	| { type: "any" }
	| { type: "none" }
	| { type: "tool"; name: string };

export interface AnthropicRequest {
	model: string;
	max_tokens: number;
	messages: AnthropicMessage[];
	system?:
		| string
		| Array<{
				type: string;
				text?: string;
				cache_control?: { type: string };
		  }>;
	temperature?: number;
	top_p?: number;
	stop_sequences?: string[];
	stream?: boolean;
	tools?: AnthropicTool[];
	tool_choice?: AnthropicToolChoice;
	reasoning?: { effort?: string };
}

export interface OpenAIUsage {
	prompt_tokens?: number;
	completion_tokens?: number;
	total_tokens?: number;
	prompt_tokens_details?: Record<string, unknown>;
}

export interface TransformStreamContext {
	buffer: string;
	hasStarted: boolean;
	extractedModel: string;
	contextWindowSize?: number;
	hasSentStart: boolean;
	/**
	 * True once any upstream chunk carried a non-empty `choices[0].finish_reason`.
	 * Declares that the upstream considers the completion finished, so a stream
	 * that ends without `[DONE]` may still be terminated (see the flush branch).
	 */
	hasSeenFinishReason: boolean;
	hasSentContentBlockStart: boolean;
	hasSentThinkingBlockStart: boolean;
	thinkingBlockClosed: boolean;
	textBlockClosed: boolean;
	/** Anthropic block index for the thinking block (assigned by nextBlockIndex). */
	thinkingBlockIndex: number;
	/** Index of the text content block in the Anthropic stream (assigned by nextBlockIndex). */
	textBlockIndex: number;
	promptTokens: number;
	completionTokens: number;
	cacheReadInputTokens: number;
	cacheCreationInputTokens: number;
	encounteredToolCall: boolean;
	toolCallAccumulators: Record<number, string>;
	/**
	 * Monotonic counter for Anthropic content_block indices.
	 * Each new content block (text, thinking, tool_use) gets the next value.
	 * OpenAI tool_calls[].index is used only to identify the accumulator slot,
	 * NOT as the Anthropic block index.
	 */
	nextBlockIndex: number;
	/** Maps OpenAI tool_call delta index → Anthropic content_block index. */
	toolCallBlockIndices: Record<number, number>;
	maxToolCallLength: number;
	maxToolCallIndex: number;
}

/**
 * Content block used by gateways that shape `content`/`delta.content` as an
 * array (e.g. Mistral serving GLM): `{type:"text"}` or a `{type:"thinking"}`
 * block whose `thinking` is a string or an array of text parts.
 */
export interface OpenAIContentBlock {
	type: string;
	text?: string;
	thinking?: string | OpenAIContentBlock[];
	closed?: boolean;
}

export type OpenAIStreamContent = string | OpenAIContentBlock[] | null;

export interface OpenAIStreamDelta {
	content?: OpenAIStreamContent;
	reasoning_content?: string;
	tool_calls?: Array<{
		index: number;
		id?: string;
		type?: "function";
		function?: {
			name?: string;
			arguments?: string;
		};
	}>;
}

export interface OpenAIResponse {
	id?: string;
	object?: string;
	model?: string;
	choices?: Array<{
		message?: {
			content?: OpenAIStreamContent;
			role?: string;
			tool_calls?: OpenAIToolCall[];
			reasoning_content?: string;
			/**
			 * OpenRouter-shaped gateways (kilo, openrouter, nanogpt) return
			 * reasoning here rather than in `reasoning_content`; the docs name
			 * `reasoning` as the field and `reasoning_content` as an alias. The
			 * streaming transform already accepts both (stream.ts) — this keeps
			 * the non-streaming path from silently dropping the thinking.
			 */
			reasoning?: string;
		};
		delta?: OpenAIStreamDelta;
		finish_reason?: string;
	}>;
	usage?: OpenAIUsage;
	error?: {
		message?: string;
		type?: string;
		code?: string;
	};
}

export interface AnthropicResponse {
	type: "message" | "error";
	id?: string;
	role?: string;
	content?: AnthropicContentBlock[];
	model?: string;
	stop_reason?: string;
	stop_sequence?: string;
	usage?: {
		input_tokens: number;
		output_tokens: number;
		cache_read_input_tokens?: number;
		cache_creation_input_tokens?: number;
	};
	error?: {
		type: string;
		message: string;
	};
}
