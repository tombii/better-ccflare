import {
	type AnthropicCompatibleConfig,
	AnthropicCompatibleProvider,
} from "./provider";

/**
 * Factory function to create a new AnthropicCompatibleProvider with proper configuration
 */
export function createAnthropicCompatibleProvider(
	config: AnthropicCompatibleConfig,
): AnthropicCompatibleProvider {
	return new AnthropicCompatibleProvider(config);
}

/**
 * Create a provider configured for a specific service
 */
export function createProviderForService(
	serviceName: string,
	endpoint: string,
	authHeader: string = "x-api-key",
	authType: "bearer" | "direct" = "direct",
): AnthropicCompatibleProvider {
	const config: AnthropicCompatibleConfig = {
		name: `anthropic-${serviceName}`,
		baseUrl: endpoint,
		authHeader: authHeader,
		authType: authType,
		supportsStreaming: true,
	};

	return createAnthropicCompatibleProvider(config);
}

/**
 * Pre-configured providers for common Anthropic-compatible services
 */
export const PresetProviders = {
	/**
	 * Zai-compatible provider (based on z.ai API)
	 */
	createZaiCompatible: () =>
		createProviderForService(
			"zai",
			"https://api.z.ai/api/anthropic",
			"x-api-key",
		),

	/**
	 * Minimax-compatible provider (based on MiniMax API) - uses x-api-key now
	 */
	createMinimaxCompatible: () =>
		createProviderForService(
			"minimax",
			"https://api.minimax.io/anthropic",
			"x-api-key",
		),

	/**
	 * Generic Anthropic-compatible provider with model mapping
	 */
	createWithModelMapping: (
		endpoint: string,
		mappings: Record<string, string>,
		authHeader: string = "x-api-key",
		authType: "bearer" | "direct" = "direct",
	) =>
		createAnthropicCompatibleProvider({
			name: "custom-anthropic-compatible",
			baseUrl: endpoint,
			authHeader: authHeader,
			authType: authType,
			modelMappings: mappings,
			supportsStreaming: true,
		}),
};

// Re-export the main class and config for convenience
export {
	type AnthropicCompatibleConfig,
	AnthropicCompatibleProvider,
} from "./provider";
