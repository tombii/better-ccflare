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
}

export interface OpenAITool {
	type: "function";
	function: {
		name: string;
		description?: string;
		parameters?: Record<string, unknown>;
	};
}

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
	content: string;
}

export interface AnthropicTextContent {
	type: "text";
	text: string;
	cache_control?: { type: string };
}

export type AnthropicContentBlock =
	| AnthropicTextContent
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
	promptTokens: number;
	completionTokens: number;
	cacheReadInputTokens: number;
	cacheCreationInputTokens: number;
	encounteredToolCall: boolean;
	toolCallAccumulators: Record<number, string>;
	maxToolCallLength: number;
	maxToolCallIndex: number;
}

export interface OpenAIStreamDelta {
	content?: string;
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
