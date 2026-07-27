import { type Account, StrategyName } from "@better-ccflare/types";

// Array of all strategies for backwards compatibility
export const STRATEGIES = Object.values(StrategyName);

export function isValidStrategy(strategy: string): strategy is StrategyName {
	return Object.values(StrategyName).includes(strategy as StrategyName);
}

// Default load balancing strategy
export const DEFAULT_STRATEGY = StrategyName.Session;

/**
 * Optional usage snapshot fed into {@link isAccountAvailable}. Passed through
 * by callers that already have a `usageCache.get(account.id)` payload handy;
 * when omitted the predicate falls back to the cheap "not paused / not rate
 * limited / not requires_reauth" check used at every other call site.
 */
export interface AccountUsageSnapshot {
	/** Representative utilization in percent (0-100); null means unknown. */
	utilization: number | null;
	/**
	 * Reset time (ms epoch) of the representative usage window, if known.
	 * A known reset in the past means the snapshot predates the window
	 * reset and must NOT count as exhausted (PR #299 review finding).
	 */
	resetMs: number | null;
}

/**
 * Shared exhaustion predicate for both the rateLimitStatus display and the
 * /health `usage_exhausted` counter — keeping the two surfaces from
 * contradicting each other. A known reset in the past means the snapshot
 * predates the window reset: do not claim exhaustion from stale data. An
 * unknown reset trusts the (max 10-minute-old) usage cache.
 *
 * Lives in `@better-ccflare/core` so the dependency runs the right way
 * (http-api -> core, not the reverse). Kept byte-identical with the
 * previous in-http-api definition so existing display logic is unaffected.
 */
export function isUsageExhausted(
	utilization: number | null,
	resetMs: number | null | undefined,
	now: number,
): boolean {
	return (
		utilization !== null &&
		utilization >= 100 &&
		(resetMs == null || resetMs > now)
	);
}

// Helper to check if an account is available (not rate-limited, paused, or
// usage-capped). Callers without usage telemetry can omit the third arg and
// get the original cheap predicate; callers with a usage snapshot pass it so
// an account whose representative window is at 100% with a future reset is
// skipped instead of being cycled through until it 429s.
export function isAccountAvailable(
	account: Account,
	now: number = Date.now(),
	usage?: AccountUsageSnapshot,
): boolean {
	if (
		account.requires_reauth ||
		account.paused ||
		(account.rate_limited_until && account.rate_limited_until >= now)
	) {
		return false;
	}
	if (usage && isUsageExhausted(usage.utilization, usage.resetMs, now)) {
		return false;
	}
	return true;
}

// Re-export from types package for backwards compatibility
export { StrategyName } from "@better-ccflare/types";
