import { createHash } from "node:crypto";
import { getEndpointUrl } from "@better-ccflare/core";
import type { OpenAIRequest } from "@better-ccflare/openai-formats";
import type { Account } from "@better-ccflare/types";

/**
 * Undocumented pod-affinity request header used by Mistral's own CLI (Vibe).
 * Mistral's prompt cache lives on individual inference pods, so every turn of
 * a conversation must reach the same pod for a byte-identical prefix to hit.
 */
export const MISTRAL_AFFINITY_HEADER = "x-affinity";

// Official Mistral API hosts: the global endpoint plus the EU and US regional
// endpoints. Matching is exact-host (never suffix-based) — see
// `isMistralEndpoint`.
const OFFICIAL_MISTRAL_HOSTS = new Set([
	"api.mistral.ai",
	"api.eu.mistral.ai",
	"api.us.mistral.ai",
]);

// Loosely mirrors a Claude session UUID (v1-v8, RFC 4122 variant). Purely a
// shape guard before hashing — not a cryptographic or exhaustive UUID
// validator.
const SESSION_UUID_RE =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const AFFINITY_ID_PREFIX = "ccflare-mistral-";
/** Truncated sha256 hex length: long enough to be collision-safe for one deployment's concurrent session count, short enough to stay a sane header value. */
const AFFINITY_ID_HASH_LENGTH = 32;

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
 * True when the account's endpoint is Mistral's API (global, EU or US). Pure
 * per-request check on the account, never on shared provider state (the
 * provider is a singleton). Matching is exact-host — a look-alike such as
 * `evil-api.mistral.ai` is not Mistral.
 */
export function isMistralEndpoint(account?: Account | null): boolean {
	if (!account) return false;
	try {
		const url = new URL(getEndpointUrl(account));
		return OFFICIAL_MISTRAL_HOSTS.has(url.hostname.toLowerCase());
	} catch {
		return false;
	}
}

/** Whether `sessionId` looks like a Claude session UUID. */
export function isValidMistralSessionId(
	sessionId: string | null | undefined,
): sessionId is string {
	return typeof sessionId === "string" && SESSION_UUID_RE.test(sessionId);
}

/**
 * Derive a privacy-safe Mistral pod-affinity id from a Claude client session id
 * (`RequestMeta.clientSessionId`, itself sourced from the request body's
 * `metadata.user_id`). Returns null when the session id is missing or
 * malformed — callers must treat null as "no affinity for this request", never
 * fall back to some other identity.
 *
 * The raw session id is NEVER included in the returned value: only a truncated
 * sha256 digest survives, one-way and unrecoverable. Derived purely from the
 * input, so the same session always yields the same id across calls and
 * processes.
 */
export function deriveMistralAffinityId(
	clientSessionId: string | null | undefined,
): string | null {
	if (!isValidMistralSessionId(clientSessionId)) return null;

	const digest = createHash("sha256")
		.update(clientSessionId.toLowerCase())
		.digest("hex");

	return `${AFFINITY_ID_PREFIX}${digest.slice(0, AFFINITY_ID_HASH_LENGTH)}`;
}

/**
 * Attach the Mistral pod-affinity header to outbound `headers` when the request
 * targets a Mistral endpoint and carries a derivable affinity id.
 *
 * A no-op for every non-Mistral endpoint, leaving `headers` byte-identical
 * (including any client-supplied `x-affinity`): the header is only meaningful
 * at Mistral. On a Mistral endpoint any client-supplied value is always
 * deleted first — it must never be trusted or forwarded verbatim — and the
 * header is set only when `affinityId` is present.
 *
 * Called from the proxy request-preparation seam (proxy-operations.ts) for the
 * same reason as the xAI conv id: `Provider.prepareHeaders` receives only
 * `(headers, accessToken, apiKey)`, with no account or RequestMeta, so the
 * affinity id computed elsewhere isn't reachable there without widening the
 * shared `Provider` interface for one provider's feature.
 */
export function applyMistralAffinityHeader(
	headers: Headers,
	account: Account | null | undefined,
	affinityId: string | null,
): void {
	if (!isMistralEndpoint(account)) return;

	headers.delete(MISTRAL_AFFINITY_HEADER);
	if (!affinityId) return;
	headers.set(MISTRAL_AFFINITY_HEADER, affinityId);
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
