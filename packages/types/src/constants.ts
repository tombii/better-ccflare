/**
 * Provider names used throughout the application
 */
export const PROVIDER_NAMES = {
	ANTHROPIC: "anthropic",
	ZAI: "zai",
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
	OPENAI_COMPATIBLE: "openai-compatible", // OpenAI-compatible provider (API key)
} as const;

export type AccountMode = (typeof ACCOUNT_MODES)[keyof typeof ACCOUNT_MODES];

/**
 * Providers that support OAuth authentication
 */
export const OAUTH_PROVIDERS: ReadonlySet<ProviderName> = new Set([
	PROVIDER_NAMES.ANTHROPIC,
]);

/**
 * Providers that support usage tracking (via OAuth usage endpoint)
 */
export const USAGE_TRACKING_PROVIDERS: ReadonlySet<ProviderName> = new Set([
	PROVIDER_NAMES.ANTHROPIC,
]);

/**
 * Providers that use API key authentication
 */
export const API_KEY_PROVIDERS: ReadonlySet<ProviderName> = new Set([
	PROVIDER_NAMES.ZAI,
	PROVIDER_NAMES.OPENAI_COMPATIBLE,
]);

/**
 * Check if a provider supports OAuth authentication
 */
export function supportsOAuth(provider: string): boolean {
	return OAUTH_PROVIDERS.has(provider as ProviderName);
}

/**
 * Check if a provider supports usage tracking
 */
export function supportsUsageTracking(provider: string): boolean {
	return USAGE_TRACKING_PROVIDERS.has(provider as ProviderName);
}

/**
 * Check if a provider uses API key authentication
 */
export function usesApiKey(provider: string): boolean {
	return API_KEY_PROVIDERS.has(provider as ProviderName);
}

/**
 * Provider-specific session duration tracking configuration
 * Maps provider names to whether they require session duration tracking
 */
const PROVIDER_SESSION_TRACKING_CONFIG: Record<ProviderName, boolean> = {
	[PROVIDER_NAMES.ANTHROPIC]: true, // Anthropic has 5-hour usage windows
	[PROVIDER_NAMES.ZAI]: false, // Zai is typically pay-as-you-go
	[PROVIDER_NAMES.OPENAI_COMPATIBLE]: false, // OpenAI-compatible is typically pay-as-you-go
} as const;

/**
 * Check if a provider should have session duration tracking
 * Currently only Anthropic providers have usage windows that benefit from session tracking
 * This can be extended for other providers with similar usage window systems (OpenAI-compatible, Anthropic-compatible, etc.)
 */
export function requiresSessionDurationTracking(provider: string): boolean {
	const providerName = provider as ProviderName;
	if (providerName in PROVIDER_SESSION_TRACKING_CONFIG) {
		return PROVIDER_SESSION_TRACKING_CONFIG[providerName];
	}
	// For unknown providers, default to false (no session duration tracking)
	return false;
}

/**
 * Get provider name from account mode
 */
export function getProviderFromMode(mode: AccountMode): ProviderName {
	switch (mode) {
		case ACCOUNT_MODES.CLAUDE_OAUTH:
		case ACCOUNT_MODES.CONSOLE:
			return PROVIDER_NAMES.ANTHROPIC;
		case ACCOUNT_MODES.ZAI:
			return PROVIDER_NAMES.ZAI;
		case ACCOUNT_MODES.OPENAI_COMPATIBLE:
			return PROVIDER_NAMES.OPENAI_COMPATIBLE;
		default:
			return PROVIDER_NAMES.ANTHROPIC;
	}
}
