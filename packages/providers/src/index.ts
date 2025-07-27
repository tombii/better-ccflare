// Export all types
export * from "./types.js";

// Export registry functions
export {
	registerProvider,
	getProvider,
	getOAuthProvider,
	listProviders,
	listOAuthProviders,
} from "./registry.js";

// Export base provider class
export { BaseProvider } from "./base.js";

// Export OAuth utilities
export { generatePKCE } from "./oauth/pkce.js";

// Export providers
export * from "./providers/index.js";

// Auto-register built-in providers
import { registry } from "./registry.js";
import { AnthropicProvider } from "./providers/anthropic/provider.js";

registry.registerProvider(new AnthropicProvider());
