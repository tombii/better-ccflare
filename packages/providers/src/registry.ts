import type { OAuthProvider, Provider } from "./types";

class ProviderRegistry {
	private providers = new Map<string, Provider>();
	private oauthProviders = new Map<string, OAuthProvider>();

	/**
	 * Register a provider
	 */
	registerProvider(provider: Provider): void {
		this.providers.set(provider.name, provider);

		// Auto-register OAuth provider if supported
		if (
			"supportsOAuth" in provider &&
			typeof provider.supportsOAuth === "function" &&
			"getOAuthProvider" in provider &&
			typeof provider.getOAuthProvider === "function"
		) {
			const supportsOAuth = provider.supportsOAuth as () => boolean;
			if (supportsOAuth()) {
				const getOAuthProvider =
					provider.getOAuthProvider as () => OAuthProvider;
				const oauthProvider = getOAuthProvider();
				this.oauthProviders.set(provider.name, oauthProvider);
			}
		}
	}

	/**
	 * Get a provider by name
	 */
	getProvider(name: string): Provider | undefined {
		return this.providers.get(name);
	}

	/**
	 * Get an OAuth provider by name
	 */
	getOAuthProvider(name: string): OAuthProvider | undefined {
		return this.oauthProviders.get(name);
	}

	/**
	 * List all registered provider names
	 */
	listProviders(): string[] {
		return Array.from(this.providers.keys());
	}

	/**
	 * List all providers that support OAuth
	 */
	listOAuthProviders(): string[] {
		return Array.from(this.oauthProviders.keys());
	}

	/**
	 * Unregister a provider (useful for testing)
	 */
	unregisterProvider(name: string): boolean {
		this.oauthProviders.delete(name);
		return this.providers.delete(name);
	}

	/**
	 * Clear all providers (useful for testing)
	 */
	clear(): void {
		this.providers.clear();
		this.oauthProviders.clear();
	}
}

// Create singleton registry instance
export const registry = new ProviderRegistry();

// Export convenience functions
export const registerProvider = (provider: Provider) =>
	registry.registerProvider(provider);
export const getProvider = (name: string) => registry.getProvider(name);
export const getOAuthProvider = (name: string) =>
	registry.getOAuthProvider(name);
export const listProviders = () => registry.listProviders();
export const listOAuthProviders = () => registry.listOAuthProviders();
