/**
 * Tavily implementation of {@link WebToolSearchAdapter}.
 *
 * Tavily is the only provider implemented in phase 1. Its search endpoint takes
 * a flat JSON body and returns `{ results: [...] }` with the fields we need
 * already flattened, so the mapping is close to 1:1.
 *
 * The API key travels in an `Authorization: Bearer` header (the documented
 * scheme) and must never appear in an error message, log line or health write.
 */

import type {
	WebToolAdapterConfig,
	WebToolSearchAdapter,
	WebToolSearchHit,
	WebToolSearchRequest,
} from "../types";

export const TAVILY_SEARCH_URL = "https://api.tavily.com/search";

/** Tavily rejects `max_results` above 20. */
const TAVILY_MAX_RESULTS_LIMIT = 20;
/** Used when the caller passes a non-finite `maxResults`. */
const DEFAULT_MAX_RESULTS = 10;
const SEARCH_TIMEOUT_MS = 10_000;
/** Error bodies are truncated to this many characters before being surfaced. */
const ERROR_BODY_EXCERPT_CHARS = 200;
const TEST_QUERY = "better-ccflare connectivity test";

/**
 * Error raised for a non-2xx Tavily response (and for aborts).
 *
 * `status` mirrors the HTTP status so the fallback chain can decide whether
 * the failure warrants a cooldown (401/402/429) or is transient. The message
 * never contains the API key.
 */
export class TavilySearchError extends Error {
	constructor(
		readonly status: number,
		message: string,
	) {
		super(message);
		this.name = "TavilySearchError";
	}
}

/** The subset of Tavily's search body this adapter sends. */
interface TavilySearchBody {
	query: string;
	max_results: number;
	search_depth: "basic";
	include_domains?: string[];
	exclude_domains?: string[];
	include_raw_content?: boolean;
	topic?: "general" | "news";
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Clamp a requested result count into Tavily's accepted 0–20 range. A
 * non-finite value falls back to the shared default rather than producing
 * `NaN` in the JSON body.
 */
function clampMaxResults(value: number): number {
	const requested = Number.isFinite(value)
		? Math.trunc(value)
		: DEFAULT_MAX_RESULTS;
	return Math.min(TAVILY_MAX_RESULTS_LIMIT, Math.max(0, requested));
}

/** `topic` is only forwarded when it is one of the two values Tavily accepts. */
function topicFrom(
	config: WebToolAdapterConfig,
): "general" | "news" | undefined {
	const topic = config.extraConfig.topic;
	return topic === "general" || topic === "news" ? topic : undefined;
}

function buildSearchBody(
	request: WebToolSearchRequest,
	config: WebToolAdapterConfig,
): TavilySearchBody {
	const body: TavilySearchBody = {
		query: request.query,
		max_results: clampMaxResults(request.maxResults),
		search_depth: "basic",
	};

	// Anthropic forbids sending `allowed_domains` and `blocked_domains`
	// together, so a well-formed request never carries both. Tavily accepts
	// both, but if a caller does pass both we honour the allowlist and drop
	// the blocklist — include takes precedence over exclude.
	const allowed = (request.allowedDomains ?? []).filter((d) => d.length > 0);
	const blocked = (request.blockedDomains ?? []).filter((d) => d.length > 0);
	if (allowed.length > 0) {
		body.include_domains = allowed;
	} else if (blocked.length > 0) {
		body.exclude_domains = blocked;
	}

	const topic = topicFrom(config);
	if (topic) body.topic = topic;

	// Extracted page text is expensive on Tavily's side, so only ask for it
	// when the operator explicitly opted in.
	if (config.extraConfig.includeRawContent === true) {
		body.include_raw_content = true;
	}

	return body;
}

/** Minimal body for the dashboard's Test button. */
function buildTestBody(config: WebToolAdapterConfig): TavilySearchBody {
	const body: TavilySearchBody = {
		query: TEST_QUERY,
		max_results: 1,
		search_depth: "basic",
	};
	const topic = topicFrom(config);
	if (topic) body.topic = topic;
	return body;
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

/** POST a search body to Tavily, throwing {@link TavilySearchError} on failure. */
async function postSearch(
	body: TavilySearchBody,
	apiKey: string,
	signal: AbortSignal | undefined,
): Promise<unknown> {
	const effectiveSignal = requestSignal(signal);

	let response: Response;
	try {
		response = await fetch(TAVILY_SEARCH_URL, {
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
			throw new TavilySearchError(408, "Tavily search request aborted");
		}
		throw error;
	}

	if (!response.ok) {
		const excerpt = await readErrorExcerpt(response);
		throw new TavilySearchError(
			response.status,
			`Tavily search failed with status ${response.status}${excerpt ? `: ${excerpt}` : ""}`,
		);
	}

	return response.json();
}

/** Map Tavily's `results` array onto the normalised hit shape. */
function toHits(data: unknown, maxResults: number): WebToolSearchHit[] {
	if (!isRecord(data) || !Array.isArray(data.results)) return [];

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
		if (typeof entry.content === "string" && entry.content) {
			hit.snippet = entry.content;
		}
		if (typeof entry.raw_content === "string" && entry.raw_content) {
			hit.content = entry.raw_content;
		}
		if (typeof entry.published_date === "string" && entry.published_date) {
			hit.publishedDate = entry.published_date;
		}
		hits.push(hit);
	}

	return hits.slice(0, clampMaxResults(maxResults));
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** Build the Tavily adapter singleton. */
export function createTavilyAdapter(): WebToolSearchAdapter {
	return {
		id: "tavily",
		implemented: true,

		async search(
			request: WebToolSearchRequest,
			config: WebToolAdapterConfig,
		): Promise<WebToolSearchHit[]> {
			// The chain filters keyless providers out, but a direct call must not
			// send `Bearer null`.
			if (!config.apiKey) {
				throw new Error("Tavily requires an API key");
			}
			const data = await postSearch(
				buildSearchBody(request, config),
				config.apiKey,
				request.signal,
			);
			return toHits(data, request.maxResults);
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
