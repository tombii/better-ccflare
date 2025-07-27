import type { Account } from "./types";

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

// Default load balancing strategy
export const DEFAULT_STRATEGY: StrategyName = "session";

// Helper to check if an account is available (not rate-limited or paused)
export function isAccountAvailable(
	account: Account,
	now = Date.now(),
): boolean {
	return (
		!account.paused &&
		(!account.rate_limited_until || account.rate_limited_until < now)
	);
}
