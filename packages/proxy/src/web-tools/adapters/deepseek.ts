/**
 * DeepSeek implementation of {@link WebToolSearchAdapter}.
 *
 * `POST https://api.deepseek.com/v1/tools/search` with `Authorization: Bearer`.
 * The body holds `{query, count, need_content?}` and the response is a flat
 * `{results: [...]}` whose entries carry both a `snippet` and (when content
 * was requested) the full `content` of the page.
 *
 * DeepSeek only bills a request when it succeeds AND returns results, so an
 * empty result set is a real, free outcome — it maps to `[]`, never an error.
 *
 * The API key travels in the `Authorization` header and must never appear in an
 * error message, log line or health write.
 */

import type {
	WebToolAdapterConfig,
	WebToolSearchAdapter,
	WebToolSearchHit,
	WebToolSearchRequest,
} from "../types";

export const DEEPSEEK_SEARCH_URL = "https://api.deepseek.com/v1/tools/search";

/** DeepSeek accepts `count` in 1–50 and defaults to 10. */
const DEEPSEEK_MAX_RESULTS_LIMIT = 50;
/** Used when the caller passes a non-finite `maxResults`. */
const DEFAULT_MAX_RESULTS = 10;
const SEARCH_TIMEOUT_MS = 10_000;
/** Error bodies are truncated to this many characters before being surfaced. */
const ERROR_BODY_EXCERPT_CHARS = 200;
const TEST_QUERY = "better-ccflare connectivity test";

/**
 * Error raised for a non-2xx DeepSeek response (and for aborts).
 *
 * `status` mirrors the HTTP status so the fallback chain can decide whether
 * the failure warrants a cooldown (401/402/429) or is transient. The message
 * never contains the API key.
 */
export class DeepSeekSearchError extends Error {
	constructor(
		readonly status: number,
		message: string,
	) {
		super(message);
		this.name = "DeepSeekSearchError";
	}
}

/** The subset of DeepSeek's search body this adapter sends. */
interface DeepSeekSearchBody {
	query: string;
	count: number;
	need_content?: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Clamp a requested result count into DeepSeek's accepted 0–50 range. A
 * non-finite value falls back to the shared default rather than producing
 * `NaN` in the JSON body.
 */
function clampMaxResults(value: number): number {
	const requested = Number.isFinite(value)
		? Math.trunc(value)
		: DEFAULT_MAX_RESULTS;
	return Math.min(DEEPSEEK_MAX_RESULTS_LIMIT, Math.max(0, requested));
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

/**
 * Build the search body.
 *
 * `need_content` returns the full page text and costs more, so it is only sent
 * when the operator explicitly opted in.
 */
function buildSearchBody(
	request: WebToolSearchRequest,
	config: WebToolAdapterConfig,
): DeepSeekSearchBody {
	const body: DeepSeekSearchBody = {
		query: request.query,
		count: effectiveMaxResults(request, config),
	};
	if (config.extraConfig.needContent === true) {
		body.need_content = true;
	}
	return body;
}

/** Minimal body for the dashboard's Test button. */
function buildTestBody(): DeepSeekSearchBody {
	return { query: TEST_QUERY, count: 1 };
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

/** POST a search body to DeepSeek, throwing {@link DeepSeekSearchError} on failure. */
async function postSearch(
	body: DeepSeekSearchBody,
	apiKey: string,
	signal: AbortSignal | undefined,
): Promise<unknown> {
	const effectiveSignal = requestSignal(signal);

	let response: Response;
	try {
		response = await fetch(DEEPSEEK_SEARCH_URL, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${apiKey}`,
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
			throw new DeepSeekSearchError(408, "DeepSeek search request aborted");
		}
		throw error;
	}

	if (!response.ok) {
		const excerpt = await readErrorExcerpt(response);
		throw new DeepSeekSearchError(
			response.status,
			`DeepSeek search failed with status ${response.status}${excerpt ? `: ${excerpt}` : ""}`,
		);
	}

	return response.json();
}

/**
 * True when `data` is a DeepSeek payload: an object whose `results` is an
 * array, or an object with no `results` key at all (a free empty search).
 *
 * DeepSeek documents that requests returning nothing are not billed, so a
 * `results`-less 200 is a valid "no results" answer. A non-object payload or
 * a `results` key of a non-array type has an unrecognisable shape and throws.
 */
function isDeepSeekPayload(
	data: unknown,
): data is Record<string, unknown> & { results?: unknown[] } {
	if (!isRecord(data)) return false;
	// A payload without `results` at all is malformed: treating it as an empty
	// success would mark the provider healthy and stop the chain before a
	// backup provider is tried. `results: []` is DeepSeek's real "nothing
	// found" and stays valid.
	return Array.isArray(data.results);
}

/**
 * Lower-cased hostname of a URL, or "" when it cannot be parsed.
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
 * DeepSeek's search endpoint has no native include/exclude parameters, so the
 * domain filters are applied here as a post-filter. Same rule as the other
 * adapters: if both lists are present the allowlist wins.
 *
 * This narrows results; it cannot improve recall. A blocked or off-allowlist
 * site is dropped, but an allowed domain that never ranked cannot be added.
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

/** Map DeepSeek's `results` array onto the normalised hit shape. */
function toHits(
	data: unknown,
	maxResults: number,
	request: WebToolSearchRequest,
): WebToolSearchHit[] {
	if (!isDeepSeekPayload(data)) {
		throw new DeepSeekSearchError(
			502,
			"DeepSeek response is missing the results array",
		);
	}

	const hits: WebToolSearchHit[] = [];
	const { allowedDomains, blockedDomains } = request;
	for (const entry of data.results ?? []) {
		if (!isRecord(entry)) continue;
		// DeepSeek's docs state that entries lacking a `url`, `title` or
		// `snippet` are unusable, so drop them rather than synthesising values.
		const url = typeof entry.url === "string" ? entry.url : "";
		const title = typeof entry.title === "string" ? entry.title : "";
		const snippet = typeof entry.snippet === "string" ? entry.snippet : "";
		if (!url || !title || !snippet) continue;
		if (!matchesDomainFilter(url, allowedDomains, blockedDomains)) continue;

		const hit: WebToolSearchHit = { title, url, snippet };
		if (typeof entry.content === "string" && entry.content) {
			hit.content = entry.content;
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

/** Build the DeepSeek adapter singleton. */
export function createDeepSeekAdapter(): WebToolSearchAdapter {
	return {
		id: "deepseek",
		implemented: true,

		async search(
			request: WebToolSearchRequest,
			config: WebToolAdapterConfig,
		): Promise<WebToolSearchHit[]> {
			// The chain filters keyless providers out, but a direct call must not
			// send `Bearer null`.
			if (!config.apiKey) {
				throw new Error("DeepSeek requires an API key");
			}
			const data = await postSearch(
				buildSearchBody(request, config),
				config.apiKey,
				request.signal,
			);
			return toHits(data, effectiveMaxResults(request, config), request);
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
				if (!isDeepSeekPayload(data)) {
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
