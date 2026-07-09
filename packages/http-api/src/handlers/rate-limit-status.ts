/**
 * Display-string computation for an account's rate-limit state.
 *
 * Extracted from the accounts list handler so the precedence rules are
 * testable in isolation. Precedence (highest first):
 *
 *   1. usage exhaustion — the representative usage window is at 100% and its
 *      reset (when known) lies in the future. This outranks unified-header
 *      snapshots because those go stale on idle accounts: during the
 *      2026-07-09 incident an account at 100% weekly utilization kept showing
 *      "OK" (no snapshot stored) while every upstream request 429'd.
 *   2. the last unified rate-limit header snapshot (`rate_limit_status`),
 *      with minutes until `rate_limit_reset` when that is in the future.
 *   3. the legacy cooldown lock (`rate_limited_until`).
 *   4. "OK".
 */

export interface RateLimitStatusInput {
	/** Last `anthropic-ratelimit-unified-status` snapshot, if any. */
	rate_limit_status: string | null;
	/** Reset time (ms epoch) accompanying the unified snapshot. */
	rate_limit_reset: number | null;
	/** Local cooldown lock (ms epoch), set by 429-driven backoff. */
	rate_limited_until: number | null;
	/** Representative usage-window utilization in percent (0-100), or null. */
	usageUtilization: number | null;
	/** Reset time (ms epoch) of the representative usage window, if known. */
	usageResetMs?: number | null;
}

function minutesLeft(untilMs: number, now: number): number {
	return Math.ceil((untilMs - now) / 60000);
}

/**
 * Shared exhaustion predicate for BOTH the rateLimitStatus display and the
 * /health `usage_exhausted` counter — keeping the two surfaces from
 * contradicting each other. A known reset in the past means the snapshot
 * predates the window reset: do not claim exhaustion from stale data. An
 * unknown reset trusts the (max 10-minute-old) usage cache.
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

export function computeRateLimitStatusDisplay(
	input: RateLimitStatusInput,
	now: number,
): string {
	const { usageUtilization, usageResetMs } = input;

	if (isUsageExhausted(usageUtilization, usageResetMs, now)) {
		if (usageResetMs != null && usageResetMs > now) {
			return `usage_exhausted (${minutesLeft(usageResetMs, now)}m)`;
		}
		return "usage_exhausted";
	}

	if (input.rate_limit_status) {
		if (input.rate_limit_reset && input.rate_limit_reset > now) {
			return `${input.rate_limit_status} (${minutesLeft(input.rate_limit_reset, now)}m)`;
		}
		return input.rate_limit_status;
	}

	if (input.rate_limited_until && input.rate_limited_until > now) {
		return `Rate limited (${minutesLeft(input.rate_limited_until, now)}m)`;
	}

	return "OK";
}

/**
 * Pull the reset timestamp (ms epoch) of a named usage window out of raw
 * provider usage data. Handles both timestamp shapes in use:
 * anthropic-style `resets_at` (ISO string) and zai/nanogpt-style `resetAt`
 * (ms number).
 */
export function extractUsageResetMs(
	usageData: unknown,
	windowName: string | null,
): number | null {
	if (!usageData || typeof usageData !== "object" || !windowName) return null;
	const window = (usageData as Record<string, unknown>)[windowName];
	if (!window || typeof window !== "object") return null;
	const w = window as { resets_at?: unknown; resetAt?: unknown };
	if (typeof w.resets_at === "string") {
		const ms = new Date(w.resets_at).getTime();
		return Number.isFinite(ms) ? ms : null;
	}
	if (typeof w.resetAt === "number" && Number.isFinite(w.resetAt)) {
		return w.resetAt;
	}
	return null;
}
