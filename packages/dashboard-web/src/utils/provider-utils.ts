/**
 * Utility functions for provider-specific logic in the web UI
 */
import {
	getDefaultEndpoint,
	isKnownProvider,
	PROVIDER_NAMES,
} from "@better-ccflare/types";

/**
 * Check if a provider supports auto-fallback and auto-refresh features
 * Currently only Anthropic OAuth accounts support these features
 */
export function providerSupportsAutoFeatures(provider: string): boolean {
	return provider === PROVIDER_NAMES.ANTHROPIC;
}

/**
 * Check if a provider supports model mappings
 */
export function providerSupportsModelMappings(provider: string): boolean {
	return (
		provider === PROVIDER_NAMES.OPENAI_COMPATIBLE ||
		provider === PROVIDER_NAMES.ANTHROPIC_COMPATIBLE ||
		provider === PROVIDER_NAMES.NANOGPT
	);
}

/**
 * Check if a provider shows weekly usage information
 */
export function providerShowsWeeklyUsage(provider: string): boolean {
	return provider === PROVIDER_NAMES.ANTHROPIC;
}

/**
 * Check if a provider supports custom endpoints
 */
export function providerSupportsCustomEndpoints(provider: string): boolean {
	// Most providers support custom endpoints, but some like nanogpt do not
	return isKnownProvider(provider) && provider !== PROVIDER_NAMES.NANOGPT;
}

/**
 * Get the default endpoint for a provider
 */
export function getDefaultEndpointForProvider(provider: string): string {
	return getDefaultEndpoint(provider);
}
