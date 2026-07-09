import { CLAUDE_MODEL_IDS, isValidClaudeModel } from "@better-ccflare/core";

export type AgentSource = "global" | "workspace" | "plugin";

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
	/**
	 * Model preference for this agent, or `null` to inherit the session's
	 * model (Claude Code's `model: inherit` frontmatter value, or no `model:`
	 * key at all — both mean "no explicit preference").
	 */
	model: AllowedModel | null;
	/**
	 * Where `model` came from: an explicit DB preference, the agent's
	 * frontmatter, or session inheritance (no preference, no frontmatter
	 * model). Optional so registry-internal Agent objects (built before the
	 * preference merge) still type-check; only set on API responses.
	 */
	modelSource?: AgentModelSource;
	/**
	 * The registry agent's raw `model` value before the DB preference merge.
	 * Optional for the same reason as `modelSource`.
	 */
	frontmatterModel?: AllowedModel | null;
	systemPrompt: string;
	source: AgentSource;
	workspace?: string; // workspace path if source is "workspace"
	tools?: AgentTool[]; // parsed from tools: front-matter
	filePath: string; // absolute path of the markdown file
	pluginName?: string; // set only when source === "plugin"; derived from the plugin manifest key
}

/**
 * Provenance of an agent's effective `model` field:
 * - "preference": an explicit DB preference row exists for the agent.
 * - "frontmatter": no DB preference; the model comes from the agent file's
 *   frontmatter.
 * - "inherit": no DB preference and no frontmatter model; the agent
 *   inherits the session's model.
 */
export type AgentModelSource = "preference" | "frontmatter" | "inherit";

export type AgentResponse = Agent[];

// Pattern-based validation - accepts any string (validation done at runtime)
export type AllowedModel = string;

// Add validation function for backward compatibility with existing code
export function isAllowedModel(model: string): model is AllowedModel {
	return isValidClaudeModel(model);
}

// Export commonly used models for defaults (not for validation)
export const COMMON_MODELS = [
	CLAUDE_MODEL_IDS.HAIKU_4_5,
	CLAUDE_MODEL_IDS.OPUS_4,
	CLAUDE_MODEL_IDS.OPUS_4_1,
	CLAUDE_MODEL_IDS.OPUS_4_5,
	CLAUDE_MODEL_IDS.OPUS_4_6,
	CLAUDE_MODEL_IDS.OPUS_4_7,
	CLAUDE_MODEL_IDS.OPUS_4_8,
	CLAUDE_MODEL_IDS.SONNET_4,
	CLAUDE_MODEL_IDS.SONNET_4_5,
	CLAUDE_MODEL_IDS.SONNET_4_6,
	CLAUDE_MODEL_IDS.SONNET_5,
	CLAUDE_MODEL_IDS.FABLE_5,
] as const;

/** A single model entry in the live Anthropic model catalog. */
export interface ModelCatalogEntry {
	id: string;
	displayName: string;
	createdAt: string | null;
}

/** Response shape for GET /api/models. */
export interface ModelCatalogResponse {
	models: ModelCatalogEntry[];
	fetchedAt: number;
	source: "live" | "fallback";
}

/** Response shape for POST /api/models/refresh. */
export interface ModelCatalogRefreshResponse {
	success: boolean;
	error?: string;
	catalog: ModelCatalogResponse;
}
