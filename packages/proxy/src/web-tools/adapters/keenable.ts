/**
 * Keenable implementation of {@link WebToolSearchAdapter}.
 *
 * Keenable's v1 search is a POST to `/v1/search` authenticated with an
 * `X-API-Key` header, returning `{ query, mode?, results: [...] }` with
 * `title` / `url` / `snippet` per entry (`description` is deprecated and
 * always empty — never read it).
 *
 * The API also has a keyless twin, `POST /v1/search/public`, which needs no
 * key but requires an `X-Keenable-Title` app-identifier header and is rate
 * limited per IP (1000 requests/hour, 10/s, shared by every caller behind the
 * proxy's address). When a row has no stored key the adapter calls that twin
 * with the same body; when a key is stored the keyed endpoint is always used.
 * The free tier is therefore a deliberate last resort, not a silent
 * downgrade — a stored key always wins.
 */

import type {
	WebToolAdapterConfig,
	WebToolSearchAdapter,
	WebToolSearchHit,
	WebToolSearchRequest,
} from "../types";

export const KEENABLE_SEARCH_URL = "https://api.keenable.ai/v1/search";
export const KEENABLE_KEYLESS_SEARCH_URL =
	"https://api.keenable.ai/v1/search/public";

/**
 * App identifier the keyless endpoint requires. Keenable only asks for a
 * stable title for the calling app; any non-empty value works.
 */
export const KEENABLE_KEYLESS_APP_ID = "better-ccflare";

/** Keenable's documented `max_results` bounds. */
const MIN_MAX_RESULTS = 1;
const MAX_MAX_RESULTS = 50;
/** Used when the caller passes a non-finite `maxResults`. */
const DEFAULT_MAX_RESULTS = 10;
/** Keenable's documented `snippet_max_length` bounds. */
const MIN_SNIPPET_LENGTH = 180;
const MAX_SNIPPET_LENGTH = 10_000;
const SEARCH_TIMEOUT_MS = 10_000;
/** Error bodies are truncated to this many characters before being surfaced. */
const ERROR_BODY_EXCERPT_CHARS = 200;
const TEST_QUERY = "better-ccflare connectivity test";
/** The only two values the API defines for `mode`. */
const VALID_MODES = ["pro", "realtime"] as const;

/**
 * Error raised for a non-2xx Keenable response (and for aborts).
 *
 * `status` mirrors the HTTP status so the fallback chain can decide whether
 * the failure warrants a cooldown (401/402/429) or is transient. The message
 * never contains the API key.
 */
export class KeenableSearchError extends Error {
	constructor(
		readonly status: number,
		message: string,
	) {
		super(message);
		this.name = "KeenableSearchError";
	}
}

/** The subset of Keenable's v1 search body this adapter sends. */
interface KeenableSearchBody {
	query: string;
	max_results: number;
	mode?: string;
	site?: string;
	snippet_max_length?: number;
	acquired_after?: string;
	acquired_before?: string;
	published_after?: string;
	published_before?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Clamp a result count into Keenable's documented 1–50 range. Zero and
 * negative counts are lifted to 1 rather than clamped to 0: a 0 is a
 * validation error at the API, and "at most 0 results" is not a search.
 */
function clampMaxResults(value: number): number {
	const requested = Number.isFinite(value)
		? Math.trunc(value)
		: DEFAULT_MAX_RESULTS;
	return Math.min(MAX_MAX_RESULTS, Math.max(MIN_MAX_RESULTS, requested));
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
	return typeof value === "string" && value.trim().length > 0
		? value.trim()
		: undefined;
}

/**
 * `snippet_max_length` as a clamped integer, or undefined. A non-numeric
 * setting is dropped rather than sent as `NaN`; the API would 400 on it.
 */
function snippetMaxLength(config: WebToolAdapterConfig): number | undefined {
	const value = config.extraConfig.snippet_max_length;
	const parsed = typeof value === "number" ? value : Number(value);
	if (!Number.isFinite(parsed)) return undefined;
	return Math.min(
		MAX_SNIPPET_LENGTH,
		Math.max(MIN_SNIPPET_LENGTH, Math.trunc(parsed)),
	);
}

/**
 * The date-filter settings, forwarded verbatim. Keenable resolves dates,
 * timestamps and relative deltas (`7d`, `30min`) server-side, so there is
 * nothing to validate beyond "non-empty".
 */
const DATE_FILTER_KEYS = [
	"acquired_after",
	"acquired_before",
	"published_after",
	"published_before",
] as const;

/**
 * A single allowlisted domain can be pushed down as `site`. Multi-domain
 * allowlists cannot (the parameter takes one domain), so they stay a
 * client-side post-filter only.
 */
function siteFor(request: WebToolSearchRequest): string | undefined {
	const allowed = (request.allowedDomains ?? []).filter(
		(d) => d.trim().length > 0,
	);
	return allowed.length === 1 ? allowed[0].trim() : undefined;
}

function buildSearchBody(
	request: WebToolSearchRequest,
	config: WebToolAdapterConfig,
): KeenableSearchBody {
	const body: KeenableSearchBody = {
		query: request.query,
		max_results: effectiveMaxResults(request, config),
	};

	const mode = stringOption(config, "mode");
	if (mode && (VALID_MODES as readonly string[]).includes(mode)) {
		body.mode = mode;
	}

	const site = stringOption(config, "site") ?? siteFor(request);
	if (site) body.site = site;

	const snippetLength = snippetMaxLength(config);
	if (snippetLength !== undefined) body.snippet_max_length = snippetLength;

	for (const key of DATE_FILTER_KEYS) {
		const value = stringOption(config, key);
		if (value) body[key] = value;
	}

	return body;
}

/**
 * Probe body for the dashboard's Test button: the operator's saved settings
 * (`mode`, `site`, date filters, …) on a one-result request, so a broken
 * filter or an unsupported `mode` shows up in Test rather than at search time.
 * Built from {@link buildSearchBody} — the same path a real search takes — so
 * the two can never drift.
 */
function buildTestBody(config: WebToolAdapterConfig): KeenableSearchBody {
	return buildSearchBody({ query: TEST_QUERY, maxResults: 1 }, config);
}

/** Collapse and truncate a response body so error messages stay short. */
async function readErrorExcerpt(response: Response): Promise<string> {
	try {
		const text = (await response.text()).replace(/\s+/g, " ").trim();
		if (!text) return "";
		// Keenable's `ApiError` carries `error` (category) and `message`
		// (detail); prefer the detail when present.
		try {
			const parsed: unknown = JSON.parse(text);
			if (isRecord(parsed)) {
				const parts = [parsed.error, parsed.message].filter(
					(part): part is string => typeof part === "string" && part.length > 0,
				);
				if (parts.length > 0) return truncate(parts.join(": "));
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
 * POST a search body to Keenable, throwing {@link KeenableSearchError} on
 * failure.
 *
 * With a key the keyed `/v1/search` endpoint is called; without one the
 * keyless `/v1/search/public` twin is called with the app-identifier header
 * instead. The body is identical — the free endpoint accepts the same
 * `mode` / `site` / date / snippet options.
 */
async function postSearch(
	body: KeenableSearchBody,
	apiKey: string | null,
	signal: AbortSignal | undefined,
): Promise<unknown> {
	const effectiveSignal = requestSignal(signal);
	const url = apiKey ? KEENABLE_SEARCH_URL : KEENABLE_KEYLESS_SEARCH_URL;
	const authHeaders: Record<string, string> = apiKey
		? { "X-API-Key": apiKey }
		: { "X-Keenable-Title": KEENABLE_KEYLESS_APP_ID };

	let response: Response;
	try {
		response = await fetch(url, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				...authHeaders,
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
			throw new KeenableSearchError(408, "Keenable search request aborted");
		}
		throw error;
	}

	if (!response.ok) {
		const excerpt = await readErrorExcerpt(response);
		throw new KeenableSearchError(
			response.status,
			`Keenable search failed with status ${response.status}${excerpt ? `: ${excerpt}` : ""}`,
		);
	}

	return response.json();
}

/**
 * Decide whether a 200 body is a Keenable payload and return its result list.
 *
 * A missing `results` array is malformed and throws rather than reading as an
 * empty search: treating it as empty would mark the provider healthy and stop
 * the chain before a backup provider is tried. `{ results: [] }` stays a valid
 * empty search.
 */
function resultEntries(data: unknown): unknown[] {
	if (!isRecord(data)) {
		throw new KeenableSearchError(
			502,
			"Keenable response is not a JSON object",
		);
	}
	if (!Array.isArray(data.results)) {
		throw new KeenableSearchError(
			502,
			"Keenable response is missing the results array",
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
 * Apply Anthropic's domain filters as a post-filter. Keenable only offers a
 * single-domain `site` restriction, so multi-domain lists and blocklists are
 * enforced here. Mirrors the brave rule: if both lists are present, the
 * allowlist wins and the blocklist is ignored.
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

/** Map Keenable's `results` array onto the normalised hit shape. */
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
		// `snippet` only — `description` is deprecated and always empty.
		if (typeof entry.snippet === "string" && entry.snippet) {
			hit.snippet = entry.snippet;
		}
		if (typeof entry.published_at === "string" && entry.published_at) {
			hit.publishedDate = entry.published_at;
		}
		hits.push(hit);
	}

	return hits.slice(0, clampMaxResults(maxResults));
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** Build the Keenable adapter singleton. */
export function createKeenableAdapter(): WebToolSearchAdapter {
	return {
		id: "keenable",
		implemented: true,

		async search(
			request: WebToolSearchRequest,
			config: WebToolAdapterConfig,
		): Promise<WebToolSearchHit[]> {
			// No key is fine: `postSearch` switches to the keyless public twin.
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
