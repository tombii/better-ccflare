import { getEndpointUrl } from "@better-ccflare/core";
import type { OpenAIRequest } from "@better-ccflare/openai-formats";
import type { Account } from "@better-ccflare/types";

const MISTRAL_HOST = "api.mistral.ai";

/**
 * A typed reasoning chunk as emitted by Mistral inside `content`.
 * `thinking` is an array of text parts, not a bare string.
 */
interface MistralThinkingChunk {
	type: "thinking";
	thinking: Array<{ type: "text"; text: string }>;
	closed: true;
}

/**
 * True when the account's endpoint is Mistral's API. Pure per-request check on
 * the account, never on shared provider state (the provider is a singleton).
 */
export function isMistralEndpoint(account?: Account): boolean {
	if (!account) return false;
	try {
		const url = new URL(getEndpointUrl(account));
		return url.hostname.toLowerCase() === MISTRAL_HOST;
	} catch {
		return false;
	}
}

function buildChunk(text: string): MistralThinkingChunk {
	return { type: "thinking", thinking: [{ type: "text", text }], closed: true };
}

/**
 * Move each assistant message's top-level `reasoning_content` into a leading
 * typed thinking chunk of its `content`.
 *
 * Mistral's request schema is strict and has no `reasoning_content` field
 * (sending one yields HTTP 422 `Extra inputs are not permitted`); it represents
 * prior assistant thinking as `{type: "thinking", thinking: [...], closed: true}`
 * content chunks instead. The rewrite is unconditional and deterministic so
 * prefix-based prompt caching stays stable.
 *
 * Mutates `body` in place. Non-assistant messages and every other field
 * (e.g. `tool_calls`) are left untouched.
 */
export function stripMistralReasoning(body: OpenAIRequest): void {
	if (!Array.isArray(body.messages)) return;

	for (const msg of body.messages) {
		if (msg.role !== "assistant") continue;

		const reasoning = msg.reasoning_content;
		if (typeof reasoning !== "string") continue;

		delete msg.reasoning_content;

		// Blank thinking is dropped entirely: Mistral shouldn't receive empty
		// thinking parts.
		if (reasoning.trim() === "") continue;

		const chunk = buildChunk(reasoning);
		const content = msg.content;
		if (typeof content === "string" && content.length > 0) {
			msg.content = [chunk, { type: "text", text: content }];
		} else if (Array.isArray(content)) {
			msg.content = [chunk, ...content];
		} else {
			msg.content = [chunk];
		}
	}
}
