// ============================================================
// REQUEST TYPES (what codex sends to /v1/responses)
// ============================================================

export interface ResponsesRequest {
	model: string;
	input: string | ResponseItem[];
	instructions?: string;
	tools?: ResponsesTool[];
	tool_choice?: string | ResponsesToolChoice;
	parallel_tool_calls?: boolean;
	stream?: boolean;
	reasoning?: ResponsesReasoning;
	previous_response_id?: string | null;
	max_output_tokens?: number;
	store?: boolean;
	text?: Record<string, unknown>;
	temperature?: number;
	top_p?: number;
	truncation?: string;
	include?: string[];
	metadata?: Record<string, unknown>;
	service_tier?: string;
	context_management?: unknown;
	stream_options?: { reasoning_summary_delivery?: "sequential_cutoff" };
	client_metadata?: Record<string, string>;
	access_programs?: {
		cyber: "standard" | "daybreak_blue" | "daybreak_red";
	};
	/** Codex CLI's stable conversation identity for prompt-cache routing. */
	prompt_cache_key?: string;
	/** GPT-5.6+ cache controls. Implicit mode is represented by omitting mode. */
	prompt_cache_options?: {
		mode?: "explicit";
		ttl?: "30m";
		comparison_response_id?: string;
	};
}

// ResponseItem union — all item types codex can send
export type ResponseItem =
	| ResponseMessageItem
	| AdditionalToolsItem
	| FunctionCallItem
	| FunctionCallOutputItem
	| CustomToolCallItem
	| CustomToolCallOutputItem;

export interface AdditionalToolsItem {
	type: "additional_tools";
	id?: string;
	role: string;
	tools: ResponsesTool[];
}

export interface ResponseMessageItem {
	type?: "message";
	role: "user" | "assistant" | "developer" | "system";
	id?: string;
	content: string | ResponseContent[];
}

export type ResponseContent =
	| InputTextContent
	| OutputTextContent
	| RefusalContent
	| InputImageContent;

export interface InputTextContent {
	type: "input_text";
	text: string;
	prompt_cache_breakpoint?: { mode: "explicit" };
}

export interface OutputTextContent {
	type: "output_text";
	text: string;
	prompt_cache_breakpoint?: { mode: "explicit" };
}

export interface RefusalContent {
	type: "refusal";
	refusal: string;
}

export interface InputImageContent {
	type: "input_image";
	image_url?: string;
	file_id?: string;
}

export interface FunctionCallItem {
	type: "function_call";
	id?: string;
	call_id: string;
	name: string;
	namespace?: string;
	arguments: string; // JSON string
}

export interface FunctionCallOutputItem {
	type: "function_call_output";
	call_id: string;
	output: string | ResponseContent[];
}

export interface CustomToolCallItem {
	type: "custom_tool_call";
	id?: string;
	call_id: string;
	name: string;
	namespace?: string;
	input: string;
}

export interface CustomToolCallOutputItem {
	type: "custom_tool_call_output";
	call_id: string;
	output: string | ResponseContent[];
}

// Tool definition
export type ResponsesTool =
	| ResponsesFunctionTool
	| ResponsesCustomTool
	| ResponsesNamespaceTool
	| ResponsesBuiltinTool;

export interface ResponsesNamespaceTool {
	type: "namespace";
	name: string;
	description?: string;
	tools: ResponsesTool[];
}

export interface ResponsesCustomTool {
	type: "custom";
	name: string;
	namespace?: string;
	description?: string;
	format?:
		| { type: "text" }
		| { type: "grammar"; syntax: "lark" | "regex"; definition: string };
}

export interface ResponsesFunctionTool {
	type: "function";
	name: string;
	namespace?: string;
	description?: string;
	parameters?: Record<string, unknown>; // JSON Schema
	strict?: boolean;
}

export interface ResponsesBuiltinTool {
	type: "web_search_preview" | "code_interpreter" | "file_search";
	[key: string]: unknown;
}

export interface ResponsesToolChoice {
	type: "function" | "custom";
	name: string;
	namespace?: string;
}

export interface ResponsesReasoning {
	effort?: "low" | "medium" | "high";
	summary?: string;
	context?: string;
}

// ============================================================
// RESPONSE TYPES (what we send back to codex, non-streaming)
// ============================================================

export interface ResponsesResponse {
	id: string;
	object: "response";
	created_at: number;
	model: string;
	status: "completed" | "failed" | "cancelled";
	output: OutputItem[];
	usage?: ResponsesUsage;
	error?: ResponsesError;
}

export type OutputItem =
	| OutputMessageItem
	| OutputFunctionCallItem
	| OutputCustomToolCallItem;

export interface OutputCustomToolCallItem {
	type: "custom_tool_call";
	id: string;
	call_id: string;
	name: string;
	namespace?: string;
	input: string;
	status: "completed";
}

export interface OutputMessageItem {
	type: "message";
	id: string;
	role: "assistant";
	content: OutputContent[];
	status: "completed";
}

export type OutputContent = OutputTextOutputContent | OutputRefusalContent;

export interface OutputTextOutputContent {
	type: "output_text";
	text: string;
}

export interface OutputRefusalContent {
	type: "refusal";
	refusal: string;
}

export interface OutputFunctionCallItem {
	type: "function_call";
	id: string;
	call_id: string;
	name: string;
	namespace?: string;
	arguments: string; // JSON string
	status: "completed";
}

export interface ResponsesUsage {
	input_tokens: number;
	output_tokens: number;
	total_tokens: number;
}

export interface ResponsesError {
	code: string;
	message: string;
}

// ============================================================
// ANTHROPIC MESSAGE TYPES (what we translate TO)
// ============================================================

export interface AnthropicRequest {
	model: string;
	messages: AnthropicMessage[];
	system?: string;
	tools?: AnthropicTool[];
	tool_choice?: AnthropicToolChoice;
	max_tokens: number;
	stream?: boolean;
	/** Session identity surfaced the way Anthropic clients send it. */
	metadata?: { user_id?: string };
}

export interface AnthropicMessage {
	role: "user" | "assistant";
	content: AnthropicContent[];
}

export type AnthropicContent =
	| AnthropicTextContent
	| AnthropicToolUseContent
	| AnthropicToolResultContent
	| AnthropicImageContent;

export interface AnthropicTextContent {
	type: "text";
	text: string;
}

export interface AnthropicImageContent {
	type: "image";
	source:
		| { type: "url"; url: string }
		| { type: "base64"; media_type?: string; data: string };
}

export interface AnthropicToolUseContent {
	type: "tool_use";
	id: string;
	name: string;
	input: unknown; // parsed JSON object
}

export interface AnthropicToolResultContent {
	type: "tool_result";
	tool_use_id: string;
	content: string | (AnthropicTextContent | AnthropicImageContent)[];
}

export interface AnthropicTool {
	name: string;
	description?: string;
	input_schema: Record<string, unknown>;
}

export type AnthropicToolChoice =
	| { type: "auto" }
	| { type: "any" }
	| { type: "none" }
	| { type: "tool"; name: string };

// ============================================================
// ANTHROPIC RESPONSE TYPES (non-streaming, what we receive)
// ============================================================

export interface AnthropicResponse {
	id: string;
	type: "message";
	role: "assistant";
	model: string;
	content: AnthropicResponseContent[];
	stop_reason: string | null;
	stop_sequence: string | null;
	usage: AnthropicUsage;
}

export type AnthropicResponseContent =
	| AnthropicTextResponseContent
	| AnthropicToolUseResponseContent;

export interface AnthropicTextResponseContent {
	type: "text";
	text: string;
}

export interface AnthropicToolUseResponseContent {
	type: "tool_use";
	id: string;
	name: string;
	input: Record<string, unknown>;
}

export interface AnthropicUsage {
	input_tokens: number;
	output_tokens: number;
	cache_creation_input_tokens?: number;
	cache_read_input_tokens?: number;
}

// ============================================================
// HANDLER TYPE (for dependency injection in tests)
// ============================================================

export type HandleProxyFn = (
	req: Request,
	url: URL,
	ctx: unknown,
	apiKeyId?: string | null,
	apiKeyName?: string | null,
	options?: { trustedNativeResponses?: boolean },
) => Promise<Response>;
