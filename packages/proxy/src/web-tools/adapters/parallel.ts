/**
 * Parallel implementation of {@link WebToolSearchAdapter}.
 *
 * Parallel's `/v1/search` endpoint differs from every other provider here in
 * one important way: the query goes in a `search_queries` ARRAY rather than a
 * scalar `query` field. Domain filters live under
 * `advanced_settings.source_policy`, and each result carries `excerpts` (an
 * array of markdown passages) instead of a single snippet.
 *
 * The API key travels in an `x-api-key` header — Parallel does not accept a
 * Bearer scheme — and must never appear in an error message, log line or
 * health write.
 */

import type {
	WebToolAdapterConfig,
	WebToolSearchAdapter,
	WebToolSearchHit,
	WebToolSearchRequest,
} from "../types";

export const PARALLEL_SEARCH_URL = "https://api.parallel.ai/v1/search";

/**
 * Parallel returns 10 results when the request carries no limit, and its
 * search endpoint has NO result-count parameter — `max_results` and
 * `num_results` are both rejected with HTTP 422 `extra_forbidden` (verified
 * against the live API, 2026-11-02). Results are therefore trimmed locally.
 */
const PARALLEL_DEFAULT_RESULTS = 10;
/**
 * Local trim cap. Not a provider limit — Parallel returns 10 by default and
 * the caller may keep fewer.
 */
const MAX_RESULTS_LIMIT = 50;
const SEARCH_TIMEOUT_MS = 10_000;
/** Error bodies are truncated to this many characters before being surfaced. */
const ERROR_BODY_EXCERPT_CHARS = 200;
/** Characters of the joined excerpts that become the snippet. */
const SNIPPET_CHARS = 500;
const TEST_QUERY = "better-ccflare connectivity test";

const PARALLEL_MODES = ["turbo", "fast", "basic", "advanced"] as const;
type ParallelMode = (typeof PARALLEL_MODES)[number];

/**
 * Error raised for a non-2xx Parallel response (and for aborts).
 *
 * `status` mirrors the HTTP status so the fallback chain can decide whether
 * the failure warrants a cooldown (401/402/429) or is transient. The message
 * never contains the API key.
 */
export class ParallelSearchError extends Error {
	constructor(
		readonly status: number,
		message: string,
	) {
		super(message);
		this.name = "ParallelSearchError";
	}
}

/** The subset of Parallel's search body this adapter sends. */
interface ParallelSearchBody {
	search_queries: string[];
	objective?: string;
	mode: ParallelMode;
	advanced_settings?: {
		source_policy: {
			include_domains?: string[];
			exclude_domains?: string[];
		};
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Clamp a requested result count into Parallel's accepted 0–20 range (the
 * same floor as `tavily.ts`). A non-finite value falls back to Parallel's
 * documented default rather than producing `NaN` in the JSON body.
 */
function clampResults(value: number): number {
	const requested = Number.isFinite(value)
		? Math.trunc(value)
		: PARALLEL_DEFAULT_RESULTS;
	return Math.min(MAX_RESULTS_LIMIT, Math.max(0, requested));
}

/**
 * `mode` is only forwarded when it is one of the values Parallel accepts. The
 * default is Parallel's own `basic` — never `fast`, which is faster but
 * shallower.
 */
function modeFrom(config: WebToolAdapterConfig): ParallelMode {
	const mode = config.extraConfig.mode;
	return (PARALLEL_MODES as readonly unknown[]).includes(mode)
		? (mode as ParallelMode)
		: "basic";
}

/** `objective` is forwarded only when configured as a non-empty string. */
function objectiveFrom(config: WebToolAdapterConfig): string | undefined {
	const objective = config.extraConfig.objective;
	return typeof objective === "string" && objective.trim().length > 0
		? objective
		: undefined;
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
	return clampResults(Math.min(request.maxResults, config.maxResults));
}

function buildSourcePolicy(
	request: WebToolSearchRequest,
): ParallelSearchBody["advanced_settings"] {
	// Anthropic forbids sending `allowed_domains` and `blocked_domains`
	// together, so a well-formed request never carries both. If a caller does
	// pass both we honour the allowlist and drop the blocklist — include takes
	// precedence over exclude.
	const allowed = (request.allowedDomains ?? []).filter((d) => d.length > 0);
	const blocked = (request.blockedDomains ?? []).filter((d) => d.length > 0);
	if (allowed.length > 0) {
		return { source_policy: { include_domains: allowed } };
	}
	if (blocked.length > 0) {
		return { source_policy: { exclude_domains: blocked } };
	}
	return undefined;
}

function buildSearchBody(
	request: WebToolSearchRequest,
	config: WebToolAdapterConfig,
): ParallelSearchBody {
	const body: ParallelSearchBody = {
		search_queries: [request.query],
		mode: modeFrom(config),
	};

	const objective = objectiveFrom(config);
	if (objective) body.objective = objective;

	const advanced = buildSourcePolicy(request);
	if (advanced) body.advanced_settings = advanced;

	return body;
}

/** Minimal body for the dashboard's Test button. */
function buildTestBody(config: WebToolAdapterConfig): ParallelSearchBody {
	return {
		search_queries: [TEST_QUERY],
		mode: modeFrom(config),
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

/** POST a search body to Parallel, throwing {@link ParallelSearchError} on failure. */
async function postSearch(
	body: ParallelSearchBody,
	apiKey: string,
	signal: AbortSignal | undefined,
): Promise<unknown> {
	const effectiveSignal = requestSignal(signal);

	let response: Response;
	try {
		response = await fetch(PARALLEL_SEARCH_URL, {
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
			throw new ParallelSearchError(408, "Parallel search request aborted");
		}
		throw error;
	}

	if (!response.ok) {
		const excerpt = await readErrorExcerpt(response);
		throw new ParallelSearchError(
			response.status,
			`Parallel search failed with status ${response.status}${excerpt ? `: ${excerpt}` : ""}`,
		);
	}

	return response.json();
}

/** Map Parallel's `results` array onto the normalised hit shape. */
function toHits(data: unknown, maxResults: number): WebToolSearchHit[] {
	// A missing `results` array is a broken response, not an empty search.
	// Returning [] would mark the provider healthy, stop the fallback chain
	// and show the model "no results" — masking the fault. `{results: []}` is
	// the provider's way of saying "nothing found" and stays valid.
	if (!isRecord(data) || !Array.isArray(data.results)) {
		throw new ParallelSearchError(
			502,
			"Parallel response is missing the results array",
		);
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
		if (Array.isArray(entry.excerpts)) {
			const joined = entry.excerpts
				.filter((excerpt): excerpt is string => typeof excerpt === "string")
				.join("\n\n");
			if (joined) {
				hit.content = joined;
				hit.snippet = joined.slice(0, SNIPPET_CHARS);
			}
		}
		if (typeof entry.publish_date === "string" && entry.publish_date) {
			hit.publishedDate = entry.publish_date;
		}
		hits.push(hit);
	}

	return hits.slice(0, clampResults(maxResults));
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** Build the Parallel adapter singleton. */
export function createParallelAdapter(): WebToolSearchAdapter {
	return {
		id: "parallel",
		implemented: true,

		async search(
			request: WebToolSearchRequest,
			config: WebToolAdapterConfig,
		): Promise<WebToolSearchHit[]> {
			// The chain filters keyless providers out, but a direct call must not
			// send an empty key header.
			if (!config.apiKey) {
				throw new Error("Parallel requires an API key");
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
