/**
 * Adapter registry for local `web_search` interception.
 *
 * Only providers with a working adapter live here. The dashboard marks the
 * rest of {@link SEARCH_PROVIDER_CATALOG} as `implemented: false`, so a
 * missing entry is the expected state, not an error.
 */

import type { SearchProviderId } from "@better-ccflare/types";
import type { WebToolAdapterRegistry, WebToolSearchAdapter } from "../types";
import { createTavilyAdapter } from "./tavily";

const adapters: WebToolAdapterRegistry = {
	tavily: createTavilyAdapter(),
};

/**
 * Look up the adapter for a catalog provider id.
 *
 * Returns `undefined` for every id without an implementation (currently all
 * but `tavily`); callers must treat that as "skip this provider".
 */
export function getWebToolAdapter(
	id: SearchProviderId,
): WebToolSearchAdapter | undefined {
	return adapters[id];
}

export { adapters as webToolAdapterRegistry };
