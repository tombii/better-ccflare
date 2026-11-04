/**
 * Tinyfish implementation of {@link WebToolSearchAdapter}.
 *
 * Tinyfish is a GET API: parameters ride in the query string and the key
 * travels in an `X-API-Key` header (required — keyless calls fail with a 401
 * `MISSING_API_KEY`). There is no limit parameter: the API returns 10 results
 * per page, so `page` selects which slice to fetch while the adapter truncates
 * to the caller's `maxResults`.
 *
 * Optional `extraConfig` keys: `location` (default `"US"`), `language`
 * (default `"en"`), `domain_type` (`"web"`, `"news"` or `"research_paper"`)
 * and `purpose` (free text describing the search intent).
 *
 * Tinyfish has no include/exclude domain parameters, so Anthropic's
 * `allowed_domains` / `blocked_domains` are applied as a POST-FILTER over the
 * returned hits, mirroring the brave adapter. The key must never appear in an
 * error message, log line or health write.
 */

import type {
	WebToolAdapterConfig,
	WebToolSearchAdapter,
	WebToolSearchHit,
	WebToolSearchRequest,
} from "../types";

export const TINYFISH_SEARCH_URL = "https://api.search.tinyfish.ai";

/** Tinyfish's code for a missing or empty API key (arrives as HTTP 401). */
export const TINYFISH_ERROR_STATUS_MISSING_KEY = "MISSING_API_KEY";

/** Tinyfish returns 10 results per page; `page` is 1-based. */
const TINYFISH_PAGE_SIZE = 10;
/** Used when the caller passes a non-finite `maxResults`. */
const DEFAULT_MAX_RESULTS = 10;
const SEARCH_TIMEOUT_MS = 10_000;
/** Error bodies are truncated to this many characters before being surfaced. */
const ERROR_BODY_EXCERPT_CHARS = 200;
const TEST_QUERY = "better-ccflare connectivity test";

/** The only three values Tinyfish accepts for `domain_type`. */
const DOMAIN_TYPE_VALUES = new Set(["web", "news", "research_paper"]);

/**
 * Error raised for a non-2xx Tinyfish response (and for aborts).
 *
 * `status` mirrors the HTTP status so the fallback chain can decide whether
 * the failure warrants a cooldown (401/402/429) or is transient. `code`
 * carries Tinyfish's machine code (`MISSING_API_KEY`, …) when the body had
 * one. The message never contains the API key.
 */
export class TinyfishSearchError extends Error {
	constructor(
		readonly status: number,
		readonly code?: string,
		message = "",
	) {
		super(message);
		this.name = "TinyfishSearchError";
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Clamp a requested result count into a non-negative range. Tinyfish has no
 * per-request limit parameter — the page size bounds what one round-trip can
 * return — so there is no upper clamp, only the shared default for non-finite
 * input rather than producing `NaN`.
 */
function clampMaxResults(value: number): number {
	const requested = Number.isFinite(value)
		? Math.trunc(value)
		: DEFAULT_MAX_RESULTS;
	return Math.max(0, requested);
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
 * Build the GET URL. `location` and `language` always ride along (Tinyfish
 * defaults apply server-side, but sending them keeps behaviour explicit);
 * `domain_type` is only sent when it is a documented value, and `purpose`
 * only when configured.
 */
function buildSearchUrl(
	query: string,
	config: WebToolAdapterConfig,
	page: number,
): string {
	const url = new URL(TINYFISH_SEARCH_URL);
	url.searchParams.set("query", query);
	url.searchParams.set("location", stringOption(config, "location") ?? "US");
	url.searchParams.set("language", stringOption(config, "language") ?? "en");
	const domainType = stringOption(config, "domain_type");
	if (domainType && DOMAIN_TYPE_VALUES.has(domainType)) {
		url.searchParams.set("domain_type", domainType);
	}
	const purpose = stringOption(config, "purpose");
	if (purpose) url.searchParams.set("purpose", purpose);
	if (page > 1) url.searchParams.set("page", String(page));
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
		return TINYFISH_SEARCH_URL;
	}
}

/**
 * Collapse and truncate a response body so error messages stay short, and
 * pull out Tinyfish's machine code (`code`) when the body carried one.
 */
async function readErrorDetail(
	response: Response,
): Promise<{ excerpt: string; code?: string }> {
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
	try {
		const parsed: unknown = JSON.parse(text);
		if (isRecord(parsed)) {
			const raw = parsed.code;
			if (typeof raw === "string" && raw) code = raw;
		}
	} catch {
		// Not JSON — the excerpt is all we have.
	}
	return { excerpt, code };
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

/** GET a search URL from Tinyfish, throwing {@link TinyfishSearchError} on failure. */
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
				"X-API-Key": apiKey,
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
			throw new TinyfishSearchError(
				408,
				undefined,
				"Tinyfish search request aborted",
			);
		}
		// A fetch-level failure (DNS, TLS, …) is not an HTTP status.
		const detail = error instanceof Error ? error.message : String(error);
		throw new TinyfishSearchError(
			0,
			undefined,
			`Tinyfish search request failed for ${redactUrl(url)}: ${detail}`,
		);
	}

	if (!response.ok) {
		const { excerpt, code } = await readErrorDetail(response);
		const detail = code ? `${code}${excerpt ? `: ${excerpt}` : ""}` : excerpt;
		throw new TinyfishSearchError(
			response.status,
			code,
			`Tinyfish search failed with status ${response.status}${detail ? `: ${detail}` : ""}`,
		);
	}

	return response.json();
}

/**
 * Decide whether a 200 body is a Tinyfish payload and return its result list.
 *
 * Tinyfish documents an empty search as a payload with `results: []`; a
 * missing `results` array is malformed and throws — treating it as empty would
 * mark the provider healthy and stop the chain before a backup provider is
 * tried.
 */
function resultEntries(data: unknown): unknown[] {
	if (!isRecord(data)) {
		throw new TinyfishSearchError(
			502,
			undefined,
			"Tinyfish response is not a JSON object",
		);
	}
	if (!Array.isArray(data.results)) {
		throw new TinyfishSearchError(
			502,
			undefined,
			"Tinyfish response is missing the results array",
		);
	}
	return data.results;
}

/**
 * Lower-cased hostname of a URL, or "" when it cannot be parsed. A bare host
 * (no scheme) is accepted too.
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
 * Apply Anthropic's domain filters as a post-filter (Tinyfish has no native
 * parameters for them). Mirrors the brave rule: if both lists are present,
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

/** Map Tinyfish's `results` array onto the normalised hit shape. */
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
		if (typeof entry.snippet === "string" && entry.snippet) {
			hit.snippet = entry.snippet;
		}
		if (typeof entry.date === "string" && entry.date) {
			hit.publishedDate = entry.date;
		}
		hits.push(hit);
		if (hits.length >= clampMaxResults(maxResults)) break;
	}

	return hits.slice(0, clampMaxResults(maxResults));
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** Build the Tinyfish adapter singleton. */
export function createTinyfishAdapter(): WebToolSearchAdapter {
	return {
		id: "tinyfish",
		implemented: true,

		async search(
			request: WebToolSearchRequest,
			config: WebToolAdapterConfig,
		): Promise<WebToolSearchHit[]> {
			// Tinyfish mandates a key: without one every call fails with a 401
			// `MISSING_API_KEY`, so refuse before any outbound call. (The chain
			// filters keyless providers out via `requiresKey`, but a direct call
			// must not send an empty key.)
			if (!config.apiKey) {
				throw new Error("Tinyfish requires an API key");
			}
			const maxResults = effectiveMaxResults(request, config);
			const data = await getSearch(
				buildSearchUrl(request.query, config, 1),
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
					buildSearchUrl(TEST_QUERY, config, 1),
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

/** Page size, exported for tests that reason about pagination. */
export { TINYFISH_PAGE_SIZE };
