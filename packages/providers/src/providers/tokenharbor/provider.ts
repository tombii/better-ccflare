import type { Account } from "@better-ccflare/types";
import { BaseAnthropicCompatibleProvider } from "../base-anthropic-compatible";

export class TokenHarborProvider extends BaseAnthropicCompatibleProvider {
	constructor() {
		super({
			name: "tokenharbor",
			authHeader: "x-api-key",
			authType: "direct",
			supportsStreaming: true,
		});
	}

	getEndpoint(): string {
		return "https://tokenharbor.ai";
	}

	/**
	 * The base buildUrl ignores custom_endpoint, but an account may point at a
	 * mirror of the same gateway. Mirrors AnthropicCompatibleProvider's override.
	 */
	buildUrl(path: string, query: string, account?: Account): string {
		const baseUrl = (account?.custom_endpoint || this.getEndpoint()).replace(
			/\/$/,
			"",
		);
		return `${baseUrl}${path}${query}`;
	}
}
