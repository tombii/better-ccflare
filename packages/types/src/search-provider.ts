/**
 * Web search provider accounts (the `search_providers` table).
 *
 * A search provider is a third-party web-search API (Tavily, Exa, ...) the
 * proxy can call when a request asks for server-side web search. Unlike
 * `accounts` these are small, label-addressed rows with no OAuth or
 * request-accounting state.
 */

/**
 * Provider ids the UI can offer. Which of them the proxy can actually call is
 * recorded per entry by {@link SearchProviderCatalogEntry.implemented}.
 */
export type SearchProviderId =
	| "tavily"
	| "exa"
	| "parallel"
	| "deepseek"
	| "serper"
	| "brave"
	| "tinyfish"
	| "firecrawl"
	| "keenable"
	| "nimble"
	| "linkup"
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

/** A search provider's access tier: keyless public endpoint, or keyed. */
export type SearchProviderTier = "free" | "paid";

/**
 * What the keyless (free) endpoint of a provider cannot do.
 *
 * The free endpoints are anonymous public twins of the keyed APIs, so they
 * accept the same body shape but drop or reject some options. The dashboard
 * warns about these on a keyless row rather than letting an operator wonder
 * why a setting has no effect.
 */
export interface SearchProviderKeylessInfo {
	/** Extra-config keys the keyless endpoint does not apply. */
	droppedExtraConfigKeys?: string[];
	/** Request parameters the keyless endpoint does not apply. */
	droppedRequestParams?: string[];
	/** Result count the keyless endpoint caps at (adapter clamps to it). */
	maxResultsCap?: number;
	/** Human-readable limits, e.g. "1000 requests/hour shared per server IP". */
	limitsNote: string;
	/** Optional header the endpoint needs as an app identifier (e.g. Keenable). */
	appIdentifierHeader?: { name: string; value: string };
}

export interface SearchProviderCatalogEntry {
	id: SearchProviderId;
	label: string;
	/**
	 * True when a row of this provider MUST have an API key to be saved.
	 * False for providers with a keyless path: the key becomes optional and
	 * the adapter picks the free or keyed endpoint from what is stored.
	 */
	requiresKey: boolean;
	docsUrl: string;
	extraConfigFields: SearchProviderExtraConfigField[];
	/**
	 * False for providers listed for discoverability but not yet implemented
	 * by the proxy. The source of truth for which ids have an adapter is the
	 * registry in `packages/proxy/src/web-tools/adapters/index.ts`.
	 */
	implemented: boolean;
	/** Tiers this provider supports. Absent means `["paid"]`. */
	tiers?: SearchProviderTier[];
	/** Present when the provider has a keyless (free) path. */
	keyless?: SearchProviderKeylessInfo;
	/**
	 * Placement of the seeded free-tier row when free search is enabled:
	 * last-resort priority and the enabled state it is installed with.
	 * Absent for providers without a keyless path.
	 */
	freeTierDefault?: { priority: number; enabled: boolean };
}

/** Tiers a catalog entry supports (defaults to keyed-only). */
export function catalogTiers(
	entry: SearchProviderCatalogEntry,
): SearchProviderTier[] {
	return entry.tiers ?? ["paid"];
}

/** Whether the provider can run without a stored key. */
export function catalogSupportsKeyless(
	entry: SearchProviderCatalogEntry,
): boolean {
	return entry.keyless !== undefined && catalogTiers(entry).includes("free");
}

/**
 * The tier a row actually uses, derived from the provider and the stored key.
 *
 * A key always means the paid endpoint and no key always means the free one —
 * there is no third state, which is what keeps the stored `tier` from ever
 * disagreeing with the call the adapter makes. A row with no key for a
 * provider lacking a keyless path is reported as `'paid'`: its search fails
 * loudly (adapter requires a key) rather than silently hitting a free tier
 * that does not exist.
 */
export function resolveSearchProviderTier(
	entry: SearchProviderCatalogEntry | undefined,
	apiKey: string | null | undefined,
): SearchProviderTier {
	if (apiKey) return "paid";
	return entry && catalogSupportsKeyless(entry) ? "free" : "paid";
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
		implemented: true,
		extraConfigFields: [
			{
				key: "type",
				label: "Search type",
				type: "select",
				// Exa's current pricing/quality tiers. The legacy `keyword`,
				// `neural` and `fast` names are still accepted by the API but
				// the adapter only forwards these four, so offering the legacy
				// ones in the UI would silently send `auto` instead.
				options: ["auto", "lite", "deep-lite", "deep"],
				defaultValue: "auto",
				description:
					"Quality/cost tier. `lite` is cheapest, `deep` the slowest.",
			},
		],
	},
	{
		id: "parallel",
		label: "Parallel",
		requiresKey: true,
		docsUrl: "https://docs.parallel.ai/search-api/search-quickstart",
		implemented: true,
		extraConfigFields: [
			{
				key: "mode",
				label: "Mode",
				type: "select",
				options: ["turbo", "fast", "basic", "advanced"],
				defaultValue: "basic",
				description:
					"Processing mode. `fast`/`turbo` are cheapest, `advanced` the most thorough.",
			},
			{
				key: "objective",
				label: "Objective",
				type: "text",
				placeholder: "What the search is for, e.g. 'current API docs'",
				description:
					"Guides result selection. Leave blank to search on the query alone.",
			},
		],
	},
	{
		id: "deepseek",
		label: "DeepSeek",
		requiresKey: true,
		docsUrl: "https://api-docs.deepseek.com/",
		implemented: true,
		extraConfigFields: [],
	},
	{
		id: "serper",
		label: "Serper",
		requiresKey: true,
		docsUrl: "https://serper.dev/playground",
		implemented: true,
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
		implemented: true,
		extraConfigFields: [
			{
				key: "endpoint",
				label: "Endpoint",
				type: "select",
				// Two products, one plan, one price. `llm-context` returns
				// pre-extracted page chunks instead of the short meta
				// descriptions `web` returns — strictly better input for an
				// agent's search tool, at the same $5/1k, so it is the default.
				options: ["llm-context", "web"],
				defaultValue: "llm-context",
				description:
					"`llm-context` returns model-ready page chunks; `web` returns human-oriented URLs and short snippets. Rows whose Brave plan lacks LLM Context (the legacy Free AI plan) fall back to `web` automatically.",
			},
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
		id: "tinyfish",
		label: "Tinyfish",
		requiresKey: true,
		docsUrl: "https://docs.tinyfish.ai/search-api/reference",
		implemented: true,
		extraConfigFields: [
			{
				key: "location",
				label: "Location",
				type: "text",
				placeholder: "US",
				defaultValue: "US",
				description: "Country code biasing result ranking.",
			},
			{
				key: "language",
				label: "Language",
				type: "text",
				placeholder: "en",
				defaultValue: "en",
			},
			{
				key: "domain_type",
				label: "Domain type",
				type: "select",
				options: ["web", "news", "research_paper"],
				description:
					"Which index to search. Leave unset for the default web index.",
			},
			{
				key: "purpose",
				label: "Purpose",
				type: "text",
				placeholder: "What the search is for, e.g. 'fact-checking'",
				description:
					"Free text describing the search intent. Leave blank to search on the query alone.",
			},
		],
	},
	{
		id: "firecrawl",
		label: "Firecrawl",
		// A key is optional: without one the adapter calls the keyless v2
		// endpoint, which Firecrawl gates by IP reputation.
		requiresKey: false,
		docsUrl: "https://docs.firecrawl.dev/api-reference/endpoint/search",
		implemented: true,
		tiers: ["free", "paid"],
		keyless: {
			droppedRequestParams: ["blockedDomains"],
			limitsNote:
				"No key: anonymous calls are IP-gated (blocked from VPN/proxy/datacenter IPs) and rate-limited. Add a key for higher limits.",
		},
		freeTierDefault: { priority: 901, enabled: false },
		extraConfigFields: [
			{
				key: "location",
				label: "Location",
				type: "text",
				placeholder: "United States",
				description:
					"Location string biasing result ranking. Leave blank for no bias.",
			},
			{
				key: "tbs",
				label: "Time-based filter",
				type: "text",
				placeholder: "qdr:d",
				description:
					"Time filter such as `qdr:h` (past hour), `qdr:d` (past day), `qdr:w` (past week).",
			},
		],
	},
	{
		id: "keenable",
		label: "Keenable",
		// A key is optional: without one the adapter calls the keyless
		// `/v1/search/public` twin with the app-identifier header.
		requiresKey: false,
		docsUrl: "https://docs.keenable.ai/api-reference/search",
		implemented: true,
		tiers: ["free", "paid"],
		keyless: {
			droppedRequestParams: ["blockedDomains"],
			maxResultsCap: 50,
			limitsNote:
				"No key: 1,000 requests/hour (10/s) shared per server IP, so a busy proxy can exhaust the free bucket.",
			appIdentifierHeader: {
				name: "X-Keenable-Title",
				value: "better-ccflare",
			},
		},
		freeTierDefault: { priority: 900, enabled: false },
		extraConfigFields: [
			{
				key: "mode",
				label: "Mode",
				type: "select",
				options: ["pro", "realtime"],
				description:
					"`pro` (default) does deeper retrieval; `realtime` is fastest. Billed as separate SKUs.",
			},
			{
				key: "site",
				label: "Site",
				type: "text",
				placeholder: "techcrunch.com",
				description:
					"Restrict results to one domain. Leave blank for the whole web; a single `allowed_domains` entry from the request is applied here too.",
			},
			{
				key: "published_after",
				label: "Published after",
				type: "text",
				placeholder: "7d",
				description:
					"Date, ISO 8601 timestamp, or relative delta (`7d`, `30min`). Leave blank for no filter.",
			},
			{
				key: "published_before",
				label: "Published before",
				type: "text",
				placeholder: "2026-01-01",
			},
			{
				key: "acquired_after",
				label: "Indexed after",
				type: "text",
				placeholder: "7d",
				description: "When the page was crawled into the index.",
			},
			{
				key: "snippet_max_length",
				label: "Snippet length",
				type: "number",
				placeholder: "1000",
				description: "Characters per result snippet (180–10000).",
			},
		],
	},
	{
		id: "nimble",
		label: "Nimble",
		requiresKey: true,
		docsUrl: "https://docs.nimbleway.com/nimble-sdk/web-tools/search",
		implemented: true,
		extraConfigFields: [
			{
				key: "search_depth",
				label: "Search depth",
				type: "select",
				options: ["standard", "lite"],
				defaultValue: "standard",
				description:
					"`standard` returns richer per-result text, delivered in the result description; `lite` returns titles, URLs and snippets only (cheaper, more token-efficient).",
			},
			{
				key: "focus",
				label: "Focus",
				type: "select",
				options: ["general", "news"],
				defaultValue: "general",
				description:
					"Nimble `focus` mode; `news` returns current-events results.",
			},
		],
	},
	{
		id: "linkup",
		label: "Linkup",
		requiresKey: true,
		docsUrl:
			"https://docs.linkup.so/pages/documentation/endpoints/search/overview",
		implemented: true,
		extraConfigFields: [
			{
				key: "depth",
				label: "Search depth",
				type: "select",
				options: ["fast", "standard", "deep", "flash"],
				defaultValue: "standard",
				description:
					"`flash` is lowest latency (alpha), `fast`/`standard` are one-shot retrieval, `deep` runs several iterations at roughly 5x the per-call price.",
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
	/** `'free'` (keyless endpoint) or `'paid'` (keyed endpoint). */
	tier?: string;
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
	/**
	 * Which endpoint the row uses: `'free'` calls the provider's keyless
	 * endpoint, `'paid'` its keyed one. Always derived at the handler boundary
	 * from the stored key (see {@link resolveSearchProviderTier}), so it can
	 * never disagree with what the adapter will actually call.
	 */
	tier: SearchProviderTier;
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
	tier: SearchProviderTier;
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
	/**
	 * Requested endpoint tier. The handler only accepts `'free'` for a row
	 * with no key and `'paid'` for a row with one; it is stored as resolved.
	 */
	tier?: SearchProviderTier;
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
	tier?: SearchProviderTier;
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
		tier: row.tier === "free" ? "free" : "paid",
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
