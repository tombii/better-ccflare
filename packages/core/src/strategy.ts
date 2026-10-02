import { type Account, StrategyName } from "@better-ccflare/types";

// Array of all strategies for backwards compatibility
export const STRATEGIES = Object.values(StrategyName);

export function isValidStrategy(strategy: string): strategy is StrategyName {
	return Object.values(StrategyName).includes(strategy as StrategyName);
}

// Default load balancing strategy
export const DEFAULT_STRATEGY = StrategyName.Session;

/**
 * A representative usage-window snapshot for an account: `utilization` as a
 * 0-100+ percentage and `resetMs` as the epoch ms the window resets (or null
 * when unknown). Kept minimal/provider-agnostic so callers outside the
 * providers package (e.g. account selection) can pass it through without
 * depending on provider-specific usage payload shapes.
 */
export interface AccountUsageSnapshot {
	utilization: number;
	resetMs: number | null;
	/**
	 * True when the provider reports billed capacity beyond the plan window
	 * (Codex credits, Anthropic extra usage) AND the operator has allowed
	 * spending it — see extra-usage.ts. A spent window is then not a reason to
	 * leave the account out. Absent means no.
	 */
	extraUsageAvailable?: boolean;
}

/**
 * Shared exhaustion predicate for the rateLimitStatus display, the /health
 * `usage_exhausted` counter, and account selection — keeping all three
 * surfaces from contradicting each other. A known reset in the past means
 * the snapshot predates the window reset: do not claim exhaustion from stale
 * data. An unknown reset trusts the (max 10-minute-old) usage cache.
 *
 * `extraUsageAvailable` (from the snapshot) means the provider will keep
 * serving past the spent window on billed extra usage and the operator has
 * allowed it, so the window no longer makes the account unusable. Callers that
 * hold a snapshot pass its field through; omitting it keeps the plain window
 * check, which is what code deciding whether to *probe* an account wants.
 */
export function isUsageExhausted(
	utilization: number | null,
	resetMs: number | null | undefined,
	now: number,
	extraUsageAvailable = false,
): boolean {
	return (
		!extraUsageAvailable &&
		utilization !== null &&
		utilization >= 100 &&
		(resetMs == null || resetMs > now)
	);
}

// Helper to check if an account is available (not rate-limited or paused).
// `usage`, when provided, additionally excludes accounts whose usage window
// is fully exhausted per `isUsageExhausted` — callers that don't have usage
// telemetry (or don't want the extra check) can omit it entirely.
export function isAccountAvailable(
	account: Account,
	now = Date.now(),
	usage?: AccountUsageSnapshot,
): boolean {
	if (
		usage &&
		isUsageExhausted(
			usage.utilization,
			usage.resetMs,
			now,
			usage.extraUsageAvailable,
		)
	) {
		return false;
	}
	return (
		!account.requires_reauth &&
		!account.paused &&
		(!account.rate_limited_until || account.rate_limited_until < now)
	);
}

// Re-export from types package for backwards compatibility
export { StrategyName } from "@better-ccflare/types";
