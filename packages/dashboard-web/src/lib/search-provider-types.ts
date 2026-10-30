/**
 * Re-exports the search-provider API types from `@better-ccflare/types` under
 * a stable local import path, plus the dashboard-only view types that do not
 * belong in the shared package.
 */

import type { SearchProviderPublic } from "@better-ccflare/types";

export type {
	SearchProviderCatalogEntry,
	SearchProviderExtraConfigField,
	SearchProviderInput as CreateSearchProviderInput,
	SearchProviderPublic,
	SearchProviderUpdate as UpdateSearchProviderInput,
} from "@better-ccflare/types";

export type SearchProviderStatus = SearchProviderPublic["status"];

/** Result of `POST /api/search-providers/:id/test`. */
export interface SearchProviderTestResult {
	ok: boolean;
	latencyMs: number;
	error?: string;
}

/** The three global flags from `GET/PATCH /api/web-search/settings`. */
export interface WebSearchSettings {
	enabled: boolean;
	maxResultChars: number;
	bypassHeader: boolean;
}
