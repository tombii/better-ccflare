/**
 * Linkup implementation of {@link WebToolSearchAdapter}.
 *
 * Search is a POST to `/v1/search` with a flat JSON body (`q`, `depth`,
 * `outputType: "searchResults"`, `maxResults`, optional domain lists)
 * returning `{ results: [...] }` with `name` / `url` / `content` / `type` per
 * entry. `outputType` is mandatory and always `searchResults`: the search
 * endpoint also offers answer-shaped outputs, but the interception chain needs
 * a result list, not a synthesised answer.
 *
 * `type: "image"` entries carry no `content` and are skipped. `includeDomains`
 * / `excludeDomains` are native request parameters (capped at 100 entries
 * each by Linkup), so the Anthropic domain filters are forwarded rather than
 * post-filtered.
 *
 * Linkup documents no upper bound for `maxResults`, so none is invented here.
 * The API key is REQUIRED; without one the adapter fails loudly (like Tavily).
 */

import type {
	WebToolAdapterConfig,
	WebToolSearchAdapter,
	WebToolSearchHit,
	WebToolSearchRequest,
} from "../types";

export const LINKUP_SEARCH_URL = "https://api.linkup.so/v1/search";

/** Linkup accepts at most 100 domains per include/exclude list. */
const LINKUP_MAX_DOMAINS = 100;
/** Used when the caller passes a non-finite `maxResults`. */
const DEFAULT_MAX_RESULTS = 10;
const SEARCH_TIMEOUT_MS = 10_000;
/** Error bodies are truncated to this many characters before being surfaced. */
const ERROR_BODY_EXCERPT_CHARS = 200;
const TEST_QUERY = "better-ccflare connectivity test";

const SEARCH_DEPTHS = ["flash", "fast", "standard", "deep"] as const;
type LinkupSearchDepth = (typeof SEARCH_DEPTHS)[number];
const DEFAULT_SEARCH_DEPTH: LinkupSearchDepth = "standard";

/**
 * Error raised for a non-2xx Linkup response, a malformed 200 body (and for
 * aborts).
 *
 * `status` mirrors the HTTP status so the fallback chain can decide whether
 * the failure warrants a cooldown (401/402/429) or is transient; a malformed
 * 200 carries 502. The message never contains the API key.
 */
export class LinkupSearchError extends Error {
	constructor(
		readonly status: number,
		message: string,
	) {
		super(message);
		this.name = "LinkupSearchError";
	}
}

/** The subset of Linkup's search body this adapter sends. */
interface LinkupSearchBody {
	q: string;
	depth: LinkupSearchDepth;
	outputType: "searchResults";
	maxResults: number;
	includeDomains?: string[];
	excludeDomains?: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Clamp a requested result count into a non-negative range. Linkup documents
 * no upper `maxResults` bound, so there is no upper clamp — only the shared
 * default for non-finite input rather than producing `NaN` in the JSON body.
 * Zero is allowed here only so the caller can short-circuit; an actual request
 * always sends at least 1.
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

/** `depth` is only forwarded when it is one of the documented values. */
function searchDepthFrom(config: WebToolAdapterConfig): LinkupSearchDepth {
	const value = config.extraConfig.depth;
	return typeof value === "string" &&
		(SEARCH_DEPTHS as readonly string[]).includes(value)
		? (value as LinkupSearchDepth)
		: DEFAULT_SEARCH_DEPTH;
}

/** Drop empty entries and truncate to Linkup's per-list cap. */
function domainList(values: string[] | undefined): string[] {
	return (values ?? [])
		.filter((value) => value.trim().length > 0)
		.slice(0, LINKUP_MAX_DOMAINS);
}

function buildSearchBody(
	request: WebToolSearchRequest,
	config: WebToolAdapterConfig,
): LinkupSearchBody {
	const body: LinkupSearchBody = {
		q: request.query,
		depth: searchDepthFrom(config),
		outputType: "searchResults",
		maxResults: effectiveMaxResults(request, config),
	};

	// Anthropic forbids sending `allowed_domains` and `blocked_domains`
	// together, so a well-formed request never carries both. Linkup accepts
	// both, but if a caller does pass both we honour the allowlist and drop
	// the blocklist — include takes precedence over exclude.
	const allowed = domainList(request.allowedDomains);
	const blocked = domainList(request.blockedDomains);
	if (allowed.length > 0) {
		body.includeDomains = allowed;
	} else if (blocked.length > 0) {
		body.excludeDomains = blocked;
	}

	return body;
}

/** Minimal body for the dashboard's Test button: cheapest depth, one result. */
function buildTestBody(): LinkupSearchBody {
	return {
		q: TEST_QUERY,
		depth: "fast",
		outputType: "searchResults",
		maxResults: 1,
	};
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

/** POST a search body to Linkup, throwing {@link LinkupSearchError} on failure. */
async function postSearch(
	body: LinkupSearchBody,
	apiKey: string,
	signal: AbortSignal | undefined,
): Promise<unknown> {
	const effectiveSignal = requestSignal(signal);

	let response: Response;
	try {
		response = await fetch(LINKUP_SEARCH_URL, {
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
			throw new LinkupSearchError(408, "Linkup search request aborted");
		}
		throw error;
	}

	if (!response.ok) {
		const excerpt = await readErrorExcerpt(response);
		throw new LinkupSearchError(
			response.status,
			`Linkup search failed with status ${response.status}${excerpt ? `: ${excerpt}` : ""}`,
		);
	}

	return response.json();
}

/**
 * Decide whether a 200 body is a Linkup payload and return its result list.
 *
 * A missing `results` array is malformed, not an empty search: treating it as
 * empty would mark the provider healthy and stop the fallback chain before a
 * backup provider is tried. `{results: []}` stays a valid empty search.
 */
function resultEntries(data: unknown): unknown[] {
	if (!isRecord(data)) {
		throw new LinkupSearchError(502, "Linkup response is not a JSON object");
	}
	if (!Array.isArray(data.results)) {
		throw new LinkupSearchError(
			502,
			"Linkup response is missing the results array",
		);
	}
	return data.results;
}

/** Map Linkup's `results` array onto the normalised hit shape. */
function toHits(data: unknown, maxResults: number): WebToolSearchHit[] {
	const entries = resultEntries(data);

	const hits: WebToolSearchHit[] = [];
	for (const entry of entries) {
		if (!isRecord(entry)) continue;
		// Image results carry no page text and are not usable sources.
		if (entry.type === "image") continue;
		// Entries without a URL are unusable to the responder (it needs a
		// source link), so drop them rather than synthesising one.
		const url = typeof entry.url === "string" ? entry.url : "";
		if (!url) continue;

		const hit: WebToolSearchHit = {
			title: typeof entry.name === "string" ? entry.name : "",
			url,
		};
		if (typeof entry.content === "string" && entry.content) {
			hit.content = entry.content;
		}
		hits.push(hit);
	}

	return hits.slice(0, clampMaxResults(maxResults));
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** Build the Linkup adapter singleton. */
export function createLinkupAdapter(): WebToolSearchAdapter {
	return {
		id: "linkup",
		implemented: true,

		async search(
			request: WebToolSearchRequest,
			config: WebToolAdapterConfig,
		): Promise<WebToolSearchHit[]> {
			// The chain filters keyless providers out, but a direct call must not
			// send `Bearer null`.
			if (!config.apiKey) {
				throw new Error("Linkup requires an API key");
			}
			const maxResults = effectiveMaxResults(request, config);
			// Linkup requires `maxResults` of at least 1; a zero-result request
			// is satisfied without an outbound call.
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
