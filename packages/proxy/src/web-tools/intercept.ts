/**
 * Orchestrator for local `web_search` interception. See `types.ts` for the
 * background.
 *
 * This is the only module in `web-tools/` with side effects: it detects the
 * helper request, runs the provider chain, synthesises the Anthropic response
 * and records the outcome in `web_tool_calls`. Every failure degrades to
 * `null` — the caller then forwards the request upstream exactly as before,
 * which is always correct because Anthropic can still run the search itself.
 * A local search is an optimisation, never a requirement.
 *
 * A short-circuited search deliberately writes no `requests` row and selects
 * no account: no upstream call happens, so there is nothing to attribute. The
 * `web_tool_calls` row is the only trace of it.
 */

import type { Config } from "@better-ccflare/config";
import type { DatabaseOperations } from "@better-ccflare/database";
import type { WebToolCallWriteInput } from "@better-ccflare/types";
import { runWebSearchChain } from "./chain";
import { detectWebSearchRequest } from "./detect";
import { buildWebSearchResponse } from "./responder";

/** How many hits to request per search; the responder trims the digest. */
const MAX_RESULTS = 10;

export interface WebSearchInterceptDeps {
	body: unknown;
	pathname: string;
	headers: Headers;
	config: Pick<
		Config,
		| "getWebSearchEnabled"
		| "getWebSearchBypassHeader"
		| "getWebSearchMaxResultChars"
	>;
	dbOps: Pick<
		DatabaseOperations,
		"getSearchProviderRepository" | "recordWebToolCall"
	>;
	signal?: AbortSignal;
	/** Injectable for tests; defaults to Date.now. */
	now?: () => number;
	/** Request attribution, when the proxy knows it yet. */
	project?: string | null;
	/** Selected account, when one has been chosen (never for a served call). */
	accountId?: string | null;
	log?: { info(msg: string): void; warn(msg: string): void };
}

function errorMessage(error: unknown): string {
	if (error instanceof Error) return error.message;
	return String(error);
}

/**
 * Fixed code for a failure inside the interceptor itself.
 *
 * The message goes to the log only. This column is long-lived and exportable,
 * so it holds a constant — an exception message can carry a path, a URL or a
 * fragment of the request, and nothing here is allowed to redact reliably.
 */
const INTERCEPTION_FAILED_CODE = "interception_failed";

/**
 * Record one trace without ever letting the write fail the search. Like the
 * chain's health writes, traceability is observability and must never sit on
 * the response's critical path (a BUSY write can be retried for minutes).
 */
function recordTrace(
	dbOps: Pick<DatabaseOperations, "recordWebToolCall"> | undefined,
	input: WebToolCallWriteInput,
	log: WebSearchInterceptDeps["log"],
): void {
	try {
		void dbOps
			?.recordWebToolCall(input)
			.catch((error: unknown) =>
				log?.warn(
					`web_search: failed to record trace (${input.status}): ${errorMessage(error)}`,
				),
			);
	} catch (error) {
		// A missing dbOps or a synchronous throw must not change the response.
		log?.warn(
			`web_search: failed to record trace (${input.status}): ${errorMessage(error)}`,
		);
	}
}

/**
 * Serve a recognised `web_search` helper request locally.
 *
 * @returns the synthesised Anthropic response, or `null` when the request is
 *   not a helper request or no search provider could serve it — in which case
 *   the caller must forward the request upstream unchanged.
 */
export async function maybeInterceptWebSearch(
	deps: WebSearchInterceptDeps,
): Promise<Response | null> {
	const _now = deps.now ?? Date.now;
	const detected = detectWebSearchRequest(deps.body, {
		enabled: deps.config.getWebSearchEnabled(),
		pathname: deps.pathname,
		headers: deps.headers,
		bypassHeaderEnabled: deps.config.getWebSearchBypassHeader(),
	});
	// Not a helper request: not a search attempt, so nothing is recorded.
	if (!detected) return null;

	const query = detected.query;
	const attribution = {
		project: deps.project ?? null,
		accountId: deps.accountId ?? null,
		queryText: query,
		queryChars: query.length,
	};

	try {
		const outcome = await runWebSearchChain(
			{
				dbOps: deps.dbOps,
				signal: deps.signal,
				now: deps.now,
				log: deps.log,
			},
			{
				query,
				maxResults: MAX_RESULTS,
				allowedDomains: detected.allowedDomains,
				blockedDomains: detected.blockedDomains,
				signal: deps.signal,
			},
		);

		if (!outcome.ok) {
			// `all_failed` means at least one provider was called and failed;
			// `no_provider` means nothing was eligible, so the search was never
			// attempted and is a plain fall-through (still paid at Anthropic).
			const failed = outcome.reason === "all_failed";
			recordTrace(
				deps.dbOps,
				{
					...attribution,
					tool: "web_search",
					providerId: failed ? outcome.lastProviderRowId : null,
					providerKind: failed ? outcome.lastProviderId : null,
					resultCount: null,
					latencyMs: outcome.latencyMs,
					status: failed ? "error" : "fallthrough",
					// The short code, never the message: the trace outlives the
					// log and may be exported, and the message quotes the
					// provider's response body.
					errorCode: failed ? outcome.lastErrorCode : null,
				},
				deps.log,
			);
			deps.log?.info(
				failed
					? "web_search: every provider failed, falling through"
					: "web_search: no provider available, falling through",
			);
			return null;
		}

		recordTrace(
			deps.dbOps,
			{
				...attribution,
				tool: "web_search",
				providerId: outcome.providerRowId,
				providerKind: outcome.providerId,
				resultCount: outcome.hits.length,
				latencyMs: outcome.latencyMs,
				status: "ok",
				errorCode: null,
			},
			deps.log,
		);

		const response = buildWebSearchResponse({
			request: detected,
			hits: outcome.hits,
			maxResultChars: deps.config.getWebSearchMaxResultChars(),
		});

		// The query text is never logged at info level — queries can be
		// sensitive, so only its length is reported.
		deps.log?.info(
			`web_search: served by ${outcome.providerId} (${outcome.providerLabel}), ${outcome.hits.length} hit(s) in ${outcome.latencyMs}ms, query ${query.length} chars`,
		);
		return response;
	} catch (error) {
		// The chain never throws by contract; anything here is an interception
		// bug. It is recorded like a failed search only if an attempt is
		// unknowable — fallthrough is the truthful label for "not served".
		recordTrace(
			deps.dbOps,
			{
				...attribution,
				tool: "web_search",
				providerId: null,
				providerKind: null,
				resultCount: null,
				latencyMs: 0,
				status: "fallthrough",
				errorCode: INTERCEPTION_FAILED_CODE,
			},
			deps.log,
		);
		deps.log?.warn(
			`web_search: interception failed, falling through: ${errorMessage(error)}`,
		);
		return null;
	}
}
