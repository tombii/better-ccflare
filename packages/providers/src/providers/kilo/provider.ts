import type { Account } from "@better-ccflare/types";
import { OpenAICompatibleProvider } from "../openai/provider";

const KILO_DEFAULT_ENDPOINT = "https://api.kilo.ai/api/gateway";

export class KiloProvider extends OpenAICompatibleProvider {
	override name = "kilo";

	override buildUrl(path: string, query: string, account?: Account): string {
		const endpoint = (
			account?.custom_endpoint || KILO_DEFAULT_ENDPOINT
		).replace(/\/$/, "");

		// Convert Anthropic /v1/messages → OpenAI /chat/completions
		// Kilo gateway path is /api/gateway/chat/completions
		let openaiPath = path;
		if (path === "/v1/messages") {
			openaiPath = "/chat/completions";
		} else if (path.startsWith("/v1/")) {
			openaiPath = path.slice(3); // strip /v1 prefix
		}

		return `${endpoint}${openaiPath}${query}`;
	}
}
