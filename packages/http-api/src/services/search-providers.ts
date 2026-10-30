import type { DatabaseOperations } from "@better-ccflare/database";
import type { SearchProviderStore } from "../handlers/search-providers";

/**
 * The repository methods the web-search feature expects on
 * `DatabaseOperations` (added by the search_providers storage work). Typed
 * structurally here so this package does not need to import the repository
 * class directly.
 */
export interface SearchProviderRepositoryLike {
	listSearchProviders(): ReturnType<SearchProviderStore["list"]>;
	getSearchProvider(id: string): ReturnType<SearchProviderStore["get"]>;
	getSearchProviderApiKey(
		id: string,
	): ReturnType<SearchProviderStore["getApiKey"]>;
	createSearchProvider(
		input: Parameters<SearchProviderStore["create"]>[0],
	): ReturnType<SearchProviderStore["create"]>;
	updateSearchProvider(
		id: string,
		patch: Parameters<SearchProviderStore["update"]>[1],
	): ReturnType<SearchProviderStore["update"]>;
	removeSearchProvider(id: string): ReturnType<SearchProviderStore["remove"]>;
	listActiveSearchProvidersByPriority(): ReturnType<
		SearchProviderStore["listActiveByPriority"]
	>;
}

/**
 * Adapt DatabaseOperations onto the narrow SearchProviderStore interface the
 * handlers depend on. Kept in one small place so the DB layer can rename or
 * restructure its methods without touching handler code.
 */
export function createSearchProviderStore(
	dbOps: DatabaseOperations,
): SearchProviderStore {
	const repo = dbOps as unknown as SearchProviderRepositoryLike;
	return {
		list: () => repo.listSearchProviders(),
		get: (id) => repo.getSearchProvider(id),
		// Until the storage layer exposes an unmasked-key getter, /test fails
		// closed ("no apiKey configured") rather than sending a mask upstream.
		getApiKey: async () => null,
		create: (input) => repo.createSearchProvider(input),
		update: (id, patch) => repo.updateSearchProvider(id, patch),
		remove: (id) => repo.removeSearchProvider(id),
		listActiveByPriority: () => repo.listActiveSearchProvidersByPriority(),
	};
}
