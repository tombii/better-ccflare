import { PROVIDER_NAMES, type ProviderName, isKnownProvider } from "./constants";

/**
 * Provider-specific session duration tracking configuration
 * Maps provider names to whether they require session duration tracking
 *
 * Usage windows = providers that have fixed-duration rate limits (e.g., Anthropic's 5-hour windows)
 * Pay-as-you-go = providers that operate without fixed duration windows (e.g., API-key-based providers)
 */
export const PROVIDER_SESSION_TRACKING_CONFIG = {
	[PROVIDER_NAMES.ANTHROPIC]: true, // Anthropic OAuth has 5-hour usage windows
	[PROVIDER_NAMES.CLAUDE_CONSOLE_API]: false, // Claude console API is pay-as-you-go
	[PROVIDER_NAMES.ZAI]: false, // Zai is typically pay-as-you-go
	[PROVIDER_NAMES.MINIMAX]: false, // Minimax is pay-as-you-go
	[PROVIDER_NAMES.ANTHROPIC_COMPATIBLE]: false, // Anthropic-compatible is pay-as-you-go
	[PROVIDER_NAMES.OPENAI_COMPATIBLE]: false, // OpenAI-compatible is typically pay-as-you-go
} as const satisfies Record<ProviderName, boolean>;

/**
 * Check if a provider should have session duration tracking
 * Currently only Anthropic providers have usage windows that benefit from session tracking
 * This can be extended for other providers with similar usage window systems (OpenAI-compatible, Anthropic-compatible, etc.)
 *
 * @param provider - The provider name to check
 * @returns boolean - True if the provider requires session duration tracking, false otherwise
 *                    Unknown providers default to false (security through default denial)
 */
export function requiresSessionDurationTracking(provider: string): boolean {
	if (!isKnownProvider(provider)) {
		// Log warning for unknown providers - defaults to no session tracking (security through default denial)
		console.warn(
			`Unknown provider: ${provider}. Defaulting to no session tracking (security through default denial).`,
		);
		return false;
	}

	if (provider in PROVIDER_SESSION_TRACKING_CONFIG) {
		return PROVIDER_SESSION_TRACKING_CONFIG[provider];
	}

	// Default to false for any provider not explicitly configured (security through default denial)
	return false;
}