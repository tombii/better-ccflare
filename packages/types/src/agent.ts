import { CLAUDE_MODEL_IDS, isValidClaudeModel } from "@better-ccflare/core";

export type AgentSource = "global" | "workspace";

export type AgentTool =
	| "Bash"
	| "Glob"
	| "Grep"
	| "LS"
	| "Read"
	| "Edit"
	| "MultiEdit"
	| "Write"
	| "NotebookRead"
	| "NotebookEdit"
	| "WebFetch"
	| "TodoWrite"
	| "WebSearch";

export interface AgentWorkspace {
	path: string;
	name: string;
	lastSeen: number; // timestamp
}

export interface Agent {
	id: string;
	name: string;
	description: string;
	color: string;
	model: AllowedModel;
	systemPrompt: string;
	source: AgentSource;
	workspace?: string; // workspace path if source is "workspace"
	tools?: AgentTool[]; // parsed from tools: front-matter
	filePath: string; // absolute path of the markdown file
}

export type AgentResponse = Agent[];

// Pattern-based validation - accepts any string (validation done at runtime)
export type AllowedModel = string;

// Add validation function for backward compatibility with existing code
export function isAllowedModel(model: string): model is AllowedModel {
	return isValidClaudeModel(model);
}

// Export commonly used models for defaults (not for validation)
export const COMMON_MODELS = [
	CLAUDE_MODEL_IDS.OPUS_4,
	CLAUDE_MODEL_IDS.OPUS_4_1,
	CLAUDE_MODEL_IDS.OPUS_4_5,
	CLAUDE_MODEL_IDS.OPUS_4_6,
	CLAUDE_MODEL_IDS.SONNET_4,
	CLAUDE_MODEL_IDS.SONNET_4_5,
	CLAUDE_MODEL_IDS.SONNET_4_6,
] as const;
