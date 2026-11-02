/**
 * Brave Search implementation of {@link WebToolSearchAdapter}.
 *
 * `GET https://api.search.brave.com/res/v1/web/search` — the only adapter that
 * uses GET. Parameters ride in the query string (`q`, `count`, plus optional
 * `country`, `search_lang`, `freshness`) and the key travels in an
 * `X-Subscription-Token` header, not `Authorization: Bearer`.
 *
 * Results are nested under `web.results[]`. Brave is snippet-only — there is
 * no extracted page text.
 *
 * Brave has no include/exclude domain parameters, so Anthropic's
 * `allowed_domains` / `blocked_domains` are applied as a POST-FILTER over the
 * returned hits. That can only narrow what the provider already returned; it
 * cannot improve recall when an allowed domain didn't rank on the first page.
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

/** Brave rejects `count` above 20. */
const BRAVE_MAX_RESULTS_LIMIT = 20;
/** Used when the caller passes a non-finite `maxResults`. */
const DEFAULT_MAX_RESULTS = 10;
const SEARCH_TIMEOUT_MS = 10_000;
/** Error bodies are truncated to this many characters before being surfaced. */
const ERROR_BODY_EXCERPT_CHARS = 200;
const TEST_QUERY = "better-ccflare connectivity test";
const FRESHNESS_VALUES = new Set(["pd", "pw", "pm", "py"]);

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

/** Build the GET URL, adding optional parameters only when configured. */
function buildSearchUrl(
	query: string,
	count: number,
	config: WebToolAdapterConfig,
): string {
	const url = new URL(BRAVE_SEARCH_URL);
	url.searchParams.set("q", query);
	url.searchParams.set("count", String(count));

	const country = stringOption(config, "country");
	if (country) url.searchParams.set("country", country);
	const searchLang = stringOption(config, "searchLang");
	if (searchLang) url.searchParams.set("search_lang", searchLang);
	// Brave only accepts the four documented freshness codes; anything else
	// would make the whole request fail, so drop it.
	const freshness = stringOption(config, "freshness");
	if (freshness && FRESHNESS_VALUES.has(freshness)) {
		url.searchParams.set("freshness", freshness);
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
 * Brave documents no-results responses as `{type: "web", ...}` without a `web`
 * key — a 200 with `web` absent, or with `web.results: []`, is a valid EMPTY
 * search and maps to `[]` (it is not malformed, and not an error worth
 * falling through on). A body that is not an object, or that carries a `web`
 * key which is not an object, has an unrecognisable shape and throws.
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
	if (data.web.results === undefined) return [];
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
					resultEntries(data);
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
