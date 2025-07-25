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
	account_tier: number; // 1, 5, or 20
}

export interface RequestMeta {
	id: string;
	method: string;
	path: string;
	timestamp: number;
}

export interface LoadBalancingStrategy {
	/**
	 * Return a filtered & ordered list of candidate accounts.
	 * Accounts that are rate-limited should be filtered out.
	 * The first account in the list should be tried first.
	 */
	select(accounts: Account[], meta: RequestMeta): Account[];
}

// Central strategy list
export const STRATEGIES = [
	"least-requests",
	"round-robin",
	"session",
	"weighted",
	"weighted-round-robin",
] as const;

export type StrategyName = (typeof STRATEGIES)[number];

export function isValidStrategy(strategy: string): strategy is StrategyName {
	return STRATEGIES.includes(strategy as StrategyName);
}
