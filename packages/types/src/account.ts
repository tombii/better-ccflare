// Usage data types for Anthropic accounts
export interface UsageWindowData {
	utilization: number | null;
	resets_at: string | null;
}

export interface AnthropicUsageData {
	five_hour?: UsageWindowData;
	seven_day?: UsageWindowData;
	seven_day_oauth_apps?: UsageWindowData;
	seven_day_opus?: UsageWindowData;
}

// Usage data types for NanoGPT accounts
export interface NanoGPTUsageWindow {
	used: number;
	remaining: number;
	percentUsed: number; // 0-1 decimal range from API, displayed as 0-100%
	resetAt: number; // Unix timestamp in milliseconds
}

export interface NanoGPTUsageData {
	active: boolean; // true = subscription active, false = PayG mode
	limits: {
		daily: number;
		monthly: number;
	};
	enforceDailyLimit: boolean;
	daily: NanoGPTUsageWindow;
	monthly: NanoGPTUsageWindow;
	state: "active" | "grace" | "inactive";
	graceUntil: string | null;
}

// Usage data types for Zai accounts
export interface ZaiUsageWindow {
	used: number;
	remaining: number;
	percentage: number; // 0-100 from API
	resetAt: number | null; // Unix timestamp in milliseconds
	type: string;
}

export interface ZaiUsageData {
	time_limit: ZaiUsageWindow | null;
	tokens_limit: ZaiUsageWindow | null;
}

// Usage data types for Kilo accounts
export interface KiloUsageData {
	remainingUsd: number; // Remaining credits in USD
	microdollarsUsed: number;
	totalMicrodollarsAcquired: number;
	utilizationPercent: number; // 0-100
}

// Usage data types for Alibaba Coding Plan accounts
export interface AlibabaCodingPlanQuotaWindow {
	used: number;
	total: number;
	percentUsed: number; // 0-100
	resetAt: number | null; // Unix timestamp in milliseconds
}

export interface AlibabaCodingPlanUsageData {
	five_hour: AlibabaCodingPlanQuotaWindow;
	weekly: AlibabaCodingPlanQuotaWindow;
	monthly: AlibabaCodingPlanQuotaWindow;
	planName: string | null;
	status: string | null;
	remainingDays: number | null;
}

// Combined usage data type that supports all providers
export type FullUsageData =
	| AnthropicUsageData
	| NanoGPTUsageData
	| ZaiUsageData
	| KiloUsageData
	| AlibabaCodingPlanUsageData;

// Database row types that match the actual database schema
export interface AccountRow {
	id: string;
	name: string;
	provider: string | null;
	api_key: string | null;
	refresh_token: string;
	access_token: string | null;
	expires_at: number | null;
	created_at: number;
	last_used: number | null;
	request_count: number;
	total_requests: number;
	rate_limited_until?: number | null;
	session_start?: number | null;
	session_request_count?: number;
	paused?: boolean | number | null;
	rate_limit_reset?: number | null;
	rate_limit_status?: string | null;
	rate_limit_remaining?: number | null;
	priority?: number;
	auto_fallback_enabled?: boolean | number | null;
	auto_refresh_enabled?: boolean | number | null;
	custom_endpoint?: string | null;
	model_mappings?: string | null; // JSON string for OpenAI-compatible providers
	cross_region_mode?: string | null; // Bedrock cross-region inference mode
	model_fallbacks?: string | null; // JSON string for model family fallback mappings
}

// Domain model - used throughout the application
export interface Account {
	id: string;
	name: string;
	provider: string;
	api_key: string | null;
	refresh_token: string;
	access_token: string | null;
	expires_at: number | null;
	request_count: number;
	total_requests: number;
	last_used: number | null;
	created_at: number;
	rate_limited_until: number | null;
	session_start: number | null;
	session_request_count: number;
	paused: boolean;
	rate_limit_reset: number | null;
	rate_limit_status: string | null;
	rate_limit_remaining: number | null;
	priority: number;
	auto_fallback_enabled: boolean;
	auto_refresh_enabled: boolean;
	custom_endpoint: string | null;
	model_mappings: string | null; // JSON string for OpenAI-compatible providers
	cross_region_mode: string | null; // Bedrock cross-region inference mode
	model_fallbacks: string | null; // JSON string for model family fallback mappings
}

// API response type - what clients receive
export interface AccountResponse {
	id: string;
	name: string;
	provider: string;
	requestCount: number;
	totalRequests: number;
	lastUsed: string | null;
	created: string;
	paused: boolean;
	tokenStatus: "valid" | "expired";
	tokenExpiresAt: string | null; // ISO timestamp of token expiration
	rateLimitStatus: string;
	rateLimitReset: string | null;
	rateLimitRemaining: number | null;
	rateLimitedUntil: number | null;
	sessionInfo: string;
	priority: number;
	autoFallbackEnabled: boolean;
	autoRefreshEnabled: boolean;
	customEndpoint: string | null;
	modelMappings: { [key: string]: string | string[] } | null; // Parsed model mappings (arrays = cycling models)
	usageUtilization: number | null; // Percentage utilization (0-100) from API
	usageWindow: string | null; // Most restrictive window (e.g., "five_hour")
	usageData: FullUsageData | null; // Full usage data for Anthropic accounts
	hasRefreshToken: boolean; // Indicates if the account has a refresh token (OAuth account)
	crossRegionMode?: string | null; // Cross-region inference mode for Bedrock accounts
	modelFallbacks?: { [key: string]: string } | null;
}

// UI display type - used in CLI and web dashboard
export interface AccountDisplay {
	id: string;
	name: string;
	provider: string;
	created: Date;
	lastUsed: Date | null;
	requestCount: number;
	totalRequests: number;
	tokenStatus: "valid" | "expired";
	rateLimitStatus: string;
	sessionInfo: string;
	paused: boolean;
	rate_limited_until?: number | null;
	session_start?: number | null;
	session_request_count?: number;
	access_token?: string | null;
	priority: number;
	autoFallbackEnabled: boolean;
	autoRefreshEnabled: boolean;
}

// CLI list item type
export interface AccountListItem {
	id: string;
	name: string;
	provider: string;
	created: Date;
	lastUsed: Date | null;
	requestCount: number;
	totalRequests: number;
	paused: boolean;
	tokenStatus: "valid" | "expired";
	rateLimitStatus: string;
	sessionInfo: string;
	mode:
		| "claude-oauth"
		| "console"
		| "zai"
		| "minimax"
		| "anthropic-compatible"
		| "openai-compatible"
		| "nanogpt"
		| "vertex-ai"
		| "bedrock"
		| "kilo"
		| "openrouter"
		| "alibaba-coding-plan"
		| "codex";
	priority: number;
	autoFallbackEnabled: boolean;
	autoRefreshEnabled: boolean;
	customEndpoint?: string | null;
	crossRegionMode?: string | null; // Bedrock cross-region inference mode
}

// Account creation types
export interface AddAccountOptions {
	name: string;
	mode?:
		| "claude-oauth"
		| "console"
		| "zai"
		| "minimax"
		| "anthropic-compatible"
		| "openai-compatible"
		| "bedrock"
		| "openrouter";
	priority?: number;
	customEndpoint?: string;
}

export interface AccountDeleteRequest {
	confirm: string;
}

// Helper coercions for database rows (handles both SQLite integers and PostgreSQL booleans/bigints)
function toNum(v: unknown): number {
	return Number(v) || 0;
}
function toNumOrNull(v: unknown): number | null {
	const n = Number(v);
	return Number.isFinite(n) && n !== 0 ? n : v != null && v !== 0 ? n : null;
}

// Type mappers
export function toAccount(row: AccountRow): Account {
	return {
		id: row.id,
		name: row.name,
		provider: row.provider || "anthropic",
		api_key: row.api_key,
		refresh_token: row.refresh_token,
		access_token: row.access_token,
		expires_at: toNumOrNull(row.expires_at),
		created_at: toNum(row.created_at),
		last_used: toNumOrNull(row.last_used),
		request_count: toNum(row.request_count),
		total_requests: toNum(row.total_requests),
		rate_limited_until: toNumOrNull(row.rate_limited_until),
		session_start: toNumOrNull(row.session_start),
		session_request_count: toNum(row.session_request_count),
		paused: !!row.paused,
		rate_limit_reset: toNumOrNull(row.rate_limit_reset),
		rate_limit_status: row.rate_limit_status || null,
		rate_limit_remaining: toNumOrNull(row.rate_limit_remaining),
		priority: toNum(row.priority),
		auto_fallback_enabled: !!row.auto_fallback_enabled,
		auto_refresh_enabled: !!row.auto_refresh_enabled,
		custom_endpoint: row.custom_endpoint || null,
		model_mappings: row.model_mappings || null,
		cross_region_mode: row.cross_region_mode || null,
		model_fallbacks: row.model_fallbacks || null,
	};
}

export function toAccountResponse(account: Account): AccountResponse {
	const tokenStatus = account.access_token ? "valid" : "expired";
	const isRateLimited =
		account.rate_limited_until && account.rate_limited_until > Date.now();
	const rateLimitStatus =
		isRateLimited && account.rate_limited_until
			? `Rate limited until ${new Date(account.rate_limited_until).toLocaleString()}`
			: "OK";

	const sessionInfo = account.session_start
		? `Session: ${account.session_request_count} requests`
		: "No active session";

	// Parse model mappings (supported for any provider)
	let modelMappings: { [key: string]: string } | null = null;
	if (account.model_mappings) {
		try {
			const parsed = JSON.parse(account.model_mappings);
			// Stored as flat {"model": "target"} object
			modelMappings =
				typeof parsed === "object" && parsed !== null ? parsed : null;
		} catch {
			// If parsing fails, ignore model mappings
			modelMappings = null;
		}
	} else if (account.custom_endpoint) {
		// Also try parsing from custom_endpoint for backwards compatibility
		try {
			const parsed = JSON.parse(account.custom_endpoint);
			if (parsed.modelMappings) {
				modelMappings = parsed.modelMappings;
			}
		} catch {
			// If parsing fails, ignore model mappings
			modelMappings = null;
		}
	}

	// Parse model fallbacks for all providers
	let modelFallbacks: { [key: string]: string } | null = null;
	if (account.model_fallbacks) {
		try {
			modelFallbacks = JSON.parse(account.model_fallbacks);
		} catch {
			modelFallbacks = null;
		}
	}

	return {
		id: account.id,
		name: account.name,
		provider: account.provider,
		requestCount: account.request_count,
		totalRequests: account.total_requests,
		lastUsed: account.last_used
			? new Date(account.last_used).toISOString()
			: null,
		created: new Date(account.created_at).toISOString(),
		paused: account.paused,
		tokenStatus,
		tokenExpiresAt: account.expires_at
			? new Date(account.expires_at).toISOString()
			: null,
		rateLimitStatus,
		rateLimitReset: account.rate_limit_reset
			? new Date(account.rate_limit_reset).toISOString()
			: null,
		rateLimitRemaining: account.rate_limit_remaining,
		rateLimitedUntil: account.rate_limited_until || null,
		sessionInfo,
		priority: account.priority,
		autoFallbackEnabled: account.auto_fallback_enabled,
		autoRefreshEnabled: account.auto_refresh_enabled,
		customEndpoint: account.custom_endpoint,
		modelMappings,
		usageUtilization: null, // Will be filled in by API handler from cache
		usageWindow: null, // Will be filled in by API handler from cache
		usageData: null, // Will be filled in by API handler from cache
		hasRefreshToken: !!account.refresh_token, // OAuth accounts have refresh tokens
		modelFallbacks,
	};
}

export function toAccountDisplay(account: Account): AccountDisplay {
	const tokenStatus = account.access_token ? "valid" : "expired";
	const isRateLimited =
		account.rate_limited_until && account.rate_limited_until > Date.now();
	const rateLimitStatus =
		isRateLimited && account.rate_limited_until
			? `Rate limited until ${new Date(account.rate_limited_until).toLocaleString()}`
			: "OK";

	const sessionInfo = account.session_start
		? `Session: ${account.session_request_count} requests`
		: "No active session";

	return {
		id: account.id,
		name: account.name,
		provider: account.provider,
		created: new Date(account.created_at),
		lastUsed: account.last_used ? new Date(account.last_used) : null,
		requestCount: account.request_count,
		totalRequests: account.total_requests,
		tokenStatus,
		rateLimitStatus,
		sessionInfo,
		paused: account.paused,
		rate_limited_until: account.rate_limited_until,
		session_start: account.session_start,
		session_request_count: account.session_request_count,
		access_token: account.access_token,
		priority: account.priority,
		autoFallbackEnabled: account.auto_fallback_enabled,
		autoRefreshEnabled: account.auto_refresh_enabled,
	};
}
