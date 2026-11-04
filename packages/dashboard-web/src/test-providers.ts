import type { SearchProviderCatalogEntry } from "@better-ccflare/types";

/**
 * A keyless-capable catalog entry for tests: the shape the server sends for a
 * provider with a free tier (Keenable, Firecrawl), including the `keyless`
 * metadata and `tiers` the dashboard reads.
 */
export const KEYLESS_TEST_ENTRY: SearchProviderCatalogEntry = {
	id: "keenable",
	label: "Keenable",
	requiresKey: false,
	docsUrl: "https://docs.keenable.ai/api-reference/search",
	implemented: true,
	tiers: ["free", "paid"],
	keyless: {
		limitsNote: "1,000 requests/hour shared per server IP",
	},
	extraConfigFields: [],
};
