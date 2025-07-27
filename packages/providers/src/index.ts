// Export all types

// Export base provider class
export { BaseProvider } from "./base.js";
// Export OAuth utilities
export { generatePKCE } from "./oauth/pkce.js";
// Export providers
export * from "./providers/index.js";
// Export registry functions
export {
	getOAuthProvider,
	getProvider,
	listOAuthProviders,
	listProviders,
	registerProvider,
} from "./registry.js";
export * from "./types.js";

import { AnthropicProvider } from "./providers/anthropic/provider.js";
// Auto-register built-in providers
import { registry } from "./registry.js";

registry.registerProvider(new AnthropicProvider());
