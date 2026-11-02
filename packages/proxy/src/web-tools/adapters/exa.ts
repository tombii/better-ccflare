/**
 * Exa implementation of {@link WebToolSearchAdapter}.
 *
 * Exa's search endpoint takes a flat JSON body (`query`, `numResults`,
 * filters) and returns `{ results: [...] }`. Each result carries `title`,
 * `url`, `publishedDate` and, when the caller asked for contents, an extracted
 * `text`. The mapping is therefore close to 1:1.
 *
 * The API key travels in an `x-api-key` header (Exa also accepts
 * `Authorization: Bearer`, but the docs show `x-api-key`) and must never
 * appear in an error message, log line or health write.
 */

import type {
	WebToolAdapterConfig,
	WebToolSearchAdapter,
	WebToolSearchHit,
	WebToolSearchRequest,
} from "../types";

export const EXA_SEARCH_URL = "https://api.exa.ai/search";

/** Exa accepts `numResults` in 1–100. */
const EXA_MAX_RESULTS_LIMIT = 100;
/** Used when the caller passes a non-finite `maxResults`. */
const DEFAULT_MAX_RESULTS = 10;
/** Characters of extracted page text requested when the operator opts in. */
const MAX_TEXT_CHARS = 1000;
const SEARCH_TIMEOUT_MS = 10_000;
/** Error bodies are truncated to this many characters before being surfaced. */
const ERROR_BODY_EXCERPT_CHARS = 200;
const TEST_QUERY = "better-ccflare connectivity test";

const EXA_SEARCH_TYPES = ["auto", "lite", "deep-lite", "deep"] as const;
type ExaSearchType = (typeof EXA_SEARCH_TYPES)[number];

/**
 * Error raised for a non-2xx Exa response (and for aborts).
 *
 * `status` mirrors the HTTP status so the fallback chain can decide whether
 * the failure warrants a cooldown (401/402/429) or is transient. Exa signals
 * an exhausted credit balance with 402, which is preserved here. The message
 * never contains the API key.
 */
export class ExaSearchError extends Error {
	constructor(
		readonly status: number,
		message: string,
	) {
		super(message);
		this.name = "ExaSearchError";
	}
}

/** The subset of Exa's search body this adapter sends. */
interface ExaSearchBody {
	query: string;
	numResults: number;
	type: ExaSearchType;
	includeDomains?: string[];
	excludeDomains?: string[];
	contents?: { text: { maxCharacters: number } };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Clamp a requested result count into Exa's accepted 0–100 range. A
 * non-finite value falls back to the shared default rather than producing
 * `NaN` in the JSON body.
 */
function clampMaxResults(value: number): number {
	const requested = Number.isFinite(value)
		? Math.trunc(value)
		: DEFAULT_MAX_RESULTS;
	return Math.min(EXA_MAX_RESULTS_LIMIT, Math.max(0, requested));
}

/**
 * `type` is only forwarded when it is one of the values Exa accepts. The
 * default is Exa's own `auto` — never a cheaper tier the operator did not
 * choose.
 */
function searchTypeFrom(config: WebToolAdapterConfig): ExaSearchType {
	const type = config.extraConfig.type;
	return (EXA_SEARCH_TYPES as readonly unknown[]).includes(type)
		? (type as ExaSearchType)
		: "auto";
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

function buildSearchBody(
	request: WebToolSearchRequest,
	config: WebToolAdapterConfig,
): ExaSearchBody {
	const body: ExaSearchBody = {
		query: request.query,
		numResults: effectiveMaxResults(request, config),
		type: searchTypeFrom(config),
	};

	// Anthropic forbids sending `allowed_domains` and `blocked_domains`
	// together, so a well-formed request never carries both. If a caller does
	// pass both we honour the allowlist and drop the blocklist — include takes
	// precedence over exclude.
	const allowed = (request.allowedDomains ?? []).filter((d) => d.length > 0);
	const blocked = (request.blockedDomains ?? []).filter((d) => d.length > 0);
	if (allowed.length > 0) {
		body.includeDomains = allowed;
	} else if (blocked.length > 0) {
		body.excludeDomains = blocked;
	}

	// Extracted page text is billed as content on Exa's side, so only ask for
	// it when the operator explicitly opted in.
	if (config.extraConfig.includeText === true) {
		body.contents = { text: { maxCharacters: MAX_TEXT_CHARS } };
	}

	return body;
}

/** Minimal body for the dashboard's Test button. */
function buildTestBody(config: WebToolAdapterConfig): ExaSearchBody {
	return {
		query: TEST_QUERY,
		numResults: 1,
		type: searchTypeFrom(config),
	};
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
 * Combine the caller's signal with the adapter's own timeout, the same way
 * `tavily.ts` does.
 */
function requestSignal(signal: AbortSignal | undefined): AbortSignal {
	const timeout = AbortSignal.timeout(SEARCH_TIMEOUT_MS);
	return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

/** POST a search body to Exa, throwing {@link ExaSearchError} on failure. */
async function postSearch(
	body: ExaSearchBody,
	apiKey: string,
	signal: AbortSignal | undefined,
): Promise<unknown> {
	const effectiveSignal = requestSignal(signal);

	let response: Response;
	try {
		response = await fetch(EXA_SEARCH_URL, {
			method: "POST",
			headers: {
				"x-api-key": apiKey,
				"Content-Type": "application/json",
			},
			body: JSON.stringify(body),
			signal: effectiveSignal,
		});
	} catch (error) {
		// An abort here is either the client disconnecting or our timeout.
		// Neither warrants a cooldown, so the status is informational only.
		if (
			effectiveSignal.aborted ||
			(error instanceof Error &&
				(error.name === "AbortError" || error.name === "TimeoutError"))
		) {
			throw new ExaSearchError(408, "Exa search request aborted");
		}
		throw error;
	}

	if (!response.ok) {
		const excerpt = await readErrorExcerpt(response);
		throw new ExaSearchError(
			response.status,
			`Exa search failed with status ${response.status}${excerpt ? `: ${excerpt}` : ""}`,
		);
	}

	return response.json();
}

/** Map Exa's `results` array onto the normalised hit shape. */
function toHits(data: unknown, maxResults: number): WebToolSearchHit[] {
	// A missing `results` array is a broken response, not an empty search.
	// Returning [] would mark the provider healthy, stop the fallback chain
	// and show the model "no results" — masking the fault. `{results: []}` is
	// the provider's way of saying "nothing found" and stays valid.
	if (!isRecord(data) || !Array.isArray(data.results)) {
		throw new ExaSearchError(502, "Exa response is missing the results array");
	}

	const hits: WebToolSearchHit[] = [];
	for (const entry of data.results) {
		if (!isRecord(entry)) continue;
		// Entries without a URL are unusable to the responder (it needs a
		// source link), so drop them rather than synthesising one.
		const url = typeof entry.url === "string" ? entry.url : "";
		if (!url) continue;

		const hit: WebToolSearchHit = {
			title: typeof entry.title === "string" ? entry.title : "",
			url,
		};
		if (typeof entry.text === "string" && entry.text) {
			hit.content = entry.text;
		}
		if (typeof entry.publishedDate === "string" && entry.publishedDate) {
			hit.publishedDate = entry.publishedDate;
		}
		hits.push(hit);
	}

	return hits.slice(0, clampMaxResults(maxResults));
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** Build the Exa adapter singleton. */
export function createExaAdapter(): WebToolSearchAdapter {
	return {
		id: "exa",
		implemented: true,

		async search(
			request: WebToolSearchRequest,
			config: WebToolAdapterConfig,
		): Promise<WebToolSearchHit[]> {
			// The chain filters keyless providers out, but a direct call must not
			// send an empty key header.
			if (!config.apiKey) {
				throw new Error("Exa requires an API key");
			}
			const data = await postSearch(
				buildSearchBody(request, config),
				config.apiKey,
				request.signal,
			);
			return toHits(data, effectiveMaxResults(request, config));
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
					buildTestBody(config),
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
