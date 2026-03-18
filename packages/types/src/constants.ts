// Import provider definitions from the centralized provider-config module
// This avoids circular dependencies
import {
	getDefaultEndpoint,
	isKnownProvider,
	PROVIDER_CONFIG,
	PROVIDER_NAMES,
	type ProviderName,
	requiresSessionDurationTracking,
	supportsOAuth,
	supportsUsageTracking,
	usesStaticApiKey,
} from "./provider-config";

// Re-export the imported types and constants
export {
	PROVIDER_NAMES,
	type ProviderName,
	isKnownProvider,
	getDefaultEndpoint,
	PROVIDER_CONFIG,
	requiresSessionDurationTracking,
	supportsOAuth,
	supportsUsageTracking,
	usesStaticApiKey,
};

/**
 * Account modes for adding new accounts
 */
export const ACCOUNT_MODES = {
	CLAUDE_OAUTH: "claude-oauth", // Claude CLI OAuth account
	CONSOLE: "console", // Claude API account
	ZAI: "zai", // z.ai account (API key)
	MINIMAX: "minimax", // Minimax account (API key)
	ANTHROPIC_COMPATIBLE: "anthropic-compatible", // Anthropic-compatible provider (API key)
	OPENAI_COMPATIBLE: "openai-compatible", // OpenAI-compatible provider (API key)
	NANOGPT: "nanogpt", // NanoGPT provider (API key)
} as const;

export type AccountMode = (typeof ACCOUNT_MODES)[keyof typeof ACCOUNT_MODES];

/**
 * @deprecated Use `usesStaticApiKey` instead — this incorrectly returned true for cloud credential providers (vertex-ai, bedrock).
 */
export function usesApiKey(provider: string): boolean {
	return usesStaticApiKey(provider);
}

/**
 * Get provider name from account mode
 */
export function getProviderFromMode(mode: AccountMode): ProviderName {
	switch (mode) {
		case ACCOUNT_MODES.CLAUDE_OAUTH:
			return PROVIDER_NAMES.ANTHROPIC;
		case ACCOUNT_MODES.CONSOLE:
			return PROVIDER_NAMES.CLAUDE_CONSOLE_API;
		case ACCOUNT_MODES.ZAI:
			return PROVIDER_NAMES.ZAI;
		case ACCOUNT_MODES.MINIMAX:
			return PROVIDER_NAMES.MINIMAX;
		case ACCOUNT_MODES.ANTHROPIC_COMPATIBLE:
			return PROVIDER_NAMES.ANTHROPIC_COMPATIBLE;
		case ACCOUNT_MODES.OPENAI_COMPATIBLE:
			return PROVIDER_NAMES.OPENAI_COMPATIBLE;
		case ACCOUNT_MODES.NANOGPT:
			return PROVIDER_NAMES.NANOGPT;
		default:
			return PROVIDER_NAMES.ANTHROPIC;
	}
}
