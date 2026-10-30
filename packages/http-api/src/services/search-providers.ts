import type { DatabaseOperations } from "@better-ccflare/database";
import type {
	SearchProviderInput,
	SearchProviderPublic,
	SearchProviderUpdate,
} from "@better-ccflare/types";
import type { SearchProviderStore } from "../handlers/search-providers";

/**
 * The web-search handlers depend on this narrow interface rather than on
 * `DatabaseOperations` directly, so the storage layer can rename or
 * restructure its methods without touching handler code.
 *
 * Adapts onto the masked `DatabaseOperations` methods for everything an HTTP
 * response may carry. `getApiKey` is the one exception: the public row is
 * masked by design, so the unmasked key is read straight from the repository,
 * which is the only place that holds plaintext.
 */
export function createSearchProviderStore(
	dbOps: DatabaseOperations,
): SearchProviderStore {
	return {
		list: (): Promise<SearchProviderPublic[]> => dbOps.listSearchProviders(),
		get: (id: string) => dbOps.getSearchProvider(id),
		getApiKey: async (id: string): Promise<string | null> => {
			const row = await dbOps.getSearchProviderRepository().findById(id);
			return row?.apiKey ?? null;
		},
		create: (input: SearchProviderInput) => dbOps.createSearchProvider(input),
		update: (id: string, patch: SearchProviderUpdate) =>
			dbOps.updateSearchProvider(id, patch),
		remove: (id: string) => dbOps.deleteSearchProvider(id),
	};
}
