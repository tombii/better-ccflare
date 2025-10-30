import { BaseAnthropicCompatibleProvider } from "../base-anthropic-compatible";

export class MinimaxProvider extends BaseAnthropicCompatibleProvider {
	constructor() {
		super({
			name: "minimax",
			authHeader: "x-api-key", // Fixed to use x-api-key as requested
			authType: "direct",
			supportsStreaming: true,
			defaultModel: "MiniMax-M2",
		});
	}

	getEndpoint(): string {
		// Minimax provider only supports the official API endpoint
		return "https://api.minimax.io/anthropic";
	}
}
