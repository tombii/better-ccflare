import {
	getModelFamily,
	isForceAccountModelEnabled,
} from "@better-ccflare/core";
import type { Account } from "@better-ccflare/types";
import {
	registerProviderModelDefaultFactory,
	resolveProviderModelDefault,
} from "../../provider-model-defaults";
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

	/**
	 * Sail serves only ids from its own listing, so a plain Claude Code request
	 * (`claude-sonnet-…`) must be translated even when the account has no
	 * mappings of its own. Authority order, most specific first:
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
			resolveProviderModelDefault("sailresearch", family, account?.id) ?? mapped
		);
	}
}
