// ============================================================
// REQUEST TYPES (what codex sends to /v1/responses)
// ============================================================

export interface ResponsesRequest {
	model: string;
	input: ResponseItem[];
	instructions?: string;
	tools?: ResponsesTool[];
	tool_choice?: string | ResponsesToolChoice;
	parallel_tool_calls?: boolean;
	stream?: boolean;
	reasoning?: ResponsesReasoning;
	previous_response_id?: string | null;
	max_output_tokens?: number;
	store?: boolean;
}

// ResponseItem union — all item types codex can send
export type ResponseItem =
	| ResponseMessageItem
	| FunctionCallItem
	| FunctionCallOutputItem
	| CustomToolCallItem
	| CustomToolCallOutputItem;

export interface ResponseMessageItem {
	type: "message";
	role: "user" | "assistant";
	id?: string;
	content: ResponseContent[];
}

export type ResponseContent =
	| InputTextContent
	| OutputTextContent
	| RefusalContent
	| InputImageContent;

export interface InputTextContent {
	type: "input_text";
	text: string;
}

export interface OutputTextContent {
	type: "output_text";
	text: string;
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
	arguments: string; // JSON string
}

export interface FunctionCallOutputItem {
	type: "function_call_output";
	call_id: string;
	output: string; // JSON string
}

export interface CustomToolCallItem {
	type: "custom_tool_call";
	id?: string;
	call_id: string;
	name: string;
	arguments: string;
}

export interface CustomToolCallOutputItem {
	type: "custom_tool_call_output";
	call_id: string;
	output: string;
}

// Tool definition
export interface ResponsesTool {
	type: "function";
	name: string;
	description?: string;
	parameters?: Record<string, unknown>; // JSON Schema
	strict?: boolean;
}

export interface ResponsesToolChoice {
	type: "function";
	name: string;
}

export interface ResponsesReasoning {
	effort?: "low" | "medium" | "high";
	summary?: string;
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

export type OutputItem = OutputMessageItem | OutputFunctionCallItem;

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
	content: string | AnthropicTextContent[];
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
) => Promise<Response>;
