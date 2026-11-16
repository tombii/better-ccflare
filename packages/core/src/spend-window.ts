/**
 * Window boundary maths for per-API-key spend limits.
 *
 * Every bound here is an absolute epoch-ms number computed in JavaScript and
 * handed to SQL as a parameter (`timestamp > ?`). Nothing in this repo uses a
 * SQL date/time function and this feature does not start: SQLite and
 * PostgreSQL disagree on every one of them, and the counter that consumes
 * these bounds has to produce the same answer on both.
 *
 * On reuse: `computeWindowStartMs` (throttle-utils.ts) was checked first and
 * is reused for `calendar_month`, where it is an exact fit — given the start
 * of next month as the reset, its "monthly" branch subtracts the PRECEDING
 * month's real duration, which is what makes February and a year end come out
 * right without a calendar table. It does not fit the two rolling windows:
 * it is anchored on a window's reset time and looks backwards, while a
 * rolling window is anchored on *now* and has no reset at all, and it has no
 * 30-day entry. Those two get explicit durations below rather than a
 * name-coupled call into its "seven_day" entry.
 */

import type { ApiKeySpendWindow } from "@better-ccflare/types";
import { computeWindowStartMs } from "./throttle-utils";

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Trailing duration of each ROLLING spend window. `calendar_month` is absent
 * on purpose — its length is not a constant.
 */
export const ROLLING_SPEND_WINDOW_DURATION_MS: Record<string, number> = {
	rolling_7d: 7 * DAY_MS,
	rolling_30d: 30 * DAY_MS,
};

/**
 * Epoch ms of the start of the calendar month containing `nowMs`, in UTC.
 *
 * UTC, not local time, because the `requests.timestamp` bounds it is compared
 * against are epoch ms and the process may be restarted in a different TZ
 * than the one a limit was set in; a window whose boundary moved with the
 * server's timezone would silently re-open a month that had already closed.
 */
export function calendarMonthStartMs(nowMs: number): number {
	const now = new Date(nowMs);
	return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 0, 0);
}

/**
 * Epoch ms of the start of the month AFTER the one containing `nowMs`.
 *
 * `Date.UTC(y, 12, 1)` rolls into January of `y + 1` by definition, so a
 * December window needs no special case.
 */
export function calendarMonthEndMs(nowMs: number): number {
	const now = new Date(nowMs);
	return Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1, 0, 0, 0, 0);
}

/**
 * Lower bound of a spend window: rows with `timestamp > startMs` are counted.
 *
 * Exclusive `>` rather than `>=` to match every other range query in this
 * repo. At millisecond resolution the difference can only ever be a request
 * landing exactly on a month boundary.
 */
export function computeSpendWindowStartMs(
	window: ApiKeySpendWindow,
	nowMs: number,
): number {
	if (window === "calendar_month") {
		// Reuse, not reimplementation: hand computeWindowStartMs the reset and
		// let its "monthly" branch subtract the preceding month's real length.
		return (
			computeWindowStartMs(calendarMonthEndMs(nowMs), "monthly") ??
			calendarMonthStartMs(nowMs)
		);
	}
	const duration = ROLLING_SPEND_WINDOW_DURATION_MS[window];
	// An unknown window cannot be silently treated as "all time" — that would
	// read every request ever made as in-window and refuse a key forever.
	// parseSpendWindow already normalises unknown values to rolling_30d, so
	// this is a belt-and-braces fallback, not a reachable path.
	return nowMs - (duration ?? ROLLING_SPEND_WINDOW_DURATION_MS.rolling_30d);
}

/**
 * When this window's counted spend next FALLS — the value that becomes
 * `resets_at` in a refusal and the countdown under the dashboard gauge.
 *
 * For `calendar_month` this is a true reset: the whole total drops to zero at
 * the start of next month, and `oldestSpendMs` is irrelevant.
 *
 * For a rolling window there is no reset. Spend decays continuously as
 * individual requests age out of the trailing window, so the honest answer to
 * "when does this get better?" is "when the oldest counted request ages out"
 * — `oldestSpendMs + duration`. The counter reads that MIN(timestamp) on the
 * same rollup query it already runs, so this costs nothing extra.
 *
 * Returns null when a rolling window's oldest request is unknown (nothing has
 * been counted yet, or the counter has not synced). Callers must treat null
 * as "unknown", never as "now" or "never".
 */
export function computeSpendWindowResetMs(
	window: ApiKeySpendWindow,
	nowMs: number,
	oldestSpendMs: number | null,
): number | null {
	if (window === "calendar_month") return calendarMonthEndMs(nowMs);
	if (oldestSpendMs == null || !Number.isFinite(oldestSpendMs)) return null;
	const duration =
		ROLLING_SPEND_WINDOW_DURATION_MS[window] ??
		ROLLING_SPEND_WINDOW_DURATION_MS.rolling_30d;
	return oldestSpendMs + duration;
}

/**
 * A stable identity for the window INSTANCE currently in force.
 *
 * The counter holds one cached total per key and must throw it away when the
 * window it was measured over is no longer the window in force. For
 * `calendar_month` that happens abruptly at midnight UTC on the 1st, so the
 * key carries the year and month. A rolling window has no instances — it
 * slides — so its key is constant and the cached total is instead kept honest
 * by the periodic resync.
 */
export function spendWindowInstanceKey(
	window: ApiKeySpendWindow,
	nowMs: number,
): string {
	if (window !== "calendar_month") return window;
	const now = new Date(nowMs);
	return `calendar_month:${now.getUTCFullYear()}-${now.getUTCMonth() + 1}`;
}
