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
		provider === PROVIDER_NAMES.NANOGPT ||
		provider === PROVIDER_NAMES.OPENROUTER ||
		provider === PROVIDER_NAMES.KILO ||
		provider === PROVIDER_NAMES.ALIBABA_CODING_PLAN ||
		provider === PROVIDER_NAMES.ZAI
	);
}

/**
 * Check if a provider shows quota-window usage information on the account page.
 * Anthropic and Codex show 5-hour and 7-day windows, NanoGPT shows daily/monthly,
 * and Zai exposes time/token quota windows.
 */
export function providerShowsWeeklyUsage(provider: string): boolean {
	return (
		provider === PROVIDER_NAMES.ANTHROPIC ||
		provider === PROVIDER_NAMES.CODEX ||
		provider === PROVIDER_NAMES.NANOGPT ||
		provider === PROVIDER_NAMES.ZAI
	);
}

/**
 * Check if a provider shows a credit balance (USD remaining) instead of utilization windows
 */
export function providerShowsCreditsBalance(provider: string): boolean {
	return provider === PROVIDER_NAMES.KILO;
}

/**
 * Check if a provider supports custom endpoints
 */
export function providerSupportsCustomEndpoints(provider: string): boolean {
	// Most providers support custom endpoints, but we can add specific logic if needed
	return isKnownProvider(provider);
}

/**
 * Get the default endpoint for a provider
 */
export function getDefaultEndpointForProvider(provider: string): string {
	return getDefaultEndpoint(provider);
}
