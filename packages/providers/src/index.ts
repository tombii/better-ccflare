// Export all types

// Export base provider class
export { BaseProvider } from "./base";
// Export NanoGPT usage fetcher
export * from "./nanogpt-usage-fetcher";
// Export OAuth utilities
export * from "./oauth";
// Factory functions for creating providers
export {
	type AnthropicCompatibleConfig,
	createAnthropicCompatibleProvider,
	createProviderForService,
	PresetProviders,
} from "./providers/anthropic-compatible/factory";
// Export providers
export * from "./providers/index";
// Export registry functions
export {
	getOAuthProvider,
	getProvider,
	listOAuthProviders,
	listProviders,
	registerProvider,
} from "./registry";
export * from "./types";
// Export usage fetcher
export * from "./usage-fetcher";
// Export Zai usage fetcher
export * from "./zai-usage-fetcher";

import { AnthropicProvider } from "./providers/anthropic/provider";
import { AnthropicCompatibleProvider } from "./providers/anthropic-compatible/provider";
import { MinimaxProvider } from "./providers/minimax/provider";
import { NanoGPTProvider } from "./providers/nanogpt/provider";
import { OpenAICompatibleProvider } from "./providers/openai/provider";
import { ZaiProvider } from "./providers/zai/provider";
// Auto-register built-in providers
import { registry } from "./registry";

registry.registerProvider(new AnthropicProvider());
registry.registerProvider(new MinimaxProvider());
registry.registerProvider(new NanoGPTProvider());
registry.registerProvider(new ZaiProvider());
registry.registerProvider(new OpenAICompatibleProvider());
registry.registerProvider(new AnthropicCompatibleProvider());
