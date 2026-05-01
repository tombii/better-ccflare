// OpenAI API Requests/Response Types

export interface OpenAIToolCall {
	id: string;
	type: "function";
	function: {
		name: string;
		arguments: string;
	};
}

export interface OpenAIMessage {
	role: "system" | "user" | "assistant" | "tool";
	content:
		| string
		| null
		| Array<{
				type: string;
				text?: string;
				cache_control?: { type: string };
		  }>;
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
	max_completion_tokens?: number;
	temperature?: number;
	top_p?: number;
	stop?: string | string[];
	stream?: boolean;
	stream_options?: { include_usage: boolean };
	tools?: OpenAITool[];
	tool_choice?: OpenAIToolChoice;
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
	content: string | AnthropicContent[];
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
	content: string | AnthropicContentBlock[];
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
	hasSentStart: boolean;
	hasSentContentBlockStart: boolean;
	hasSentThinkingBlockStart: boolean;
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

export interface OpenAIStreamDelta {
	content?: string;
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
			content?: string | null;
			role?: string;
			tool_calls?: OpenAIToolCall[];
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
	};
	error?: {
		type: string;
		message: string;
	};
}
