import {
	getModelFamily,
	isForceAccountModelEnabled,
} from "@better-ccflare/core";
import type { Account } from "@better-ccflare/types";
import {
	registerProviderModelDefaultFactory,
	resolveProviderModelDefault,
} from "../../provider-model-defaults";
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

	/**
	 * OpenCode Go serves only ids from its own listing, so a plain Claude Code
	 * request (`claude-sonnet-…`) must be translated even when the account has
	 * no mappings of its own. Authority order, most specific first:
	 *
	 *   1. an explicit account mapping (exact or family) — already applied by
	 *      the base method, so a changed model means it won
	 *   2. the operator's "force account model" switch — never rewrite
	 *   3. the operator's per-family override for this provider
	 *   4. what this account's own model listing implies
	 *   5. the provider's built-in default
	 */
	protected override mapModelForRequest(
		model: string,
		account?: Account,
	): string {
		const mapped = super.mapModelForRequest(model, account);
		if (isForceAccountModelEnabled()) return mapped;
		if (mapped !== model) return mapped;

		const family = getModelFamily(model);
		if (!family) return mapped;

		return (
			resolveProviderModelDefault("opencode-go", family, account?.id) ?? mapped
		);
	}
}
