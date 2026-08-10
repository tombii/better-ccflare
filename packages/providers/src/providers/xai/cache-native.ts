import { createHash } from "node:crypto";
import { getEndpointUrl } from "@better-ccflare/core";
import type { Account } from "@better-ccflare/types";

/**
 * Opt-in flag for the xAI cache-native conversation identity minimal slice
 * (issue #319): conv-id header + sticky account affinity only. Default OFF —
 * every function below is a no-op (or returns null/false) unless this is
 * exactly "1", so the flag-off path is byte-for-byte the pre-existing
 * behavior.
 */
export const XAI_CACHE_NATIVE_ENV = "CCFLARE_XAI_CACHE_NATIVE";

/** Official xAI Chat Completions conversation-affinity header (xAI docs). */
export const XAI_CONV_ID_HEADER = "x-grok-conv-id";

// Mirrors XaiProvider.XAI_DEFAULT_ENDPOINT (./provider.ts). Duplicated
// (not imported) to avoid a cache-native.ts <-> provider.ts import cycle:
// provider-facing callers (proxy-operations.ts) import this module, and this
// module has no reason to import the provider class itself.
const XAI_DEFAULT_ENDPOINT = "https://api.x.ai/v1";
const OFFICIAL_XAI_HOSTS = new Set(["api.x.ai"]);

// Loosely mirrors a Claude session UUID (v1-v8, RFC 4122 variant). Purely a
// shape guard before hashing — not a cryptographic or exhaustive UUID
// validator.
const SESSION_UUID_RE =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const CONV_ID_PREFIX = "ccflare-xai-";
/** Truncated sha256 hex length: long enough to be collision-safe for one deployment's concurrent session count, short enough to stay a sane header value. */
const CONV_ID_HASH_LENGTH = 32;

/** Whether the xAI cache-native minimal slice is enabled. */
export function isXaiCacheNativeEnabled(
	env: NodeJS.ProcessEnv = process.env,
): boolean {
	return env[XAI_CACHE_NATIVE_ENV] === "1";
}

/**
 * Whether `account` targets official xAI infrastructure (api.x.ai). A
 * custom or proxy endpoint must never receive the cache-native affinity
 * header or participate in sticky affinity — conv-id partitioning is only
 * meaningful against xAI's own cache. Invalid custom endpoints fall back to
 * the official default, matching XaiProvider.buildUrl's own fallback
 * behavior. A missing account has nothing to disqualify it, so it defaults
 * to "official".
 */
export function isOfficialXaiEndpoint(account?: Account | null): boolean {
	if (account && account.provider !== "xai") return false;

	let endpoint = XAI_DEFAULT_ENDPOINT;
	try {
		endpoint = account?.custom_endpoint
			? getEndpointUrl(account)
			: XAI_DEFAULT_ENDPOINT;
	} catch {
		endpoint = XAI_DEFAULT_ENDPOINT;
	}

	try {
		return OFFICIAL_XAI_HOSTS.has(new URL(endpoint).hostname.toLowerCase());
	} catch {
		return false;
	}
}

/** Whether `sessionId` looks like a Claude session UUID. */
export function isValidSessionId(
	sessionId: string | null | undefined,
): sessionId is string {
	return typeof sessionId === "string" && SESSION_UUID_RE.test(sessionId);
}

/**
 * Derive a privacy-safe xAI conversation id from a Claude client session id
 * (`RequestMeta.clientSessionId`, itself sourced from the request body's
 * `metadata.user_id`). Returns null when the feature is disabled, or the
 * session id is missing/malformed — callers must treat null as "no affinity
 * for this request", never fall back to some other identity.
 *
 * The raw session id is NEVER included in the returned value: only a
 * truncated sha256 digest survives, one-way and unrecoverable. This is the
 * single derivation point — both the header attachment and the sticky
 * account-affinity map (packages/proxy/src/handlers/account-selector.ts)
 * consume the same value via the `RequestMeta`-keyed WeakMap side channel,
 * so the two can never disagree on identity for a given request.
 */
export function deriveXaiConvId(
	clientSessionId: string | null | undefined,
	env: NodeJS.ProcessEnv = process.env,
): string | null {
	if (!isXaiCacheNativeEnabled(env)) return null;
	if (!isValidSessionId(clientSessionId)) return null;

	const digest = createHash("sha256")
		.update(clientSessionId.toLowerCase())
		.digest("hex");

	return `${CONV_ID_PREFIX}${digest.slice(0, CONV_ID_HASH_LENGTH)}`;
}

/**
 * Attach the xAI conversation-affinity header to outbound `headers` when
 * (and only when) the request is xai-routed, targets the official xAI
 * endpoint, and carries a derivable conv id. A no-op in every other case,
 * including when `convId` is null (feature disabled or id not derivable) —
 * see `deriveXaiConvId`.
 *
 * Called from the proxy request-preparation seam (proxy-operations.ts)
 * rather than from `Provider.prepareHeaders`: that hook receives only
 * `(headers, accessToken, apiKey)`, with no account or RequestMeta, so the
 * conv id computed elsewhere isn't reachable there without widening the
 * shared `Provider` interface for one provider's feature.
 *
 * Always overwrites any pre-existing header value — a client-supplied
 * `x-grok-conv-id` must never be trusted or forwarded verbatim.
 */
export function applyXaiConvIdHeader(
	headers: Headers,
	providerName: string,
	account: Account,
	convId: string | null,
): void {
	// Strip unconditionally first: a client-supplied x-grok-conv-id must never
	// reach any upstream, including when this function is about to no-op below
	// (feature disabled, non-xai provider, or a custom/proxy xai endpoint).
	headers.delete(XAI_CONV_ID_HEADER);
	if (providerName !== "xai") return;
	if (!convId) return;
	if (!isOfficialXaiEndpoint(account)) return;
	headers.set(XAI_CONV_ID_HEADER, convId);
}
