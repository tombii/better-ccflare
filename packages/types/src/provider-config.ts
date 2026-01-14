/**
 * Provider names - duplicated here to avoid circular dependencies
 */
export const PROVIDER_NAMES = {
	ANTHROPIC: "anthropic", // Claude OAuth accounts
	CLAUDE_CONSOLE_API: "claude-console-api", // Claude API console accounts
	ZAI: "zai",
	MINIMAX: "minimax",
	ANTHROPIC_COMPATIBLE: "anthropic-compatible",
	OPENAI_COMPATIBLE: "openai-compatible",
	NANOGPT: "nanogpt",
	VERTEX_AI: "vertex-ai",
} as const;

export type ProviderName = (typeof PROVIDER_NAMES)[keyof typeof PROVIDER_NAMES];

/**
 * Type guard to check if a provider string is a known ProviderName
 */
export function isKnownProvider(provider: string): provider is ProviderName {
	return (Object.values(PROVIDER_NAMES) as string[]).includes(provider);
}

/**
 * Detailed provider configuration interface
 */
export interface ProviderConfig {
	/** Whether the provider requires session duration tracking (usage windows like Anthropic's 5-hour windows) */
	requiresSessionTracking: boolean;
	/** Whether the provider supports usage tracking via OAuth usage endpoint */
	supportsUsageTracking: boolean;
	/** Whether the provider supports OAuth authentication */
	supportsOAuth: boolean;
	/** Default API endpoint for the provider */
	defaultEndpoint?: string;
}

/**
 * Provider-specific configuration mapping
 */
export const PROVIDER_CONFIG: Record<ProviderName, ProviderConfig> = {
	[PROVIDER_NAMES.ANTHROPIC]: {
		requiresSessionTracking: true, // Anthropic OAuth has 5-hour usage windows
		supportsUsageTracking: true, // Anthropic OAuth supports usage tracking
		supportsOAuth: true, // Anthropic OAuth uses OAuth authentication
		defaultEndpoint: "https://api.anthropic.com",
	},
	[PROVIDER_NAMES.CLAUDE_CONSOLE_API]: {
		requiresSessionTracking: false, // Claude console API is pay-as-you-go
		supportsUsageTracking: false, // Claude console API doesn't support usage tracking
		supportsOAuth: false, // Claude console API uses API key authentication
		defaultEndpoint: "https://api.anthropic.com",
	},
	[PROVIDER_NAMES.ZAI]: {
		requiresSessionTracking: false, // Zai is typically pay-as-you-go
		supportsUsageTracking: true, // Zai supports usage tracking via monitoring API
		supportsOAuth: false, // Zai uses API key authentication
		defaultEndpoint: "https://api.z.ai/api/anthropic",
	},
	[PROVIDER_NAMES.MINIMAX]: {
		requiresSessionTracking: false, // Minimax is pay-as-you-go
		supportsUsageTracking: false, // Minimax doesn't support usage tracking
		supportsOAuth: false, // Minimax uses API key authentication
		defaultEndpoint: "https://api.minimax.io/anthropic",
	},
	[PROVIDER_NAMES.ANTHROPIC_COMPATIBLE]: {
		requiresSessionTracking: false, // Anthropic-compatible is pay-as-you-go
		supportsUsageTracking: false, // Anthropic-compatible providers typically don't support usage tracking
		supportsOAuth: false, // Anthropic-compatible uses API key authentication
		defaultEndpoint: "https://api.anthropic.com", // Default, can be overridden via custom endpoint
	},
	[PROVIDER_NAMES.OPENAI_COMPATIBLE]: {
		requiresSessionTracking: false, // OpenAI-compatible is typically pay-as-you-go
		supportsUsageTracking: false, // OpenAI-compatible providers typically don't support usage tracking
		supportsOAuth: false, // OpenAI-compatible uses API key authentication
		defaultEndpoint: "https://api.anthropic.com", // Default, can be overridden via custom endpoint
	},
	[PROVIDER_NAMES.NANOGPT]: {
		requiresSessionTracking: false, // NanoGPT is pay-as-you-go (no session stickiness)
		supportsUsageTracking: true, // NanoGPT supports subscription usage tracking via API
		supportsOAuth: false, // NanoGPT uses API key authentication
		defaultEndpoint: "https://nano-gpt.com/api", // Default, can be overridden via custom endpoint
	},
	[PROVIDER_NAMES.VERTEX_AI]: {
		requiresSessionTracking: false, // Vertex AI is pay-as-you-go via Google Cloud billing
		supportsUsageTracking: false, // Vertex AI doesn't have a usage tracking API
		supportsOAuth: false, // Vertex AI uses Google Cloud authentication (not Anthropic OAuth)
		defaultEndpoint: "https://aiplatform.googleapis.com",
	},
} as const satisfies Record<ProviderName, ProviderConfig>;

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

	if (provider in PROVIDER_CONFIG) {
		return PROVIDER_CONFIG[provider].requiresSessionTracking;
	}

	// Default to false for any provider not explicitly configured (security through default denial)
	return false;
}

/**
 * Check if a provider supports usage tracking
 *
 * @param provider - The provider name to check
 * @returns boolean - True if the provider supports usage tracking, false otherwise
 *                    Unknown providers default to false (security through default denial)
 */
export function supportsUsageTracking(provider: string): boolean {
	if (!isKnownProvider(provider)) {
		// Log warning for unknown providers - defaults to no usage tracking (security through default denial)
		console.warn(
			`Unknown provider: ${provider}. Defaulting to no usage tracking (security through default denial).`,
		);
		return false;
	}

	if (provider in PROVIDER_CONFIG) {
		return PROVIDER_CONFIG[provider].supportsUsageTracking;
	}

	// Default to false for any provider not explicitly configured (security through default denial)
	return false;
}

/**
 * Check if a provider supports OAuth authentication
 *
 * @param provider - The provider name to check
 * @returns boolean - True if the provider supports OAuth, false otherwise
 *                    Unknown providers default to false (security through default denial)
 */
export function supportsOAuth(provider: string): boolean {
	if (!isKnownProvider(provider)) {
		// Log warning for unknown providers - defaults to no OAuth support (security through default denial)
		console.warn(
			`Unknown provider: ${provider}. Defaulting to no OAuth support (security through default denial).`,
		);
		return false;
	}

	if (provider in PROVIDER_CONFIG) {
		return PROVIDER_CONFIG[provider].supportsOAuth;
	}

	// Default to false for any provider not explicitly configured (security through default denial)
	return false;
}

/**
 * Get the default endpoint for a provider
 *
 * @param provider - The provider name to check
 * @returns string - The default endpoint for the provider, or a fallback if unknown
 */
export function getDefaultEndpoint(provider: string): string {
	if (!isKnownProvider(provider)) {
		// Log warning for unknown providers - return a default fallback
		console.warn(`Unknown provider: ${provider}. Using fallback endpoint.`);
		return "https://api.anthropic.com";
	}

	if (provider in PROVIDER_CONFIG) {
		return (
			PROVIDER_CONFIG[provider].defaultEndpoint || "https://api.anthropic.com"
		);
	}

	// Default to Anthropic API endpoint for any provider not explicitly configured
	return "https://api.anthropic.com";
}
