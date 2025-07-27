import type { Provider } from "../types";
import { AnthropicProvider } from "./anthropic";

// Provider registry
const providers = new Map<string, Provider>();

// Register default providers
providers.set("anthropic", new AnthropicProvider());

export function getProvider(name: string): Provider | undefined {
	return providers.get(name);
}

export function registerProvider(provider: Provider): void {
	providers.set(provider.name, provider);
}

export function listProviders(): string[] {
	return Array.from(providers.keys());
}

// Export specific providers
export { AnthropicProvider } from "./anthropic";
