import { registerProviderModelDefaultFactory } from "../../provider-model-defaults";
import { BaseAnthropicCompatibleProvider } from "../base-anthropic-compatible";

/**
 * OpenCode Go subscription. Every text model on the plan is reachable through
 * the Anthropic Messages API, because OpenCode Console translates between API
 * families on the way to the upstream model.
 */

const OPENCODE_GO_DEFAULT_MODEL = "deepseek-v4.1-flash";

const OPENCODE_GO_MODEL_DEFAULTS = {
	fable: OPENCODE_GO_DEFAULT_MODEL,
	opus: OPENCODE_GO_DEFAULT_MODEL,
	sonnet: OPENCODE_GO_DEFAULT_MODEL,
	haiku: OPENCODE_GO_DEFAULT_MODEL,
};

registerProviderModelDefaultFactory("opencode-go", OPENCODE_GO_MODEL_DEFAULTS);

export class OpencodeGoProvider extends BaseAnthropicCompatibleProvider {
	constructor() {
		super({
			name: "opencode-go",
			// OpenCode Go authenticates with `Authorization: Bearer <key>`, not x-api-key.
			authHeader: "authorization",
			authType: "bearer",
			supportsStreaming: true,
			defaultModel: OPENCODE_GO_DEFAULT_MODEL,
		});
	}

	getEndpoint(): string {
		// No `/v1` here: the base `buildUrl` appends the client path verbatim,
		// and that path already begins with `/v1` (`/v1/messages`). Including it
		// would produce
		// `https://opencode.ai/inference/go/anthropic/v1/v1/messages`.
		return "https://opencode.ai/inference/go/anthropic";
	}
}
