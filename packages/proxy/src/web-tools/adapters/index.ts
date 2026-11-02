/**
 * Adapter registry for local `web_search` interception.
 *
 * Only providers with a working adapter live here — currently `tavily`,
 * `exa`, `parallel`, `deepseek`, `serper` and `brave`. The dashboard marks the
 * rest of {@link SEARCH_PROVIDER_CATALOG} as `implemented: false`, so a missing
 * entry is the expected state, not an error.
 */

import type { SearchProviderId } from "@better-ccflare/types";
import type { WebToolAdapterRegistry, WebToolSearchAdapter } from "../types";
import { createBraveAdapter } from "./brave";
import { createDeepSeekAdapter } from "./deepseek";
import { createExaAdapter } from "./exa";
import { createParallelAdapter } from "./parallel";
import { createSerperAdapter } from "./serper";
import { createTavilyAdapter } from "./tavily";

const adapters: WebToolAdapterRegistry = {
	tavily: createTavilyAdapter(),
	exa: createExaAdapter(),
	parallel: createParallelAdapter(),
	deepseek: createDeepSeekAdapter(),
	serper: createSerperAdapter(),
	brave: createBraveAdapter(),
};

/**
 * Look up the adapter for a catalog provider id.
 *
 * Returns `undefined` for every id without an implementation (currently only
 * `perplexity`); callers must treat that as "skip this provider".
 */
export function getWebToolAdapter(
	id: SearchProviderId,
): WebToolSearchAdapter | undefined {
	return adapters[id];
}

export { adapters as webToolAdapterRegistry };
