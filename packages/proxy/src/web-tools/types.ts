/**
 * Shared contract for local `web_search` interception.
 *
 * BACKGROUND — read before changing anything here.
 *
 * Claude Code's `WebSearch` tool is a hybrid. The tool the model sees is a
 * normal client tool, but Claude Code satisfies it by issuing a SEPARATE
 * `/v1/messages` request whose `tools` array holds a single Anthropic SERVER
 * tool — `{"type":"web_search_20250305","name":"web_search", ...}` — and a
 * user turn reading `Perform a web search for the query: <query>`. Anthropic
 * normally executes that search and bills for it.
 *
 * Interception replaces that one request: we never forward it upstream, run
 * the query against a configured third-party provider instead, and replay the
 * exact server-tool response shape Claude Code's parser expects. That is NOT
 * an agent loop and NOT a client-tool swap — Claude Code dispatches unknown
 * client tool names to an error, so neither of those can work.
 *
 * The three modules that implement it are deliberately split:
 *   - `detect.ts`    recognises the sub-request and extracts the query;
 *   - `adapters/`    executes the search against a provider;
 *   - `responder.ts` synthesises the Anthropic response;
 *   - `intercept.ts` orchestrates the three and is the only caller with IO.
 */

import type { SearchProviderId } from "@better-ccflare/types";

/**
 * A recognised web-search helper request.
 *
 * `toolType` keeps the version string as received (`web_search_20250305`,
 * `web_search_20260209`, …). Callers must not compare it to a literal — the
 * version moves with Claude Code releases and detection matches the
 * `web_search_` prefix.
 */
export interface DetectedWebSearchRequest {
	/** The search query, already stripped of Claude Code's prompt prefix. */
	query: string;
	/** Anthropic `allowed_domains` from the tool definition, if any. */
	allowedDomains?: string[];
	/** Anthropic `blocked_domains` from the tool definition, if any. */
	blockedDomains?: string[];
	/** `max_uses` from the tool definition; informational for now. */
	maxUses: number;
	/** e.g. `web_search_20250305`. Informational — never branch on the value. */
	toolType: string;
	/** Whether the client asked for SSE (`stream: true`). */
	stream: boolean;
	/** Model from the original request body, reused in the synthesised message. */
	model: string;
}

/** Options for {@link detectWebSearchRequest}. */
export interface DetectOptions {
	/**
	 * The master toggle. Detection is a pure function, so the caller decides
	 * whether the feature is on; `false` short-circuits to `null`.
	 */
	enabled: boolean;
	/** Path of the request being handled; only `/v1/messages` qualifies. */
	pathname: string;
	/**
	 * Request headers, used for the per-request bypass
	 * (`x-better-ccflare-web-tools: off`). Omitted in tests that don't care.
	 */
	headers?: Headers;
	/** Whether the bypass header is honoured (config flag). Defaults to true. */
	bypassHeaderEnabled?: boolean;
}

/** A normalised search hit. Every adapter maps its provider's shape onto this. */
export interface WebToolSearchHit {
	title: string;
	url: string;
	/** Short description or extracted passage, when the provider offers one. */
	snippet?: string;
	/** Full extracted page text, when the provider offers it and it was asked for. */
	content?: string;
	/** ISO 8601 or provider-native date string; opaque to the responder. */
	publishedDate?: string;
}

/** What an adapter is asked to do. */
export interface WebToolSearchRequest {
	query: string;
	maxResults: number;
	allowedDomains?: string[];
	blockedDomains?: string[];
	/** Aborted when the client disconnects or the overall deadline expires. */
	signal?: AbortSignal;
}

/** Per-provider configuration, as stored in `search_providers`. */
export interface WebToolAdapterConfig {
	/** Plaintext key. Null for keyless providers. */
	apiKey: string | null;
	maxResults: number;
	extraConfig: Record<string, unknown>;
}

/**
 * A provider adapter.
 *
 * Implementations must:
 *   - honour `signal` (pass it to fetch);
 *   - return at most `maxResults` hits, best first;
 *   - throw on transport/HTTP failure so the chain can fall through to the
 *     next provider. Returning an empty array means "no results", which is a
 *     successful search and must NOT trigger fallback.
 */
export interface WebToolSearchAdapter {
	readonly id: SearchProviderId;
	/** False for catalog entries that exist in the UI but have no adapter yet. */
	readonly implemented: boolean;
	search(
		request: WebToolSearchRequest,
		config: WebToolAdapterConfig,
	): Promise<WebToolSearchHit[]>;
	/** One real, minimal search used by the dashboard's Test button. */
	test(
		config: WebToolAdapterConfig,
	): Promise<{ ok: boolean; latencyMs: number; error?: string }>;
}

/** Lookup of adapters by provider id. */
export type WebToolAdapterRegistry = Partial<
	Record<SearchProviderId, WebToolSearchAdapter>
>;

/** Args for {@link buildWebSearchResponse} in `responder.ts`. */
export interface WebSearchResponseArgs {
	request: DetectedWebSearchRequest;
	hits: WebToolSearchHit[];
	/** Trims the digest text block so one huge page can't blow the context. */
	maxResultChars: number;
}