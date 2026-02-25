import type { Account } from "@better-ccflare/types";
import { AnthropicCompatibleProvider } from "../anthropic-compatible/provider";

const OPENROUTER_DEFAULT_ENDPOINT = "https://openrouter.ai/api/v1";

export class OpenRouterProvider extends AnthropicCompatibleProvider {
	constructor() {
		super({
			name: "openrouter",
			baseUrl: OPENROUTER_DEFAULT_ENDPOINT,
			authHeader: "Authorization",
			authType: "bearer",
			supportsStreaming: true,
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
