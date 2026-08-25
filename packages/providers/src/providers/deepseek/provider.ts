import { BaseAnthropicCompatibleProvider } from "../base-anthropic-compatible";

export class DeepseekProvider extends BaseAnthropicCompatibleProvider {
	constructor() {
		super({
			name: "deepseek",
			authHeader: "x-api-key",
			authType: "direct",
			supportsStreaming: true,
			defaultModel: "deepseek-v4-flash",
		});
	}

	getEndpoint(): string {
		return "https://api.deepseek.com/anthropic";
	}
}
