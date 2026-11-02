/**
 * Serper implementation of {@link WebToolSearchAdapter}.
 *
 * `POST https://google.serper.dev/search`. The odd one out among the adapters:
 * the key travels in an `X-API-KEY` header, not `Authorization: Bearer`, and
 * the organic results live under `organic[]` (not `results`) with Google's
 * `link` field for the URL.
 *
 * Serper is snippet-only — there is no extracted page text.
 *
 * Serper has no include/exclude domain parameters, so Anthropic's
 * `allowed_domains` / `blocked_domains` are applied as a POST-FILTER over the
 * returned hits. That can only narrow what the provider already returned; it
 * cannot improve recall when an allowed domain didn't rank on the first page.
 *
 * The API key must never appear in an error message, log line or health write.
 */

import type {
	WebToolAdapterConfig,
	WebToolSearchAdapter,
	WebToolSearchHit,
	WebToolSearchRequest,
} from "../types";

export const SERPER_SEARCH_URL = "https://google.serper.dev/search";

/** Serper's `num` is capped at 100. */
const SERPER_MAX_RESULTS_LIMIT = 100;
/** Used when the caller passes a non-finite `maxResults`. */
const DEFAULT_MAX_RESULTS = 10;
const SEARCH_TIMEOUT_MS = 10_000;
/** Error bodies are truncated to this many characters before being surfaced. */
const ERROR_BODY_EXCERPT_CHARS = 200;
const TEST_QUERY = "better-ccflare connectivity test";

/**
 * Error raised for a non-2xx Serper response (and for aborts).
 *
 * `status` mirrors the HTTP status so the fallback chain can decide whether
 * the failure warrants a cooldown (401/402/429) or is transient. The message
 * never contains the API key.
 */
export class SerperSearchError extends Error {
	constructor(
		readonly status: number,
		message: string,
	) {
		super(message);
		this.name = "SerperSearchError";
	}
}

/** The subset of Serper's search body this adapter sends. */
interface SerperSearchBody {
	q: string;
	num: number;
	gl?: string;
	hl?: string;
	tbs?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Clamp a requested result count into Serper's accepted 0–100 range. A
 * non-finite value falls back to the shared default rather than producing
 * `NaN` in the JSON body.
 */
function clampMaxResults(value: number): number {
	const requested = Number.isFinite(value)
		? Math.trunc(value)
		: DEFAULT_MAX_RESULTS;
	return Math.min(SERPER_MAX_RESULTS_LIMIT, Math.max(0, requested));
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
): SerperSearchBody {
	const body: SerperSearchBody = {
		q: request.query,
		num: effectiveMaxResults(request, config),
	};
	const gl = stringOption(config, "gl");
	if (gl) body.gl = gl;
	const hl = stringOption(config, "hl");
	if (hl) body.hl = hl;
	const tbs = stringOption(config, "tbs");
	if (tbs) body.tbs = tbs;
	return body;
}

/** Minimal body for the dashboard's Test button. */
function buildTestBody(): SerperSearchBody {
	return { q: TEST_QUERY, num: 1 };
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

/** POST a search body to Serper, throwing {@link SerperSearchError} on failure. */
async function postSearch(
	body: SerperSearchBody,
	apiKey: string,
	signal: AbortSignal | undefined,
): Promise<unknown> {
	const effectiveSignal = requestSignal(signal);

	let response: Response;
	try {
		response = await fetch(SERPER_SEARCH_URL, {
			method: "POST",
			headers: {
				"X-API-KEY": apiKey,
				"Content-Type": "application/json",
			},
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
			throw new SerperSearchError(408, "Serper search request aborted");
		}
		throw error;
	}

	if (!response.ok) {
		const excerpt = await readErrorExcerpt(response);
		throw new SerperSearchError(
			response.status,
			`Serper search failed with status ${response.status}${excerpt ? `: ${excerpt}` : ""}`,
		);
	}

	return response.json();
}

/**
 * Lower-cased hostname of a URL, or "" when it cannot be parsed. A bare host
 * (no scheme) is accepted too, since Google sometimes returns one for news.
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
 * Apply Anthropic's domain filters as a post-filter (Serper has no native
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

/** Map Serper's `organic` array onto the normalised hit shape. */
function toHits(
	data: unknown,
	maxResults: number,
	allowedDomains: string[] | undefined,
	blockedDomains: string[] | undefined,
): WebToolSearchHit[] {
	// A missing `organic` array is a broken response, not an empty search.
	// Returning [] would mark the provider healthy, stop the fallback chain
	// and show the model "no results" — masking the fault. `{organic: []}` is
	// the provider's way of saying "nothing found" and stays valid.
	if (!isRecord(data) || !Array.isArray(data.organic)) {
		throw new SerperSearchError(
			502,
			"Serper response is missing the organic results array",
		);
	}

	const hits: WebToolSearchHit[] = [];
	for (const entry of data.organic) {
		if (!isRecord(entry)) continue;
		// Entries without a URL are unusable to the responder (it needs a
		// source link), so drop them rather than synthesising one.
		const url = typeof entry.link === "string" ? entry.link : "";
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
	}

	return hits.slice(0, clampMaxResults(maxResults));
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** Build the Serper adapter singleton. */
export function createSerperAdapter(): WebToolSearchAdapter {
	return {
		id: "serper",
		implemented: true,

		async search(
			request: WebToolSearchRequest,
			config: WebToolAdapterConfig,
		): Promise<WebToolSearchHit[]> {
			// The chain filters keyless providers out, but a direct call must not
			// send an empty `X-API-KEY`.
			if (!config.apiKey) {
				throw new Error("Serper requires an API key");
			}
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
			if (!config.apiKey) {
				return { ok: false, latencyMs: 0, error: "no API key configured" };
			}
			try {
				const data = await postSearch(
					buildTestBody(),
					config.apiKey,
					undefined,
				);
				const latencyMs = Date.now() - started;
				if (!isRecord(data) || !Array.isArray(data.organic)) {
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
