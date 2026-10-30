/**
 * Orchestrator for local `web_search` interception. See `types.ts` for the
 * background.
 *
 * This is the only module in `web-tools/` with side effects: it detects the
 * helper request, runs the provider chain and synthesises the Anthropic
 * response. Every failure degrades to `null` — the caller then forwards the
 * request upstream exactly as before, which is always correct because
 * Anthropic can still run the search itself. A local search is an
 * optimisation, never a requirement.
 *
 * A short-circuited search deliberately writes no `requests` row and selects
 * no account: no upstream call happens, so there is nothing to attribute.
 */

import type { Config } from "@better-ccflare/config";
import type { DatabaseOperations } from "@better-ccflare/database";
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
	dbOps: Pick<DatabaseOperations, "getSearchProviderRepository">;
	signal?: AbortSignal;
	/** Injectable for tests; defaults to Date.now. */
	now?: () => number;
	log?: { info(msg: string): void; warn(msg: string): void };
}

function errorMessage(error: unknown): string {
	if (error instanceof Error) return error.message;
	return String(error);
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
	const detected = detectWebSearchRequest(deps.body, {
		enabled: deps.config.getWebSearchEnabled(),
		pathname: deps.pathname,
		headers: deps.headers,
		bypassHeaderEnabled: deps.config.getWebSearchBypassHeader(),
	});
	if (!detected) return null;

	try {
		const result = await runWebSearchChain(
			{
				dbOps: deps.dbOps,
				signal: deps.signal,
				now: deps.now,
				log: deps.log,
			},
			{
				query: detected.query,
				maxResults: MAX_RESULTS,
				allowedDomains: detected.allowedDomains,
				blockedDomains: detected.blockedDomains,
				signal: deps.signal,
			},
		);

		if (!result) {
			deps.log?.info("web_search: no provider available, falling through");
			return null;
		}

		const response = buildWebSearchResponse({
			request: detected,
			hits: result.hits,
			maxResultChars: deps.config.getWebSearchMaxResultChars(),
		});

		// The query text is never logged at info level — queries can be
		// sensitive, so only its length is reported.
		deps.log?.info(
			`web_search: served by ${result.providerId} (${result.providerLabel}), ${result.hits.length} hit(s) in ${result.latencyMs}ms, query ${detected.query.length} chars`,
		);
		return response;
	} catch (error) {
		deps.log?.warn(
			`web_search: interception failed, falling through: ${errorMessage(error)}`,
		);
		return null;
	}
}
