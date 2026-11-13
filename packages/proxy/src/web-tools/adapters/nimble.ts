/**
 * Nimble implementation of {@link WebToolSearchAdapter}.
 *
 * Search is a POST to Nimble's SDK search endpoint with a flat JSON body
 * (`query`, `max_results`, optional `search_depth` / `focus` / domain lists)
 * returning `{ results: [...] }` with `title` / `description` / `url` /
 * `content` per entry. The rich per-result text that `search_depth: "standard"`
 * advertises (~2K chars per result, tuned for AI agents) arrives in
 * `description`; the separate `content` field is populated only when
 * `full_content` is requested, which this adapter deliberately never does —
 * the interception chain only needs the lightweight title/description/url
 * triple, and full page text would turn every search into a set of heavy
 * fetches. A non-empty `content` (should Nimble ever return one) is still
 * mapped through.
 *
 * `include_domains` / `exclude_domains` are native request parameters, so the
 * Anthropic domain filters are forwarded rather than post-filtered. Nimble
 * caps each list at 50 entries, so longer lists are truncated.
 *
 * The API key is REQUIRED. Without one the adapter fails loudly (like Tavily)
 * instead of making an anonymous call Nimble does not document.
 */

import type {
	WebToolAdapterConfig,
	WebToolSearchAdapter,
	WebToolSearchHit,
	WebToolSearchRequest,
} from "../types";

export const NIMBLE_SEARCH_URL = "https://sdk.nimbleway.com/v2/search";

/** Nimble rejects `max_results` above 100 and documents ten as its default. */
const NIMBLE_MAX_RESULTS = 100;
/** Nimble accepts at most 50 domains per include/exclude list. */
const NIMBLE_MAX_DOMAINS = 50;
/** Used when the caller passes a non-finite `maxResults`. */
const DEFAULT_MAX_RESULTS = 10;
const SEARCH_TIMEOUT_MS = 10_000;
/** Error bodies are truncated to this many characters before being surfaced. */
const ERROR_BODY_EXCERPT_CHARS = 200;
const TEST_QUERY = "better-ccflare connectivity test";

const SEARCH_DEPTHS = ["lite", "standard"] as const;
type NimbleSearchDepth = (typeof SEARCH_DEPTHS)[number];

/**
 * Error raised for a non-2xx Nimble response, a malformed 200 body (and for
 * aborts).
 *
 * `status` mirrors the HTTP status so the fallback chain can decide whether
 * the failure warrants a cooldown (401/402/429) or is transient; a malformed
 * 200 carries 502. The message never contains the API key.
 */
export class NimbleSearchError extends Error {
	constructor(
		readonly status: number,
		message: string,
	) {
		super(message);
		this.name = "NimbleSearchError";
	}
}

/** The subset of Nimble's search body this adapter sends. */
interface NimbleSearchBody {
	query: string;
	max_results: number;
	search_depth?: NimbleSearchDepth;
	focus?: string;
	include_domains?: string[];
	exclude_domains?: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Clamp a requested result count into Nimble's accepted 0–100 range. A
 * non-finite value falls back to the shared default rather than producing
 * `NaN` in the JSON body. Zero is allowed here only so the caller can
 * short-circuit; an actual request always sends at least 1.
 */
function clampMaxResults(value: number): number {
	const requested = Number.isFinite(value)
		? Math.trunc(value)
		: DEFAULT_MAX_RESULTS;
	return Math.min(NIMBLE_MAX_RESULTS, Math.max(0, requested));
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

/** `search_depth` is only forwarded when it is one of the documented values. */
function searchDepthFrom(
	config: WebToolAdapterConfig,
): NimbleSearchDepth | undefined {
	const value = config.extraConfig.search_depth;
	return typeof value === "string" &&
		(SEARCH_DEPTHS as readonly string[]).includes(value)
		? (value as NimbleSearchDepth)
		: undefined;
}

/** A non-empty string from `extraConfig`, or undefined. */
function stringOption(
	config: WebToolAdapterConfig,
	key: string,
): string | undefined {
	const value = config.extraConfig[key];
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** Drop empty entries and truncate to Nimble's per-list cap. */
function domainList(values: string[] | undefined): string[] {
	return (values ?? [])
		.filter((value) => value.trim().length > 0)
		.slice(0, NIMBLE_MAX_DOMAINS);
}

function buildSearchBody(
	request: WebToolSearchRequest,
	config: WebToolAdapterConfig,
): NimbleSearchBody {
	const body: NimbleSearchBody = {
		query: request.query,
		max_results: effectiveMaxResults(request, config),
	};

	const depth = searchDepthFrom(config);
	if (depth) body.search_depth = depth;
	const focus = stringOption(config, "focus");
	if (focus) body.focus = focus;

	// Anthropic forbids sending `allowed_domains` and `blocked_domains`
	// together, so a well-formed request never carries both. Nimble accepts
	// both, but if a caller does pass both we honour the allowlist and drop
	// the blocklist — include takes precedence over exclude.
	const allowed = domainList(request.allowedDomains);
	const blocked = domainList(request.blockedDomains);
	if (allowed.length > 0) {
		body.include_domains = allowed;
	} else if (blocked.length > 0) {
		body.exclude_domains = blocked;
	}

	return body;
}

/** Minimal body for the dashboard's Test button. */
function buildTestBody(): NimbleSearchBody {
	return { query: TEST_QUERY, max_results: 1 };
}

/** Collapse and truncate a response body so error messages stay short. */
async function readErrorExcerpt(response: Response): Promise<string> {
	try {
		const text = (await response.text()).replace(/\s+/g, " ").trim();
		if (!text) return "";
		return text.length > ERROR_BODY_EXCERPT_CHARS
			? `${text.slice(0, ERROR_BODY_EXCERPT_CHARS)}...`
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

/**
 * Whether a failure is the client disconnecting or our timeout firing.
 *
 * `AbortSignal.timeout` rejects with a `TimeoutError`, a caller abort with an
 * `AbortError`; either can also surface as a `DOMException` while the body is
 * being read, and `DOMException` is not an `Error` subclass, so the name is
 * checked structurally rather than via `instanceof`.
 */
function isAbortLike(error: unknown, effectiveSignal: AbortSignal): boolean {
	if (effectiveSignal.aborted) return true;
	if (typeof error !== "object" || error === null) return false;
	const name = (error as { name?: unknown }).name;
	return name === "AbortError" || name === "TimeoutError";
}

/**
 * Read the 2xx body as JSON.
 *
 * The fetch-phase try/catch only covers the network up to the response
 * headers: an abort or timeout that fires while the body is still streaming
 * rejects here instead, and must keep its 408 rather than escaping as an
 * untyped error. Any other failure means a 2xx response whose body is not
 * JSON, i.e. a malformed 200, which carries 502.
 */
async function readJsonBody(
	response: Response,
	effectiveSignal: AbortSignal,
): Promise<unknown> {
	try {
		return await response.json();
	} catch (error) {
		if (isAbortLike(error, effectiveSignal)) {
			throw new NimbleSearchError(408, "Nimble search request aborted");
		}
		throw new NimbleSearchError(502, "Nimble response is not valid JSON");
	}
}

/** POST a search body to Nimble, throwing {@link NimbleSearchError} on failure. */
async function postSearch(
	body: NimbleSearchBody,
	apiKey: string,
	signal: AbortSignal | undefined,
): Promise<unknown> {
	const effectiveSignal = requestSignal(signal);

	let response: Response;
	try {
		response = await fetch(NIMBLE_SEARCH_URL, {
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
		// Neither warrants a cooldown, so the status is informational only.
		if (isAbortLike(error, effectiveSignal)) {
			throw new NimbleSearchError(408, "Nimble search request aborted");
		}
		throw error;
	}

	if (!response.ok) {
		const excerpt = await readErrorExcerpt(response);
		throw new NimbleSearchError(
			response.status,
			`Nimble search failed with status ${response.status}${excerpt ? `: ${excerpt}` : ""}`,
		);
	}

	return readJsonBody(response, effectiveSignal);
}

/**
 * Decide whether a 200 body is a Nimble payload and return its result list.
 *
 * A missing `results` array is malformed, not an empty search: treating it as
 * empty would mark the provider healthy and stop the fallback chain before a
 * backup provider is tried. `{results: []}` stays a valid empty search.
 */
function resultEntries(data: unknown): unknown[] {
	if (!isRecord(data)) {
		throw new NimbleSearchError(502, "Nimble response is not a JSON object");
	}
	if (!Array.isArray(data.results)) {
		throw new NimbleSearchError(
			502,
			"Nimble response is missing the results array",
		);
	}
	return data.results;
}

/** Map Nimble's `results` array onto the normalised hit shape. */
function toHits(data: unknown, maxResults: number): WebToolSearchHit[] {
	const entries = resultEntries(data);

	const hits: WebToolSearchHit[] = [];
	for (const entry of entries) {
		if (!isRecord(entry)) continue;
		// Entries without a URL are unusable to the responder (it needs a
		// source link), so drop them rather than synthesising one.
		const url = typeof entry.url === "string" ? entry.url : "";
		if (!url) continue;

		const hit: WebToolSearchHit = {
			title: typeof entry.title === "string" ? entry.title : "",
			url,
		};
		if (typeof entry.description === "string" && entry.description) {
			hit.snippet = entry.description;
		}
		// `standard` depth delivers its rich per-result text in `description`
		// (mapped to `snippet` above). The separate `content` field is populated
		// only when `full_content` is requested, which this adapter never does;
		// pass a non-empty value through in case the provider includes one.
		if (typeof entry.content === "string" && entry.content) {
			hit.content = entry.content;
		}
		if (
			isRecord(entry.additional_data) &&
			typeof entry.additional_data.publish_date === "string" &&
			entry.additional_data.publish_date
		) {
			hit.publishedDate = entry.additional_data.publish_date;
		}
		hits.push(hit);
	}

	return hits.slice(0, clampMaxResults(maxResults));
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** Build the Nimble adapter singleton. */
export function createNimbleAdapter(): WebToolSearchAdapter {
	return {
		id: "nimble",
		implemented: true,

		async search(
			request: WebToolSearchRequest,
			config: WebToolAdapterConfig,
		): Promise<WebToolSearchHit[]> {
			// The chain filters keyless providers out, but a direct call must not
			// send `Bearer null`.
			if (!config.apiKey) {
				throw new Error("Nimble requires an API key");
			}
			const maxResults = effectiveMaxResults(request, config);
			// Nimble rejects `max_results` below 1; a zero-result request is
			// satisfied without an outbound call.
			if (maxResults === 0) return [];
			const data = await postSearch(
				buildSearchBody(request, config),
				config.apiKey,
				request.signal,
			);
			return toHits(data, maxResults);
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
				if (!isRecord(data) || !Array.isArray(data.results)) {
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
