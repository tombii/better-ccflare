// TEMPORARY placeholder for local typecheck/test only — part A owns this file.
export interface SearchProvider {
	id: string;
	provider: string;
	label: string;
	apiKey: string | null;
	priority: number;
	maxResults: number;
	extraConfig: Record<string, unknown> | null;
	enabled: boolean;
	createdAt: string;
	updatedAt: string;
}
export type SearchProviderPublic = Omit<SearchProvider, "apiKey"> & {
	apiKey: null;
	hasApiKey: boolean;
};
export interface SearchProviderInput {
	provider: string;
	label: string;
	apiKey?: string;
	priority?: number;
	maxResults?: number;
	extraConfig?: Record<string, unknown> | null;
}
export interface SearchProviderUpdate {
	label?: string;
	apiKey?: string | null;
	priority?: number;
	maxResults?: number;
	extraConfig?: Record<string, unknown> | null;
	enabled?: boolean;
}
export const SEARCH_PROVIDER_CATALOG: Record<
	string,
	{ id: string; label: string; requiresKey: boolean }
> = {
	tavily: { id: "tavily", label: "Tavily", requiresKey: true },
	brave: { id: "brave", label: "Brave", requiresKey: true },
	searxng: { id: "searxng", label: "SearXNG", requiresKey: false },
};
