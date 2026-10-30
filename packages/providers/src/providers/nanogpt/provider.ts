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

	/**
	 * NanoGPT honours OpenRouter-style `provider` routing objects, but only on
	 * its own host: buildUrl lets an account point at a custom endpoint, which
	 * is typically a third-party Anthropic-shaped gateway that 400s on an
	 * unknown `provider` field. Routing is therefore a per-account capability.
	 */
	override supportsProviderRoutingFor(account?: Account): boolean {
		let host: string;
		try {
			host = new URL(
				(account?.custom_endpoint || this.getEndpoint()).replace(/\/$/, ""),
			).hostname.toLowerCase();
		} catch {
			return false;
		}
		return host === "nano-gpt.com" || host === "api.nano-gpt.com";
	}

	getEndpoint(): string {
		// Return the configured base URL
		return this.config.baseUrl || "https://nano-gpt.com/api";
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
