import type { Account } from "@better-ccflare/types";
import { AnthropicCompatibleProvider } from "../anthropic-compatible/provider";

const OPENROUTER_DEFAULT_ENDPOINT = "https://openrouter.ai/api";

export class OpenRouterProvider extends AnthropicCompatibleProvider {
	constructor() {
		super({
			name: "openrouter",
			baseUrl: OPENROUTER_DEFAULT_ENDPOINT,
			// Lowercase on purpose: BaseAnthropicCompatibleProvider.prepareHeaders
			// picks the bearer branch on a case-sensitive comparison against
			// "authorization". A capitalised spelling silently sent the bare key,
			// which OpenRouter rejects with 401 "Missing Authentication header"
			// before it ever looks the key up. The other bearer providers
			// (meta, vertex-ai) already spell it lowercase.
			authHeader: "authorization",
			authType: "bearer",
			supportsStreaming: true,
			// OpenRouter honours the `provider` routing object.
			supportsProviderRouting: true,
		});
	}

	override getEndpoint(): string {
		return OPENROUTER_DEFAULT_ENDPOINT;
	}

	override buildUrl(
		pathname: string,
		search: string,
		account?: Account,
	): string {
		const baseUrl = (
			account?.custom_endpoint || OPENROUTER_DEFAULT_ENDPOINT
		).replace(/\/$/, "");
		return `${baseUrl}${pathname}${search}`;
	}
}
