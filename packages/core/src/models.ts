/**
 * Centralized model definitions and constants
 * All Claude model IDs and metadata should be defined here
 */

// Full model IDs as used by the Anthropic API
export const CLAUDE_MODEL_IDS = {
	// Claude 4 models
	SONNET_4: "claude-sonnet-4-20250514",
	SONNET_4_5: "claude-sonnet-4-5-20250929",
	SONNET_4_6: "claude-sonnet-4-6",
	HAIKU_4_5: "claude-haiku-4-5-20251001",
	OPUS_4: "claude-opus-4-20250514",
	OPUS_4_1: "claude-opus-4-1-20250805",
	OPUS_4_5: "claude-opus-4-5-20251101",
	OPUS_4_6: "claude-opus-4-6",
} as const;

// Model display names
export const MODEL_DISPLAY_NAMES: Record<string, string> = {
	[CLAUDE_MODEL_IDS.SONNET_4]: "Claude Sonnet 4",
	[CLAUDE_MODEL_IDS.SONNET_4_5]: "Claude Sonnet 4.5",
	[CLAUDE_MODEL_IDS.SONNET_4_6]: "Claude Sonnet 4.6",
	[CLAUDE_MODEL_IDS.HAIKU_4_5]: "Claude Haiku 4.5",
	[CLAUDE_MODEL_IDS.OPUS_4]: "Claude Opus 4",
	[CLAUDE_MODEL_IDS.OPUS_4_1]: "Claude Opus 4.1",
	[CLAUDE_MODEL_IDS.OPUS_4_5]: "Claude Opus 4.5",
	[CLAUDE_MODEL_IDS.OPUS_4_6]: "Claude Opus 4.6",
};

// Short model names used in UI (for color mapping, etc.)
export const MODEL_SHORT_NAMES: Record<string, string> = {
	[CLAUDE_MODEL_IDS.SONNET_4]: "claude-sonnet-4",
	[CLAUDE_MODEL_IDS.SONNET_4_5]: "claude-sonnet-4.5",
	[CLAUDE_MODEL_IDS.SONNET_4_6]: "claude-sonnet-4.6",
	[CLAUDE_MODEL_IDS.HAIKU_4_5]: "claude-haiku-4.5",
	[CLAUDE_MODEL_IDS.OPUS_4]: "claude-opus-4",
	[CLAUDE_MODEL_IDS.OPUS_4_1]: "claude-opus-4.1",
	[CLAUDE_MODEL_IDS.OPUS_4_5]: "claude-opus-4.5",
	[CLAUDE_MODEL_IDS.OPUS_4_6]: "claude-opus-4.6",
};

// Default model for various contexts
export const DEFAULT_MODEL = CLAUDE_MODEL_IDS.SONNET_4_6;
export const DEFAULT_AGENT_MODEL = CLAUDE_MODEL_IDS.SONNET_4_6;

// Type for all valid model IDs
export type ClaudeModelId =
	(typeof CLAUDE_MODEL_IDS)[keyof typeof CLAUDE_MODEL_IDS];

// Helper function to get short name from full model ID
export function getModelShortName(modelId: string): string {
	return MODEL_SHORT_NAMES[modelId] || modelId;
}

// Helper function to get display name from model ID
export function getModelDisplayName(modelId: string): string {
	return MODEL_DISPLAY_NAMES[modelId] || modelId;
}

// Helper function to validate if a string is a valid model ID
export function isValidModelId(modelId: string): modelId is ClaudeModelId {
	return Object.values(CLAUDE_MODEL_IDS).includes(modelId as ClaudeModelId);
}
