// Export all types

// Export base provider class
export { BaseProvider } from "./base";
// Export OAuth utilities
export * from "./oauth";
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

import { AnthropicProvider } from "./providers/anthropic/provider";
import { MinimaxProvider } from "./providers/minimax/provider";
import { OpenAICompatibleProvider } from "./providers/openai/provider";
import { ZaiProvider } from "./providers/zai/provider";
// Auto-register built-in providers
import { registry } from "./registry";

registry.registerProvider(new AnthropicProvider());
registry.registerProvider(new MinimaxProvider());
registry.registerProvider(new ZaiProvider());
registry.registerProvider(new OpenAICompatibleProvider());
