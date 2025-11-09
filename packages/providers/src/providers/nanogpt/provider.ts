import type { Account } from "@better-ccflare/types";
import { BaseAnthropicCompatibleProvider } from "../base-anthropic-compatible";

export class NanoGPTProvider extends BaseAnthropicCompatibleProvider {
	constructor() {
		super({
			name: "nanogpt",
			baseUrl: "https://nano-gpt.com/api",
			authHeader: "x-api-key",
			authType: "direct",
			supportsStreaming: true,
			defaultModel: "nanogpt-pro",
		});
	}

	getEndpoint(): string {
		// Return the configured base URL
		return this.config.baseUrl!;
	}

	buildUrl(path: string, query: string, account?: Account): string {
		// Use custom endpoint if provided, otherwise default to configured endpoint
		const baseUrl = (account?.custom_endpoint || this.getEndpoint()).replace(
			/\/$/,
			"",
		); // Remove trailing slash
		return `${baseUrl}${path}${query}`;
	}
}
