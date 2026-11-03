/**
 * Brave Search implementation of {@link WebToolSearchAdapter}.
 *
 * Brave ships two products on the same `/res/v1` base, both covered by the
 * same Search plan at the same $5/1k price:
 *
 *   - `GET .../res/v1/web/search` — results pages built for humans. Entries
 *     under `web.results[]` carry a short meta-description `description`.
 *   - `GET .../res/v1/llm/context` — the same index, but ranked and compiled
 *     for machine consumption: pre-extracted page chunks under
 *     `grounding.generic[].snippets[]`, with token/URL/snippet budgets the
 *     caller sets.
 *
 * `extraConfig.endpoint` selects between them (`"web"` or `"llm-context"`).
 * Anything unrecognised falls back to `web`, so existing rows keep the exact
 * behaviour they had before the option existed.
 *
 * Both are GET; parameters ride in the query string and the key travels in an
 * `X-Subscription-Token` header, not `Authorization: Bearer`.
 *
 * Brave has no include/exclude domain parameters on either endpoint, so
 * Anthropic's `allowed_domains` / `blocked_domains` are applied as a
 * POST-FILTER over the returned hits. That can only narrow what the provider
 * already returned; it cannot improve recall when an allowed domain didn't
 * rank on the first page.
 *
 * The subscription token must never appear in an error message, log line or
 * health write.
 */

import type {
	WebToolAdapterConfig,
	WebToolSearchAdapter,
	WebToolSearchHit,
	WebToolSearchRequest,
} from "../types";

export const BRAVE_SEARCH_URL =
	"https://api.search.brave.com/res/v1/web/search";
export const BRAVE_LLM_CONTEXT_URL =
	"https://api.search.brave.com/res/v1/llm/context";

/** `extraConfig.endpoint` value selecting the LLM Context product. */
const LLM_CONTEXT_ENDPOINT = "llm-context";

/**
 * Token budget for one LLM Context call. The API defaults to 8,192 tokens
 * across 20 URLs and 50 snippets; the responder truncates every snippet to
 * 500 characters anyway, so the default would pay for content that is thrown
 * away before the model ever sees it. 2,048 tokens is Brave's own figure for
 * simple factual queries and comfortably covers `maxResults` hits at the
 * responder's cap.
 */
const LLM_CONTEXT_MAX_TOKENS = 2048;

/** Brave rejects `count` above 20. */
const BRAVE_MAX_RESULTS_LIMIT = 20;
/** Used when the caller passes a non-finite `maxResults`. */
const DEFAULT_MAX_RESULTS = 10;
const SEARCH_TIMEOUT_MS = 10_000;
/** Error bodies are truncated to this many characters before being surfaced. */
const ERROR_BODY_EXCERPT_CHARS = 200;
const TEST_QUERY = "better-ccflare connectivity test";
const FRESHNESS_VALUES = new Set(["pd", "pw", "pm", "py"]);
/** The only three values Brave accepts for `safesearch`. */
const SAFESEARCH_VALUES = new Set(["off", "moderate", "strict"]);

/**
 * Error raised for a non-2xx Brave response (and for aborts).
 *
 * `status` mirrors the HTTP status so the fallback chain can decide whether
 * the failure warrants a cooldown (401/402/429) or is transient. The message
 * never contains the subscription token.
 */
export class BraveSearchError extends Error {
	constructor(
		readonly status: number,
		message: string,
	) {
		super(message);
		this.name = "BraveSearchError";
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Clamp a requested result count into Brave's accepted 0–20 range. A
 * non-finite value falls back to the shared default rather than producing
 * `NaN` in the query string.
 */
function clampMaxResults(value: number): number {
	const requested = Number.isFinite(value)
		? Math.trunc(value)
		: DEFAULT_MAX_RESULTS;
	return Math.min(BRAVE_MAX_RESULTS_LIMIT, Math.max(0, requested));
}

/**
 * The operator's per-provider `maxResults` is the binding limit: it is set in
 * the dashboard precisely to cap what one search may pull back. The caller's
 * requested count only narrows it further, never widens it.
 */
function effectiveMaxResults(
	request: WebToolSearchRequest,
	config: WebToolAdapterConfig,
): number {
	return clampMaxResults(Math.min(request.maxResults, config.maxResults));
}

/** A non-empty string from `extraConfig`, or undefined. */
function stringOption(
	config: WebToolAdapterConfig,
	key: string,
): string | undefined {
	const value = config.extraConfig[key];
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** True when the operator selected the LLM Context product. */
function usesLlmContext(config: WebToolAdapterConfig): boolean {
	return stringOption(config, "endpoint") === LLM_CONTEXT_ENDPOINT;
}

/** Build the GET URL, adding optional parameters only when configured. */
function buildSearchUrl(
	query: string,
	count: number,
	config: WebToolAdapterConfig,
): string {
	const llmContext = usesLlmContext(config);
	const url = new URL(llmContext ? BRAVE_LLM_CONTEXT_URL : BRAVE_SEARCH_URL);
	url.searchParams.set("q", query);
	url.searchParams.set("count", String(count));

	const country = stringOption(config, "country");
	if (country) url.searchParams.set("country", country);
	const searchLang = stringOption(config, "searchLang");
	if (searchLang) url.searchParams.set("search_lang", searchLang);
	// `freshness` is a web/search parameter; llm/context does not document it,
	// so it is only sent on the endpoint that accepts it.
	const freshness = stringOption(config, "freshness");
	if (!llmContext && freshness && FRESHNESS_VALUES.has(freshness)) {
		url.searchParams.set("freshness", freshness);
	}
	// The dashboard offers off/moderate/strict; Brave accepts exactly those and
	// rejects anything else, so an unknown value is dropped rather than sent.
	const safesearch = stringOption(config, "safesearch");
	if (safesearch && SAFESEARCH_VALUES.has(safesearch)) {
		url.searchParams.set("safesearch", safesearch);
	}

	// Pin the context budgets to what this request will actually keep. Without
	// them Brave returns its 8,192-token / 20-URL / 50-snippet default and the
	// responder truncates the surplus away.
	if (llmContext) {
		url.searchParams.set(
			"maximum_number_of_tokens",
			String(LLM_CONTEXT_MAX_TOKENS),
		);
		url.searchParams.set("maximum_number_of_urls", String(count));
		url.searchParams.set("maximum_number_of_snippets", String(count));
	}

	return url.toString();
}

/**
 * Strip query parameters from a URL before it goes into an error message, so
 * the user's search terms are not echoed. Called on fetch-thrown errors only —
 * never on a credential field.
 */
function redactUrl(url: string): string {
	try {
		const parsed = new URL(url);
		parsed.search = "";
		return parsed.toString();
	} catch {
		return BRAVE_SEARCH_URL;
	}
}

/**
 * Decide whether a 200 body is an LLM Context payload and return its context
 * items.
 *
 * An absent `grounding` is a valid EMPTY search (Brave omits containers it has
 * nothing for), as is an explicit `grounding.generic: []`. A `grounding` that
 * is not an object, or a `generic` that is not an array, is malformed and
 * throws — treating it as empty would mark the provider healthy and stop the
 * chain before a backup provider is tried.
 */
function contextEntries(data: unknown): unknown[] {
	if (!isRecord(data)) {
		throw new BraveSearchError(502, "Brave response is not a JSON object");
	}
	if (data.grounding === undefined) return [];
	if (!isRecord(data.grounding)) {
		throw new BraveSearchError(
			502,
			"Brave response has a malformed grounding object",
		);
	}
	if (data.grounding.generic === undefined) return [];
	if (!Array.isArray(data.grounding.generic)) {
		throw new BraveSearchError(
			502,
			"Brave response is missing the grounding.generic array",
		);
	}
	return data.grounding.generic;
}

/**
 * The `sources` map keyed by URL, used to recover a title an entry omitted.
 * Absent or malformed maps degrade to `{}` — they only ever supply a fallback
 * title, so they are not worth failing a search over.
 */
function sourceTitles(data: unknown): Record<string, unknown> {
	if (!isRecord(data) || !isRecord(data.sources)) return {};
	return data.sources;
}

/** Map LLM Context's `grounding.generic` array onto the normalised hit shape. */
function contextToHits(
	data: unknown,
	maxResults: number,
	allowedDomains: string[] | undefined,
	blockedDomains: string[] | undefined,
): WebToolSearchHit[] {
	const entries = contextEntries(data);
	const sources = sourceTitles(data);

	const hits: WebToolSearchHit[] = [];
	for (const entry of entries) {
		if (!isRecord(entry)) continue;
		const url = typeof entry.url === "string" ? entry.url : "";
		if (!url) continue;
		if (!matchesDomainFilter(url, allowedDomains, blockedDomains)) continue;

		// `snippets` are the query-relevant chunks Brave extracted from the
		// page. Joining them with a blank line keeps the chunk boundaries
		// visible to the model; the responder re-collapses whitespace and
		// truncates to its own per-snippet cap.
		const snippets = Array.isArray(entry.snippets)
			? entry.snippets.filter(
					(chunk): chunk is string =>
						typeof chunk === "string" && chunk.trim().length > 0,
				)
			: [];
		// A hit with no text is just a link the model could not have found on
		// its own — the whole point of this endpoint is the chunks, so drop it.
		if (snippets.length === 0) continue;

		const source = sources[url];
		const sourceTitle =
			isRecord(source) && typeof source.title === "string" ? source.title : "";
		const title =
			typeof entry.title === "string" && entry.title
				? entry.title
				: sourceTitle;

		hits.push({ title, url, snippet: snippets.join("\n\n") });
	}

	return hits.slice(0, clampMaxResults(maxResults));
}

/** Collapse and truncate a response body so error messages stay short. */
async function readErrorExcerpt(response: Response): Promise<string> {
	try {
		const text = (await response.text()).replace(/\s+/g, " ").trim();
		if (!text) return "";
		return text.length > ERROR_BODY_EXCERPT_CHARS
			? `${text.slice(0, ERROR_BODY_EXCERPT_CHARS)}…`
			: text;
	} catch {
		// A body that cannot be read must not mask the status error.
		return "";
	}
}

/**
 * Combine the caller's signal with the adapter's own timeout. `AbortSignal.any`
 * is available in the Bun version this repo targets (it is used in
 * `handlers/request-handler.ts`), so no manual relay is needed.
 */
function requestSignal(signal: AbortSignal | undefined): AbortSignal {
	const timeout = AbortSignal.timeout(SEARCH_TIMEOUT_MS);
	return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

/** GET a search URL from Brave, throwing {@link BraveSearchError} on failure. */
async function getSearch(
	url: string,
	apiKey: string,
	signal: AbortSignal | undefined,
): Promise<unknown> {
	const effectiveSignal = requestSignal(signal);

	let response: Response;
	try {
		response = await fetch(url, {
			method: "GET",
			headers: {
				"X-Subscription-Token": apiKey,
				Accept: "application/json",
			},
			signal: effectiveSignal,
		});
	} catch (error) {
		// An abort here is either the client disconnecting or our timeout.
		// `AbortSignal.timeout` rejects with a `TimeoutError`, a caller abort
		// with an `AbortError`; treat both the same way. Neither warrants a
		// cooldown, so the status is informational only.
		if (
			effectiveSignal.aborted ||
			(error instanceof Error &&
				(error.name === "AbortError" || error.name === "TimeoutError"))
		) {
			throw new BraveSearchError(408, "Brave search request aborted");
		}
		// A fetch-level failure (DNS, TLS, …) is not an HTTP status.
		const detail = errorMessage(error);
		throw new BraveSearchError(
			0,
			`Brave search request failed for ${redactUrl(url)}: ${detail}`,
		);
	}

	if (!response.ok) {
		const excerpt = await readErrorExcerpt(response);
		throw new BraveSearchError(
			response.status,
			`Brave search failed with status ${response.status}${excerpt ? `: ${excerpt}` : ""}`,
		);
	}

	return response.json();
}

/**
 * Decide whether a 200 body is a Brave payload and return its result list.
 *
 * Brave documents no-results responses as `{type: "web", ...}` with the `web`
 * key absent entirely, so that shape maps to `[]` — a valid EMPTY search, not
 * a failure worth falling through on. `web.results: []` is equally valid.
 *
 * Everything else is malformed and throws, including a `web` object that
 * carries no `results` array: treating that as an empty success would mark the
 * provider healthy and stop the chain before a backup provider is tried.
 */
function resultEntries(data: unknown): unknown[] {
	if (!isRecord(data)) {
		throw new BraveSearchError(502, "Brave response is not a JSON object");
	}
	if (data.web === undefined) return [];
	if (!isRecord(data.web)) {
		throw new BraveSearchError(
			502,
			"Brave response has a malformed web object",
		);
	}
	if (!Array.isArray(data.web.results)) {
		throw new BraveSearchError(
			502,
			"Brave response is missing the web.results array",
		);
	}
	return data.web.results;
}

/**
 * Lower-cased hostname of a URL, or "" when it cannot be parsed. A bare host
 * (no scheme) is accepted too, since Brave sometimes returns one for news.
 */
function hostnameOf(url: string): string {
	try {
		return new URL(url).hostname.toLowerCase();
	} catch {
		try {
			return new URL(`https://${url}`).hostname.toLowerCase();
		} catch {
			return "";
		}
	}
}

/** True when `host` is `domain` itself or a subdomain of it. */
function hostMatches(host: string, domain: string): boolean {
	const wanted = domain.toLowerCase().trim();
	if (!wanted) return false;
	return host === wanted || host.endsWith(`.${wanted}`);
}

/**
 * Apply Anthropic's domain filters as a post-filter (Brave has no native
 * parameters for them). Mirrors the tavily rule: if both lists are present,
 * the allowlist wins and the blocklist is ignored.
 */
function matchesDomainFilter(
	url: string,
	allowedDomains: string[] | undefined,
	blockedDomains: string[] | undefined,
): boolean {
	const allowed = (allowedDomains ?? []).filter((d) => d.trim().length > 0);
	const blocked = (blockedDomains ?? []).filter((d) => d.trim().length > 0);
	const host = hostnameOf(url);
	if (allowed.length > 0) {
		return host !== "" && allowed.some((domain) => hostMatches(host, domain));
	}
	if (blocked.length > 0) {
		return !blocked.some((domain) => hostMatches(host, domain));
	}
	return true;
}

/** First non-empty string among `keys`, or undefined. */
function firstString(
	entry: Record<string, unknown>,
	keys: string[],
): string | undefined {
	for (const key of keys) {
		const value = entry[key];
		if (typeof value === "string" && value) return value;
	}
	return undefined;
}

/** Map Brave's `web.results` array onto the normalised hit shape. */
function toHits(
	data: unknown,
	maxResults: number,
	allowedDomains: string[] | undefined,
	blockedDomains: string[] | undefined,
): WebToolSearchHit[] {
	const entries = resultEntries(data);

	const hits: WebToolSearchHit[] = [];
	for (const entry of entries) {
		if (!isRecord(entry)) continue;
		// Entries without a URL are unusable to the responder (it needs a
		// source link), so drop them rather than synthesising one.
		const url = typeof entry.url === "string" ? entry.url : "";
		if (!url) continue;
		if (!matchesDomainFilter(url, allowedDomains, blockedDomains)) continue;

		const hit: WebToolSearchHit = {
			title: typeof entry.title === "string" ? entry.title : "",
			url,
		};
		if (typeof entry.description === "string" && entry.description) {
			hit.snippet = entry.description;
		}
		// `page_age` is an ISO timestamp, `age` a human phrase ("2 days ago").
		// Both are opaque to the responder; prefer the more precise one.
		const publishedDate = firstString(entry, ["page_age", "age"]);
		if (publishedDate) hit.publishedDate = publishedDate;
		hits.push(hit);
	}

	return hits.slice(0, clampMaxResults(maxResults));
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** Build the Brave adapter singleton. */
export function createBraveAdapter(): WebToolSearchAdapter {
	return {
		id: "brave",
		implemented: true,

		async search(
			request: WebToolSearchRequest,
			config: WebToolAdapterConfig,
		): Promise<WebToolSearchHit[]> {
			// The chain filters keyless providers out, but a direct call must not
			// send an empty subscription token.
			if (!config.apiKey) {
				throw new Error("Brave requires an API key");
			}
			const maxResults = effectiveMaxResults(request, config);
			const data = await getSearch(
				buildSearchUrl(request.query, maxResults, config),
				config.apiKey,
				request.signal,
			);
			if (usesLlmContext(config)) {
				return contextToHits(
					data,
					maxResults,
					request.allowedDomains,
					request.blockedDomains,
				);
			}
			return toHits(
				data,
				maxResults,
				request.allowedDomains,
				request.blockedDomains,
			);
		},

		async test(
			config: WebToolAdapterConfig,
		): Promise<{ ok: boolean; latencyMs: number; error?: string }> {
			// `test()` is dashboard-facing and must never throw: every failure
			// becomes `{ ok: false, error }`.
			const started = Date.now();
			if (!config.apiKey) {
				return { ok: false, latencyMs: 0, error: "no API key configured" };
			}
			try {
				const data = await getSearch(
					buildSearchUrl(TEST_QUERY, 1, config),
					config.apiKey,
					undefined,
				);
				const latencyMs = Date.now() - started;
				try {
					if (usesLlmContext(config)) {
						contextEntries(data);
					} else {
						resultEntries(data);
					}
				} catch {
					return { ok: false, latencyMs, error: "unexpected response shape" };
				}
				return { ok: true, latencyMs };
			} catch (error) {
				return {
					ok: false,
					latencyMs: Date.now() - started,
					error: errorMessage(error),
				};
			}
		},
	};
}
