/**
 * Shared throttle calculation utilities for usage window calculations.
 * Used by both proxy (server) and dashboard (client).
 */

export type SupportedWindow =
	| "five_hour"
	| "seven_day"
	| "seven_day_opus"
	| "seven_day_sonnet"
	| "weekly"
	| "daily"
	| "monthly"
	| "tokens_limit";

/**
 * Fixed window durations in milliseconds.
 * Note: monthly windows have variable duration (28-31 days) and are handled separately.
 */
export const FIXED_WINDOW_DURATION_MS: Record<string, number> = {
	five_hour: 5 * 60 * 60 * 1000,
	seven_day: 7 * 24 * 60 * 60 * 1000,
	seven_day_opus: 7 * 24 * 60 * 60 * 1000,
	seven_day_sonnet: 7 * 24 * 60 * 60 * 1000,
	weekly: 7 * 24 * 60 * 60 * 1000,
	daily: 24 * 60 * 60 * 1000,
	// time_limit intentionally omitted — ZAI's TIME_LIMIT window duration is unknown
	tokens_limit: 5 * 60 * 60 * 1000,
};

/**
 * Calculate the start time of a usage window given its reset time and window type.
 *
 * For monthly windows: uses preceding month's duration to handle 28/29/30/31 day variations.
 * For fixed windows: uses FIXED_WINDOW_DURATION_MS lookup.
 *
 * @param resetMs - Reset timestamp in milliseconds
 * @param window - Window type (e.g., "five_hour", "seven_day", "monthly")
 * @returns Window start timestamp in milliseconds, or null if invalid
 */
export function computeWindowStartMs(
	resetMs: number,
	window: SupportedWindow | string,
): number | null {
	if (!Number.isFinite(resetMs)) return null;

	if (window === "monthly") {
		const resetDate = new Date(resetMs);
		// Calculate preceding month's duration (handles 28/29/30/31 days)
		const monthStart = Date.UTC(
			resetDate.getUTCFullYear(),
			resetDate.getUTCMonth(),
			1,
			0,
			0,
			0,
			0,
		);
		const prevMonthStart = Date.UTC(
			resetDate.getUTCFullYear(),
			resetDate.getUTCMonth() - 1,
			1,
			0,
			0,
			0,
			0,
		);
		const actualMonthDurationMs = monthStart - prevMonthStart;
		return resetMs - actualMonthDurationMs;
	}

	const durationMs = FIXED_WINDOW_DURATION_MS[window];
	return durationMs ? resetMs - durationMs : null;
}
