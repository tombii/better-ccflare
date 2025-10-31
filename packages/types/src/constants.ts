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

/**
 * Providers that support OAuth authentication
 */
export const OAUTH_PROVIDERS: ReadonlySet<ProviderName> = new Set([
	PROVIDER_NAMES.ANTHROPIC,
	// CLAUDE_CONSOLE_API is API key based, not OAuth
	// MINIMAX is API key based, not OAuth
	// ANTHROPIC_COMPATIBLE is API key based, not OAuth
	// OPENAI_COMPATIBLE is API key based, not OAuth
]);

/**
 * Providers that support usage tracking (via OAuth usage endpoint)
 */
export const USAGE_TRACKING_PROVIDERS: ReadonlySet<ProviderName> = new Set([
	PROVIDER_NAMES.ANTHROPIC,
	// CLAUDE_CONSOLE_API doesn't support usage tracking (pay-as-you-go)
	// MINIMAX doesn't support usage tracking (pay-as-you-go)
	// ANTHROPIC_COMPATIBLE doesn't support usage tracking (pay-as-you-go)
	// OPENAI_COMPATIBLE doesn't support usage tracking (pay-as-you-go)
]);

/**
 * Providers that use API key authentication
 */
export const API_KEY_PROVIDERS: ReadonlySet<ProviderName> = new Set([
	PROVIDER_NAMES.ZAI,
	PROVIDER_NAMES.MINIMAX,
	PROVIDER_NAMES.ANTHROPIC_COMPATIBLE,
	PROVIDER_NAMES.OPENAI_COMPATIBLE,
	PROVIDER_NAMES.CLAUDE_CONSOLE_API, // Claude console API uses API key authentication
]);

/**
 * Check if a provider supports OAuth authentication
 */
export function supportsOAuth(provider: string): boolean {
	if (!isKnownProvider(provider)) {
		return false; // Unknown providers don't support OAuth
	}
	return OAUTH_PROVIDERS.has(provider as ProviderName);
}

/**
 * Check if a provider supports usage tracking
 */
export function supportsUsageTracking(provider: string): boolean {
	if (!isKnownProvider(provider)) {
		return false; // Unknown providers don't support usage tracking
	}
	return USAGE_TRACKING_PROVIDERS.has(provider as ProviderName);
}

/**
 * Check if a provider uses API key authentication
 */
export function usesApiKey(provider: string): boolean {
	if (!isKnownProvider(provider)) {
		return false; // Unknown providers don't use API key authentication by default
	}
	return API_KEY_PROVIDERS.has(provider as ProviderName);
}

/**
 * Type guard to check if a provider string is a known ProviderName
 */
export function isKnownProvider(provider: string): provider is ProviderName {
	return (Object.values(PROVIDER_NAMES) as string[]).includes(provider);
}

// Import provider configuration functions from the dedicated module
export {
	requiresSessionDurationTracking,
	PROVIDER_SESSION_TRACKING_CONFIG
} from "./provider-config";

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
