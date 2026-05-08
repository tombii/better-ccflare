import { BaseAnthropicCompatibleProvider } from "../base-anthropic-compatible";

export class OllamaProvider extends BaseAnthropicCompatibleProvider {
	constructor() {
		super({
			name: "ollama",
			baseUrl: "http://localhost:11434",
			authHeader: "x-api-key",
			authType: "direct",
			supportsStreaming: true,
		});
	}

	getEndpoint(): string {
		return "http://localhost:11434";
	}
}
