import { type Account, StrategyName } from "@better-ccflare/types";

// Local fallback to avoid import issues during testing
const LOCAL_STRATEGIES = {
	Session: "session" as const,
};

// Use imported StrategyName if available, otherwise use local fallback
const SafeStrategyName = StrategyName || LOCAL_STRATEGIES;

// Array of all strategies for backwards compatibility
export const STRATEGIES = Object.values(SafeStrategyName);

export function isValidStrategy(strategy: string): strategy is StrategyName {
	return Object.values(SafeStrategyName).includes(
		strategy as keyof typeof SafeStrategyName,
	);
}

// Default load balancing strategy
export const DEFAULT_STRATEGY = SafeStrategyName.Session;

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

// Re-export from types package for backwards compatibility
export { StrategyName } from "@better-ccflare/types";
