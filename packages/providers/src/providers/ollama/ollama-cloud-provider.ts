import type { Account } from "@better-ccflare/types";
import { BaseAnthropicCompatibleProvider } from "../base-anthropic-compatible";

export class OllamaCloudProvider extends BaseAnthropicCompatibleProvider {
	constructor() {
		super({
			name: "ollama-cloud",
			baseUrl: "https://ollama.com",
			authHeader: "authorization",
			authType: "bearer",
			supportsStreaming: true,
		});
	}

	getEndpoint(): string {
		return "https://ollama.com";
	}

	buildUrl(pathname: string, search: string, _account?: Account): string {
		// Ollama Cloud supports the Anthropic Messages API at /v1/messages
		const baseUrl = "https://ollama.com";
		return `${baseUrl}${pathname}${search}`;
	}

	prepareHeaders(
		headers: Headers,
		accessToken?: string,
		apiKey?: string,
	): Headers {
		const newHeaders = new Headers(headers);
		const token = accessToken || apiKey;

		if (token) {
			newHeaders.delete("authorization");
			newHeaders.set("Authorization", `Bearer ${token}`);
			newHeaders.delete("x-api-key");
			newHeaders.delete("anthropic-version");
		}

		newHeaders.delete("host");
		newHeaders.delete("accept-encoding");

		return newHeaders;
	}
}
