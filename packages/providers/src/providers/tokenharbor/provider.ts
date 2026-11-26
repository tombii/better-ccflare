import { AnthropicCompatibleProvider } from "../anthropic-compatible/provider";

export class TokenHarborProvider extends AnthropicCompatibleProvider {
	constructor() {
		super({
			name: "tokenharbor",
			baseUrl: "https://tokenharbor.ai",
			authHeader: "x-api-key",
			authType: "direct",
			supportsStreaming: true,
		});
	}
}
