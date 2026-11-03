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
 * `extraConfig.endpoint` selects between them (`"web"` or `"llm-context"`),
 * defaulting to `llm-context` — this adapter exists to feed a model, and the
 * chunks are the same price as the meta descriptions. Anything unrecognised
 * also falls back to `llm-context`; `web` is opt-in.
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

/** `extraConfig.endpoint` value selecting the human-oriented results page. */
const WEB_ENDPOINT = "web";

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
		/**
		 * Brave's machine code (`OPTION_NOT_IN_PLAN`, `RATE_LIMITED`, …), when
		 * the body carried one. Used to tell "this key's plan does not include
		 * LLM Context" apart from a generic 400.
		 */
		readonly code?: string,
		message = "",
	) {
		super(message);
		this.name = "BraveSearchError";
	}

	/**
	 * Brave reporting that the key's *plan* will not serve this endpoint (see
	 * {@link PLAN_EXCLUDES_ENDPOINT_DETAIL}), set by {@link getSearch}. Only the
	 * adapter reads it. It is not really a quota event: the plan simply has no
	 * LLM Context access, so waiting never helps.
	 */
	planExcludesEndpoint = false;
}

/** Brave's code for "your plan does not include this endpoint". */
const OPTION_NOT_IN_PLAN = "OPTION_NOT_IN_PLAN";

/**
 * Brave's wording when a plan allows web search but not this endpoint. It
 * arrives as HTTP 429 with "Request rate limit exceeded for plan" — the status
 * makes it look like throttling, but it is the plan's access level showing
 * through, and it does not clear with time. See
 * {@link getSearchWithPlanFallback}.
 */
const PLAN_EXCLUDES_ENDPOINT_DETAIL = /rate limit exceeded for plan/i;

/**
 * Credentials whose plan turned out not to include LLM Context. Brave bills
 * plans per key, so the answer is stable for the life of the key — remembering
 * it stops every search paying a doomed `llm/context` round-trip before
 * falling back.
 *
 * Keyed on row id PLUS a fingerprint of the key (see {@link planMemoryKey}),
 * not the row id alone: replacing the API key on a row must be able to move
 * it back onto LLM Context immediately, and a row id survives that edit. With
 * the fingerprint, a new key is simply a different entry, so upgrading a plan
 * takes effect on the next search with no restart.
 */
const plansWithoutLlmContext = new Set<string>();

/** Test seam: forget which rows fell back, so specs do not leak into each other. */
export function resetBravePlanMemory(): void {
	plansWithoutLlmContext.clear();
}

/**
 * Cache key for the plan answer: the row id plus a non-reversible fingerprint
 * of the credential, so the set never holds key material while still changing
 * when the key does. `Bun.hash` is a non-cryptographic 64-bit digest — enough
 * to tell two keys apart, and useless for recovering either.
 */
function planMemoryKey(rowId: string, apiKey: string): string {
	return `${rowId}:${Bun.hash(apiKey).toString(16)}`;
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

/**
 * True when the *configured* endpoint is LLM Context. This is the default:
 * only an explicit `endpoint: "web"` selects the human-oriented results page.
 * Whether the key's plan actually includes it is a separate question — see
 * {@link getSearchWithPlanFallback}.
 */
function usesLlmContext(config: WebToolAdapterConfig): boolean {
	return stringOption(config, "endpoint") !== WEB_ENDPOINT;
}

/**
 * Build the GET URL, adding optional parameters only when configured.
 * `llmContext` is passed in rather than derived, because the plan fallback may
 * deliberately target `web/search` on a row configured for LLM Context.
 */
function buildSearchUrl(
	query: string,
	count: number,
	config: WebToolAdapterConfig,
	llmContext: boolean,
): string {
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
		throw new BraveSearchError(
			502,
			undefined,
			"Brave response is not a JSON object",
		);
	}
	if (data.grounding === undefined) return [];
	if (!isRecord(data.grounding)) {
		throw new BraveSearchError(
			502,
			undefined,
			"Brave response has a malformed grounding object",
		);
	}
	if (data.grounding.generic === undefined) return [];
	if (!Array.isArray(data.grounding.generic)) {
		throw new BraveSearchError(
			502,
			undefined,
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

/**
 * Collapse and truncate a response body so error messages stay short, and
 * pull out Brave's machine code (`error.code`) when the body is its documented
 * `{type: "ErrorResponse", error: {status, detail, code}}` shape.
 */
async function readErrorDetail(
	response: Response,
): Promise<{ excerpt: string; code?: string; detail?: string }> {
	let text: string;
	try {
		text = await response.text();
	} catch {
		// A body that cannot be read must not mask the status error.
		return { excerpt: "" };
	}
	const collapsed = text.replace(/\s+/g, " ").trim();
	const excerpt =
		collapsed.length > ERROR_BODY_EXCERPT_CHARS
			? `${collapsed.slice(0, ERROR_BODY_EXCERPT_CHARS)}…`
			: collapsed;
	let code: string | undefined;
	let detail: string | undefined;
	try {
		const parsed: unknown = JSON.parse(text);
		if (isRecord(parsed) && isRecord(parsed.error)) {
			const raw = parsed.error.code;
			if (typeof raw === "string" && raw) code = raw;
			const rawDetail = parsed.error.detail;
			if (typeof rawDetail === "string" && rawDetail) detail = rawDetail;
		}
	} catch {
		// Not JSON — the excerpt is all we have.
	}
	return { excerpt, code, detail };
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
			throw new BraveSearchError(
				408,
				undefined,
				"Brave search request aborted",
			);
		}
		// A fetch-level failure (DNS, TLS, …) is not an HTTP status.
		const detail = errorMessage(error);
		throw new BraveSearchError(
			0,
			undefined,
			`Brave search request failed for ${redactUrl(url)}: ${detail}`,
		);
	}

	if (!response.ok) {
		const { excerpt, code, detail } = await readErrorDetail(response);
		const error = new BraveSearchError(
			response.status,
			code,
			`Brave search failed with status ${response.status}${excerpt ? `: ${excerpt}` : ""}`,
		);
		error.planExcludesEndpoint =
			response.status === 429 &&
			(detail ?? "").length > 0 &&
			PLAN_EXCLUDES_ENDPOINT_DETAIL.test(detail ?? "");
		throw error;
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
		throw new BraveSearchError(
			502,
			undefined,
			"Brave response is not a JSON object",
		);
	}
	if (data.web === undefined) return [];
	if (!isRecord(data.web)) {
		throw new BraveSearchError(
			502,
			undefined,
			"Brave response has a malformed web object",
		);
	}
	if (!Array.isArray(data.web.results)) {
		throw new BraveSearchError(
			502,
			undefined,
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

/**
 * Run one search, falling back to `web/search` when the key's Brave plan does
 * not include LLM Context.
 *
 * Plans are per key, and some plans (notably "Free AI") have web search but no
 * LLM Context access. Brave reports that in two shapes:
 *
 *   - HTTP 400 `OPTION_NOT_IN_PLAN` — the endpoint is explicitly not offered;
 *   - HTTP 429 "Request rate limit exceeded for plan" — not throttling, despite
 *     the status: the plan is simply not entitled to this endpoint, so it never
 *     clears while the endpoint stays LLM Context.
 *
 * Both are facts about the key's plan, not transient faults, so neither must
 * surface as a search failure (the chain would cool the provider down and fall
 * through to another provider for every search). Instead the row is remembered
 * in {@link plansWithoutLlmContext} and the search is served from `web/search`,
 * so the downgrade is invisible to the caller.
 *
 * Only those two failures trigger it. A 429 on a `web/search` call, or a
 * genuine 400 (bad query), is passed through untouched: retrying a different
 * endpoint would only repeat the same error.
 *
 * @returns The payload, and whether it came from the LLM Context endpoint.
 */
async function getSearchWithPlanFallback(
	query: string,
	maxResults: number,
	config: WebToolAdapterConfig,
	signal: AbortSignal | undefined,
): Promise<{ data: unknown; llmContext: boolean }> {
	// Both callers reject a keyless config before reaching here; this keeps the
	// `string` narrowing local instead of relying on that.
	if (!config.apiKey) throw new Error("Brave requires an API key");
	const apiKey = config.apiKey;
	const memoryKey = config.rowId ? planMemoryKey(config.rowId, apiKey) : null;
	const wantsLlmContext =
		usesLlmContext(config) &&
		!(memoryKey && plansWithoutLlmContext.has(memoryKey));
	if (!wantsLlmContext) {
		return {
			data: await getSearch(
				buildSearchUrl(query, maxResults, config, false),
				apiKey,
				signal,
			),
			llmContext: false,
		};
	}
	try {
		return {
			data: await getSearch(
				buildSearchUrl(query, maxResults, config, true),
				apiKey,
				signal,
			),
			llmContext: true,
		};
	} catch (error) {
		const planExcludesLlmContext =
			error instanceof BraveSearchError && error.code === OPTION_NOT_IN_PLAN;
		const planExcludesEndpoint =
			error instanceof BraveSearchError && error.planExcludesEndpoint;
		if (!planExcludesLlmContext && !planExcludesEndpoint) throw error;
		if (memoryKey) plansWithoutLlmContext.add(memoryKey);
		return {
			data: await getSearch(
				buildSearchUrl(query, maxResults, config, false),
				apiKey,
				signal,
			),
			llmContext: false,
		};
	}
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
			const { data, llmContext } = await getSearchWithPlanFallback(
				request.query,
				maxResults,
				config,
				request.signal,
			);
			if (llmContext) {
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
				// Same plan fallback as a real search, so the Test button reports
				// the endpoint the row will actually use rather than failing on a
				// plan Brave simply does not include.
				const { data, llmContext } = await getSearchWithPlanFallback(
					TEST_QUERY,
					1,
					config,
					undefined,
				);
				const latencyMs = Date.now() - started;
				try {
					if (llmContext) {
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
