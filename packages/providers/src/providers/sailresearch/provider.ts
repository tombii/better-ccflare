import { registerProviderModelDefaultFactory } from "../../provider-model-defaults";
// Side effect: registers Sail's completion-tier adapter for the night window.
import "./tier";
import { BaseAnthropicCompatibleProvider } from "../base-anthropic-compatible";

const SAILRESEARCH_MODEL_DEFAULTS = {
	fable: "deepseek-ai/DeepSeek-V4.1-Flash-1017",
	opus: "deepseek-ai/DeepSeek-V4.1-Flash-1017",
	sonnet: "deepseek-ai/DeepSeek-V4.1-Flash-1017",
	haiku: "deepseek-ai/DeepSeek-V4.1-Flash-1017",
};

registerProviderModelDefaultFactory(
	"sailresearch",
	SAILRESEARCH_MODEL_DEFAULTS,
);

export class SailresearchProvider extends BaseAnthropicCompatibleProvider {
	constructor() {
		super({
			name: "sailresearch",
			// Sail authenticates with `Authorization: Bearer <key>`, not x-api-key.
			authHeader: "authorization",
			authType: "bearer",
			supportsStreaming: true,
			defaultModel: "deepseek-ai/DeepSeek-V4.1-Flash-1017",
		});
	}

	getEndpoint(): string {
		// No `/v1` here: the base `buildUrl` appends the client path verbatim,
		// and that path already begins with `/v1` (`/v1/messages`). Including it
		// would produce `https://api.sailresearch.com/v1/v1/messages`.
		return "https://api.sailresearch.com";
	}
}
