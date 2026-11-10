/**
 * Provider peak-hours windows and the per-account pause decision built on
 * them.
 *
 * Kept in its own module, free of scheduler dependencies, because the peak
 * state is read from three places: the scheduler's auto-pause, the
 * /api/accounts listing, and the per-request summary (REST and live SSE) that
 * the dashboard badges. Importing it from auto-refresh-scheduler would drag
 * the whole scheduler into the usage collector's import graph.
 */
import { isChinesePublicHoliday } from "./chinese-holidays";

export function isZaiPeakHour(ts = Date.now()): boolean {
	const d = new Date(ts);
	const sgtDayMs = d.getTime() + 8 * 60 * 60 * 1000;
	const sgtDay = new Date(sgtDayMs).getUTCDay();
	if (sgtDay === 0 || sgtDay === 6) return false;
	const sgtHour = (d.getUTCHours() + d.getUTCMinutes() / 60 + 8) % 24;
	return sgtHour >= 14 && sgtHour < 18;
}

/**
 * DeepSeek peak hours: 01:00-04:00 and 06:00-10:00 UTC, Monday-Friday,
 * excluding Chinese public holidays. Both windows fall on the same UTC and
 * Beijing calendar day (09:00-12:00 / 14:00-18:00 CST), so the UTC date is
 * used for the weekday and holiday checks.
 */
export function isDeepseekPeakHour(ts = Date.now()): boolean {
	const d = new Date(ts);
	const day = d.getUTCDay();
	if (day === 0 || day === 6) return false;
	const date = d.toISOString().slice(0, 10);
	if (isChinesePublicHoliday(date)) return false;
	const utcHour = d.getUTCHours() + d.getUTCMinutes() / 60;
	return (utcHour >= 1 && utcHour < 4) || (utcHour >= 6 && utcHour < 10);
}

/**
 * Anthropic OAuth peak hours: weekdays 5am-11am PT (13:00-19:00 UTC). During
 * these windows 5-hour sessions consume a larger share of the weekly budget.
 * Informational only: not part of the peak-hours auto-pause.
 * Keep in sync with the dashboard copy in
 * packages/dashboard-web/src/utils/provider-utils.ts (used by RequestsTab for
 * historical request timestamps).
 */
export function isAnthropicPeakHour(ts = Date.now()): boolean {
	const d = new Date(ts);
	const day = d.getUTCDay();
	if (day === 0 || day === 6) return false;
	const utcHour = d.getUTCHours() + d.getUTCMinutes() / 60;
	return utcHour >= 13 && utcHour < 19;
}

/** Providers whose accounts support opt-in peak-hours auto-pause. */
export const PEAK_HOUR_CHECKS: Record<string, (ts?: number) => boolean> = {
	zai: isZaiPeakHour,
	deepseek: isDeepseekPeakHour,
};

/**
 * Server-side peak-hours state for an account's provider, served on
 * /api/accounts and on every request summary so the dashboard never
 * recomputes it. Uses the same check functions as the scheduler's
 * peak-hours auto-pause. `null` for providers without a peak concept.
 */
export function getPeakHoursState(
	provider: string | null | undefined,
	ts = Date.now(),
): { active: boolean } | null {
	// Own-property lookup: "__proto__"/"constructor" must not hit inherited props
	const key = provider ?? "";
	const check =
		key === "anthropic"
			? isAnthropicPeakHour
			: Object.hasOwn(PEAK_HOUR_CHECKS, key)
				? PEAK_HOUR_CHECKS[key]
				: undefined;
	return check ? { active: check(ts) } : null;
}
