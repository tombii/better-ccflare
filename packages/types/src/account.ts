// Usage data types for Anthropic accounts
export interface UsageWindowData {
	utilization: number | null;
	resets_at: string | null;
}

export interface FullUsageData {
	five_hour?: UsageWindowData;
	seven_day?: UsageWindowData;
	seven_day_oauth_apps?: UsageWindowData;
	seven_day_opus?: UsageWindowData;
}

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
	paused?: 0 | 1;
	rate_limit_reset?: number | null;
	rate_limit_status?: string | null;
	rate_limit_remaining?: number | null;
	priority?: number;
	auto_fallback_enabled?: 0 | 1;
	auto_refresh_enabled?: 0 | 1;
	custom_endpoint?: string | null;
	model_mappings?: string | null; // JSON string for OpenAI-compatible providers
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
	sessionInfo: string;
	priority: number;
	autoFallbackEnabled: boolean;
	autoRefreshEnabled: boolean;
	customEndpoint: string | null;
	modelMappings: { [key: string]: string } | null; // Parsed model mappings for OpenAI-compatible providers
	usageUtilization: number | null; // Percentage utilization (0-100) from API
	usageWindow: string | null; // Most restrictive window (e.g., "five_hour")
	usageData: FullUsageData | null; // Full usage data for Anthropic accounts
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
		| "openai-compatible";
	priority: number;
	autoFallbackEnabled: boolean;
	autoRefreshEnabled: boolean;
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
		| "openai-compatible";
	priority?: number;
	customEndpoint?: string;
}

export interface AccountDeleteRequest {
	confirm: string;
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
		expires_at: row.expires_at,
		created_at: row.created_at,
		last_used: row.last_used,
		request_count: row.request_count,
		total_requests: row.total_requests,
		rate_limited_until: row.rate_limited_until || null,
		session_start: row.session_start || null,
		session_request_count: row.session_request_count || 0,
		paused: row.paused === 1,
		rate_limit_reset: row.rate_limit_reset || null,
		rate_limit_status: row.rate_limit_status || null,
		rate_limit_remaining: row.rate_limit_remaining || null,
		priority: row.priority || 0,
		auto_fallback_enabled: row.auto_fallback_enabled === 1,
		auto_refresh_enabled: row.auto_refresh_enabled === 1,
		custom_endpoint: row.custom_endpoint || null,
		model_mappings: row.model_mappings || null,
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

	// Parse model mappings for OpenAI-compatible providers
	let modelMappings: { [key: string]: string } | null = null;
	if (account.provider === "openai-compatible" && account.model_mappings) {
		try {
			const parsed = JSON.parse(account.model_mappings);
			modelMappings = parsed.modelMappings || null;
		} catch {
			// If parsing fails, ignore model mappings
			modelMappings = null;
		}
	} else if (
		account.provider === "openai-compatible" &&
		account.custom_endpoint
	) {
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
		sessionInfo,
		priority: account.priority,
		autoFallbackEnabled: account.auto_fallback_enabled,
		autoRefreshEnabled: account.auto_refresh_enabled,
		customEndpoint: account.custom_endpoint,
		modelMappings,
		usageUtilization: null, // Will be filled in by API handler from cache
		usageWindow: null, // Will be filled in by API handler from cache
		usageData: null, // Will be filled in by API handler from cache
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
