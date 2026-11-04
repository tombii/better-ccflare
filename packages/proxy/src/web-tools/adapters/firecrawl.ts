/**
 * Firecrawl implementation of {@link WebToolSearchAdapter}.
 *
 * Search is a POST to `/v2/search` with a flat JSON body (`query`, `limit`,
 * optional `location` / `tbs`) returning `{ success, data: { web: [...] } }`
 * with `title` / `description` / `url` per entry. v2 is used for both tiers:
 * it is the endpoint Firecrawl documents for keyless (anonymous) callers, and
 * it supersedes v1 for keyed callers too. The keyed endpoint keys its results
 * under `data.web` exactly like the keyless one, so one parser serves both.
 *
 * `scrapeOptions` are deliberately NOT sent: the interception chain only needs
 * the lightweight title/description/url triple, and asking for scrapes would
 * turn every search into a set of heavy page fetches. A failed call reports
 * `{ success: false, error }`, which surfaces as the thrown message.
 *
 * The API key is OPTIONAL. With a key the same endpoint gets an
 * `Authorization` header; without one the request is anonymous, which
 * Firecrawl gates by IP reputation — datacenter, VPN and proxy addresses (as
 * the proxy host usually is) get a 403 asking for a key. That 403 is reported
 * as-is so the operator knows the free tier is blocked from this host rather
 * than misconfigured.
 */

import type {
	WebToolAdapterConfig,
	WebToolSearchAdapter,
	WebToolSearchHit,
	WebToolSearchRequest,
} from "../types";

export const FIRECRAWL_SEARCH_URL = "https://api.firecrawl.dev/v2/search";

/** Used when the caller passes a non-finite `maxResults`. */
const DEFAULT_MAX_RESULTS = 10;
const SEARCH_TIMEOUT_MS = 10_000;
/** Error bodies are truncated to this many characters before being surfaced. */
const ERROR_BODY_EXCERPT_CHARS = 200;
const TEST_QUERY = "better-ccflare connectivity test";

/**
 * Error raised for a non-2xx Firecrawl response, a `{success: false}` payload
 * (and for aborts).
 *
 * `status` mirrors the HTTP status so the fallback chain can decide whether
 * the failure warrants a cooldown (401/402/429) or is transient; a
 * provider-reported failure on a 200 carries 502. The message never contains
 * the API key.
 */
export class FirecrawlSearchError extends Error {
	constructor(
		readonly status: number,
		message: string,
	) {
		super(message);
		this.name = "FirecrawlSearchError";
	}
}

/** The subset of Firecrawl's v1 search body this adapter sends. */
interface FirecrawlSearchBody {
	query: string;
	limit: number;
	location?: string;
	tbs?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Clamp a requested result count into a non-negative range. Firecrawl's docs
 * state no explicit `limit` ceiling, so there is no upper clamp — only the
 * shared default for non-finite input rather than producing `NaN` in the JSON
 * body.
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

function buildSearchBody(
	request: WebToolSearchRequest,
	config: WebToolAdapterConfig,
): FirecrawlSearchBody {
	const body: FirecrawlSearchBody = {
		query: request.query,
		limit: effectiveMaxResults(request, config),
	};

	const location = stringOption(config, "location");
	if (location) body.location = location;
	const tbs = stringOption(config, "tbs");
	if (tbs) body.tbs = tbs;

	return body;
}

/** Minimal body for the dashboard's Test button. */
function buildTestBody(config: WebToolAdapterConfig): FirecrawlSearchBody {
	const body: FirecrawlSearchBody = {
		query: TEST_QUERY,
		limit: 1,
	};
	const location = stringOption(config, "location");
	if (location) body.location = location;
	const tbs = stringOption(config, "tbs");
	if (tbs) body.tbs = tbs;
	return body;
}

/** Collapse and truncate a response body so error messages stay short. */
async function readErrorExcerpt(response: Response): Promise<string> {
	try {
		const text = (await response.text()).replace(/\s+/g, " ").trim();
		if (!text) return "";
		// Prefer the API's own `{success: false, error}` message over the raw
		// body when the body carries one.
		try {
			const parsed: unknown = JSON.parse(text);
			if (
				isRecord(parsed) &&
				typeof parsed.error === "string" &&
				parsed.error
			) {
				return truncate(parsed.error);
			}
		} catch {
			// Not JSON — fall through to the raw excerpt.
		}
		return truncate(text);
	} catch {
		// A body that cannot be read must not mask the status error.
		return "";
	}
}

function truncate(text: string): string {
	return text.length > ERROR_BODY_EXCERPT_CHARS
		? `${text.slice(0, ERROR_BODY_EXCERPT_CHARS)}…`
		: text;
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

/**
 * POST a search body to Firecrawl, throwing {@link FirecrawlSearchError} on
 * failure.
 *
 * With a key the request is authenticated; without one it is keyless (no
 * `Authorization` header at all — sending an empty bearer would read as a bad
 * key rather than an anonymous call).
 */
async function postSearch(
	body: FirecrawlSearchBody,
	apiKey: string | null,
	signal: AbortSignal | undefined,
): Promise<unknown> {
	const effectiveSignal = requestSignal(signal);

	const headers: Record<string, string> = {
		"Content-Type": "application/json",
	};
	if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

	let response: Response;
	try {
		response = await fetch(FIRECRAWL_SEARCH_URL, {
			method: "POST",
			headers,
			body: JSON.stringify(body),
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
			throw new FirecrawlSearchError(408, "Firecrawl search request aborted");
		}
		throw error;
	}

	if (!response.ok) {
		const excerpt = await readErrorExcerpt(response);
		throw new FirecrawlSearchError(
			response.status,
			`Firecrawl search failed with status ${response.status}${excerpt ? `: ${excerpt}` : ""}`,
		);
	}

	return response.json();
}

/**
 * Decide whether a 200 body is a Firecrawl payload and return its result list.
 *
 * A `{success: false, error}` body is a provider-reported failure, not an
 * empty search — it throws so the chain can fall through to the next provider.
 * A missing `data` array is likewise malformed and throws: treating either as
 * empty would mark the provider healthy and stop the chain before a backup
 * provider is tried. `{success: true, data: []}` stays a valid empty search.
 */
function resultEntries(data: unknown): unknown[] {
	if (!isRecord(data)) {
		throw new FirecrawlSearchError(
			502,
			"Firecrawl response is not a JSON object",
		);
	}
	if (data.success === false) {
		const detail =
			typeof data.error === "string" && data.error
				? `: ${truncate(data.error)}`
				: "";
		throw new FirecrawlSearchError(
			502,
			`Firecrawl search reported failure${detail}`,
		);
	}
	// v2 nests results under `data.web`; v1 (and some older payloads) put the
	// array directly in `data`. Accept both so a gateway or an API revision
	// that still answers v1-shaped does not read as malformed.
	if (isRecord(data.data) && Array.isArray(data.data.web)) {
		return data.data.web;
	}
	if (!Array.isArray(data.data)) {
		throw new FirecrawlSearchError(
			502,
			"Firecrawl response is missing the data array",
		);
	}
	return data.data;
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
 * Apply Anthropic's domain filters as a post-filter (Firecrawl's plain search
 * body carries no domain parameters at this adapter's level). Mirrors the
 * brave rule: if both lists are present, the allowlist wins and the blocklist
 * is ignored.
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

/** Map Firecrawl's `data` array onto the normalised hit shape. */
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
		hits.push(hit);
	}

	return hits.slice(0, clampMaxResults(maxResults));
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** Build the Firecrawl adapter singleton. */
export function createFirecrawlAdapter(): WebToolSearchAdapter {
	return {
		id: "firecrawl",
		implemented: true,

		async search(
			request: WebToolSearchRequest,
			config: WebToolAdapterConfig,
		): Promise<WebToolSearchHit[]> {
			// No key is fine: `postSearch` makes an anonymous (keyless) call.
			const data = await postSearch(
				buildSearchBody(request, config),
				config.apiKey,
				request.signal,
			);
			return toHits(
				data,
				effectiveMaxResults(request, config),
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
			try {
				const data = await postSearch(
					buildTestBody(config),
					config.apiKey,
					undefined,
				);
				const latencyMs = Date.now() - started;
				try {
					resultEntries(data);
				} catch (error) {
					// A `{success: false}` body is a provider-reported failure —
					// surface the API's own error rather than the generic shape
					// message so the dashboard shows something actionable.
					if (
						error instanceof FirecrawlSearchError &&
						isRecord(data) &&
						data.success === false
					) {
						return { ok: false, latencyMs, error: error.message };
					}
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
