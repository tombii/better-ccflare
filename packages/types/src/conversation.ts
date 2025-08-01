export type Role = "user" | "assistant" | "system";

export interface ToolUse {
	id?: string;
	name: string;
	input?: Record<string, unknown>;
}

export interface ToolResult {
	tool_use_id: string;
	content: string;
}

export enum ContentBlockType {
	Text = "text",
	ToolUse = "tool_use",
	ToolResult = "tool_result",
	Thinking = "thinking",
}

export interface ContentBlock {
	type: ContentBlockType;
	text?: string;
	thinking?: string;
	id?: string;
	name?: string;
	input?: Record<string, unknown>;
	tool_use_id?: string;
	content?: string;
}

export interface MessageData {
	role: Role;
	content: string;
	contentBlocks?: ContentBlock[];
	tools?: ToolUse[];
	toolResults?: ToolResult[];
}
