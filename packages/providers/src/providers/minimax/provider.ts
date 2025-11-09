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

	/**
	 * Override model transformation - Minimax maps ALL models to MiniMax-M2
	 * This ensures consistent behavior regardless of input model name
	 */
	async transformRequestBody(body: any, account: any): Promise<any> {
		const transformed = await super.transformRequestBody(body, account);

		// Force all models to MiniMax-M2 regardless of input
		// Create a new object to avoid race conditions with concurrent requests
		if (
			transformed &&
			typeof transformed === "object" &&
			"model" in transformed
		) {
			return {
				...transformed,
				model: "MiniMax-M2",
			};
		}

		return transformed;
	}
}
