/**
 * Provider names used throughout the application
 */
export const PROVIDER_NAMES = {
	ANTHROPIC: "anthropic", // Claude OAuth accounts
	CLAUDE_CONSOLE_API: "claude-console-api", // Claude API console accounts
	ZAI: "zai",
	MINIMAX: "minimax",
	ANTHROPIC_COMPATIBLE: "anthropic-compatible",
	OPENAI_COMPATIBLE: "openai-compatible",
} as const;

export type ProviderName = (typeof PROVIDER_NAMES)[keyof typeof PROVIDER_NAMES];

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
} as const;

export type AccountMode = (typeof ACCOUNT_MODES)[keyof typeof ACCOUNT_MODES];

// Functions are now imported from provider-config.ts to avoid duplication
// See the exports at the bottom of this file

/**
 * Type guard to check if a provider string is a known ProviderName
 */
export function isKnownProvider(provider: string): provider is ProviderName {
	return (Object.values(PROVIDER_NAMES) as string[]).includes(provider);
}

// Import provider configuration functions from the dedicated module
export {
	requiresSessionDurationTracking,
	PROVIDER_CONFIG,
	supportsUsageTracking,
	supportsOAuth,
	getDefaultEndpoint
} from "./provider-config";

// The usesApiKey function needs to be defined here to avoid circular dependencies
// since it depends on both isKnownProvider and the supportsOAuth function
// For now, we'll implement it directly based on our knowledge of which providers use API keys
export function usesApiKey(provider: string): boolean {
	if (!isKnownProvider(provider)) {
		return false; // Unknown providers don't use API key authentication by default
	}
	// API key providers are all providers except Anthropic OAuth
	return provider !== PROVIDER_NAMES.ANTHROPIC;
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
		default:
			return PROVIDER_NAMES.ANTHROPIC;
	}
}
