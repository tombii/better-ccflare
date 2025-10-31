/**
 * Utility functions for provider-specific logic in the web UI
 */

/**
 * Check if a provider supports auto-fallback and auto-refresh features
 * Currently only Anthropic OAuth accounts support these features
 */
export function providerSupportsAutoFeatures(provider: string): boolean {
	return provider === "anthropic";
}

/**
 * Check if a provider supports model mappings
 */
export function providerSupportsModelMappings(provider: string): boolean {
	return (
		provider === "openai-compatible" ||
		provider === "anthropic-compatible"
	);
}

/**
 * Check if a provider shows weekly usage information
 */
export function providerShowsWeeklyUsage(provider: string): boolean {
	return provider === "anthropic";
}

/**
 * Check if a provider supports custom endpoints
 */
export function providerSupportsCustomEndpoints(provider: string): boolean {
	// Most providers support custom endpoints, but we can add specific logic if needed
	return true;
}

/**
 * Get the default endpoint for a provider
 */
export function getDefaultEndpointForProvider(provider: string): string {
	switch (provider) {
		case "zai":
			return "https://api.z.ai/api/anthropic";
		default:
			return "https://api.anthropic.com";
	}
}