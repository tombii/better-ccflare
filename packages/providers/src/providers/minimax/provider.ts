import type { Account } from "@better-ccflare/types";
import { transformRequestBodyModelForce } from "../../utils/model-mapping";
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
	 * Uses optimized direct mutation approach instead of creating new objects
	 */
	async transformRequestBody(
		request: Request,
		_account?: Account,
	): Promise<Request> {
		// Force all models to MiniMax-M2 for Minimax provider
		return transformRequestBodyModelForce(request, "MiniMax-M2");
	}
}
