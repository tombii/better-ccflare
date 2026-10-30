/**
 * Web search provider accounts (the `search_providers` table).
 *
 * A search provider is a third-party web-search API (Tavily, Exa, ...) the
 * proxy can call when a request asks for server-side web search. Unlike
 * `accounts` these are small, label-addressed rows with no OAuth or
 * request-accounting state.
 */

/** Provider ids the UI can offer. Phase 1 only implements `tavily` in the proxy. */
export type SearchProviderId =
	| "tavily"
	| "exa"
	| "parallel"
	| "deepseek"
	| "serper"
	| "brave"
	| "perplexity";

/**
 * A single configurable field for a provider, rendered generically by the
 * dashboard so the UI doesn't need provider-specific forms.
 */
export interface SearchProviderExtraConfigField {
	key: string;
	label: string;
	type: "text" | "number" | "select" | "boolean";
	/** Options for `type: "select"`. */
	options?: string[];
	placeholder?: string;
	required?: boolean;
	defaultValue?: string | number | boolean;
	description?: string;
}

export interface SearchProviderCatalogEntry {
	id: SearchProviderId;
	label: string;
	requiresKey: boolean;
	docsUrl: string;
	extraConfigFields: SearchProviderExtraConfigField[];
	/**
	 * False for providers listed for discoverability but not yet implemented
	 * by the proxy (phase 1 implements `tavily` only).
	 */
	implemented: boolean;
}

export const SEARCH_PROVIDER_CATALOG: readonly SearchProviderCatalogEntry[] = [
	{
		id: "tavily",
		label: "Tavily",
		requiresKey: true,
		docsUrl:
			"https://docs.tavily.com/documentation/api-reference/endpoint/search",
		implemented: true,
		extraConfigFields: [
			{
				key: "topic",
				label: "Topic",
				type: "select",
				options: ["general", "news"],
				defaultValue: "general",
				description: "Tavily `topic` parameter.",
			},
		],
	},
	{
		id: "exa",
		label: "Exa",
		requiresKey: true,
		docsUrl: "https://docs.exa.ai/reference/search",
		implemented: false,
		extraConfigFields: [
			{
				key: "type",
				label: "Search type",
				type: "select",
				options: ["auto", "keyword", "neural", "fast"],
				defaultValue: "auto",
			},
		],
	},
	{
		id: "parallel",
		label: "Parallel",
		requiresKey: true,
		docsUrl: "https://docs.parallel.ai/search-api/search-quickstart",
		implemented: false,
		extraConfigFields: [],
	},
	{
		id: "deepseek",
		label: "DeepSeek",
		requiresKey: true,
		docsUrl: "https://api-docs.deepseek.com/",
		implemented: false,
		extraConfigFields: [],
	},
	{
		id: "serper",
		label: "Serper",
		requiresKey: true,
		docsUrl: "https://serper.dev/playground",
		implemented: false,
		extraConfigFields: [
			{
				key: "gl",
				label: "Country code",
				type: "text",
				placeholder: "us",
			},
			{
				key: "hl",
				label: "Language code",
				type: "text",
				placeholder: "en",
			},
		],
	},
	{
		id: "brave",
		label: "Brave Search",
		requiresKey: true,
		docsUrl:
			"https://api.search.brave.com/app/documentation/web-search/get-started",
		implemented: false,
		extraConfigFields: [
			{
				key: "country",
				label: "Country",
				type: "text",
				placeholder: "US",
			},
			{
				key: "safesearch",
				label: "Safe search",
				type: "select",
				options: ["off", "moderate", "strict"],
				defaultValue: "moderate",
			},
		],
	},
	{
		id: "perplexity",
		label: "Perplexity",
		requiresKey: true,
		docsUrl: "https://docs.perplexity.ai/api-reference/chat-completions-post",
		implemented: false,
		extraConfigFields: [
			{
				key: "model",
				label: "Model",
				type: "text",
				placeholder: "sonar",
				defaultValue: "sonar",
			},
		],
	},
];

/** Raw `search_providers` row (snake_case, INTEGER booleans — match storage). */
/**
 * A driver-returned integer. PostgreSQL surfaces BIGINT (`int8`) columns as
 * strings to avoid precision loss, while SQLite returns numbers — so every
 * numeric column read into the domain model must be coerced, not trusted.
 */
export type DriverInteger = number | string;

export interface SearchProviderRow {
	id: string;
	provider: string;
	label: string;
	api_key: string | null;
	priority: DriverInteger;
	enabled: DriverInteger; // 0 or 1
	max_results: DriverInteger;
	extra_config: string | null; // JSON object
	status: string;
	status_message: string | null;
	status_checked_at: DriverInteger | null;
	cooldown_until: DriverInteger | null;
	created_at: DriverInteger;
	updated_at: DriverInteger;
}

export interface SearchProviderHealthStatus {
	status: string;
	statusMessage: string | null;
	statusCheckedAt: number | null;
	cooldownUntil: number | null;
}

/**
 * Full domain model — includes the plaintext `api_key`. Only the proxy-side
 * routing code should hold one of these; every read path exposed to the API
 * must return {@link SearchProviderPublic} instead.
 */
export interface SearchProvider extends SearchProviderHealthStatus {
	id: string;
	provider: SearchProviderId;
	label: string;
	apiKey: string | null;
	priority: number;
	enabled: boolean;
	maxResults: number;
	extraConfig: Record<string, unknown>;
	createdAt: number;
	updatedAt: number;
}

/** API-facing shape — the API key is replaced by a masked hint. */
export interface SearchProviderPublic extends SearchProviderHealthStatus {
	id: string;
	provider: SearchProviderId;
	label: string;
	/** `****abcd` (last 4 chars), or null when no key is stored. */
	apiKeyMasked: string | null;
	priority: number;
	enabled: boolean;
	maxResults: number;
	extraConfig: Record<string, unknown>;
	createdAt: number;
	updatedAt: number;
}

export interface SearchProviderInput {
	provider: SearchProviderId;
	label: string;
	apiKey?: string | null;
	priority?: number;
	enabled?: boolean;
	maxResults?: number;
	extraConfig?: Record<string, unknown> | null;
}

export interface SearchProviderUpdate {
	provider?: SearchProviderId;
	label?: string;
	/** Omit to keep the stored key; pass null to clear it. */
	apiKey?: string | null;
	priority?: number;
	enabled?: boolean;
	maxResults?: number;
	extraConfig?: Record<string, unknown> | null;
}

/**
 * Mask an API key for display: `****` followed by its last 4 characters.
 * Null/empty keys stay null. Keys of 4 chars or fewer are fully masked so
 * the hint never reveals the whole secret.
 */
export function maskApiKey(apiKey: string | null | undefined): string | null {
	if (!apiKey) return null;
	if (apiKey.length <= 4) return "****";
	return `****${apiKey.slice(-4)}`;
}

function parseExtraConfig(raw: string | null): Record<string, unknown> {
	if (!raw) return {};
	try {
		const parsed = JSON.parse(raw);
		return parsed && typeof parsed === "object" && !Array.isArray(parsed)
			? (parsed as Record<string, unknown>)
			: {};
	} catch {
		// A hand-edited or truncated value must not break the whole listing.
		return {};
	}
}

/** Coerce a driver integer (number on SQLite, string on PG BIGINT). */
function toInt(value: DriverInteger, fallback = 0): number {
	const parsed = typeof value === "number" ? value : Number(value);
	return Number.isFinite(parsed) ? parsed : fallback;
}

function toNullableInt(value: DriverInteger | null): number | null {
	if (value === null || value === undefined) return null;
	const parsed = typeof value === "number" ? value : Number(value);
	return Number.isFinite(parsed) ? parsed : null;
}

/** Row → full domain model (Row -> Domain, like `toCombo`). */
export function toSearchProvider(row: SearchProviderRow): SearchProvider {
	return {
		id: row.id,
		provider: row.provider as SearchProviderId,
		label: row.label,
		apiKey: row.api_key ?? null,
		priority: toInt(row.priority),
		enabled: toInt(row.enabled) === 1,
		maxResults: toInt(row.max_results),
		extraConfig: parseExtraConfig(row.extra_config),
		status: row.status,
		statusMessage: row.status_message ?? null,
		statusCheckedAt: toNullableInt(row.status_checked_at),
		cooldownUntil: toNullableInt(row.cooldown_until),
		createdAt: toInt(row.created_at),
		updatedAt: toInt(row.updated_at),
	};
}

/** Full model → API-facing model, dropping the plaintext API key. */
export function toSearchProviderPublic(
	provider: SearchProvider,
): SearchProviderPublic {
	const { apiKey, ...rest } = provider;
	return { ...rest, apiKeyMasked: maskApiKey(apiKey) };
}
