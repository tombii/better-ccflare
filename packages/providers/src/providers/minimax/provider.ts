import { BaseAnthropicCompatibleProvider } from "../base-anthropic-compatible";

export class MinimaxProvider extends BaseAnthropicCompatibleProvider {
	constructor() {
		super({
			name: "minimax",
			authHeader: "x-api-key",
			authType: "direct",
			supportsStreaming: true,
			defaultModel: "MiniMax-M2.7",
		});
	}

	getEndpoint(): string {
		return "https://api.minimax.io/anthropic";
	}
}
