/**
 * Utility functions for provider-specific logic in the web UI
 */
import {
	getDefaultEndpoint,
	isKnownProvider,
	PROVIDER_NAMES,
	requiresSessionDurationTracking,
} from "@better-ccflare/types";

/**
 * Check if a provider supports auto-fallback and auto-refresh features
 * Currently only Anthropic OAuth accounts support these features
 */
export function providerSupportsAutoFeatures(provider: string): boolean {
	return (
		provider === PROVIDER_NAMES.ANTHROPIC ||
		provider === PROVIDER_NAMES.CODEX ||
		provider === PROVIDER_NAMES.ZAI
	);
}

/**
 * Providers whose upstream answers by the SAME model ids the client asks for.
 *
 * This is the one and only definition of the passthrough rule. An empty model
 * field means "forward whatever model the client sent, untouched" — which is
 * only meaningful when the upstream natively accepts Claude model ids, i.e.
 * Anthropic OAuth accounts and Claude Console API accounts.
 *
 * On every other provider the Claude id sent by the client lands on a foreign
 * catalog and gets coerced by an embedded default map. That is the exact path
 * that produced `400 The 'gpt-5.3-codex' model is not supported...` on a codex
 * account. So outside this list, choosing a model is mandatory.
 *
 * Never compare `provider === "anthropic"` at a call site: use the helper
 * below, so the criterion stays in a single place.
 */
export const PASSTHROUGH_PROVIDERS: readonly string[] = [
	PROVIDER_NAMES.ANTHROPIC,
	PROVIDER_NAMES.CLAUDE_CONSOLE_API,
];

/**
 * True when the model field may be left empty (passthrough) for this provider.
 *
 * An absent/unknown provider (no account picked yet) is NOT passthrough: we
 * cannot promise a behaviour we do not know the upstream supports.
 */
export function providerAllowsClientModelPassthrough(
	provider?: string | null,
): boolean {
	return PASSTHROUGH_PROVIDERS.includes((provider ?? "").trim());
}

/**
 * Check if a provider supports custom billing type configuration
 * (anthropic-compatible and openai-compatible providers)
 */
export function providerSupportsCustomBilling(provider: string): boolean {
	return (
		provider === PROVIDER_NAMES.ANTHROPIC_COMPATIBLE ||
		provider === PROVIDER_NAMES.OPENAI_COMPATIBLE
	);
}

/**
 * Check if a provider shows quota-window usage information on the account page.
 * Anthropic and Codex show 5-hour and 7-day windows, NanoGPT shows daily/monthly,
 * and Zai exposes time/token quota windows.
 */
/**
 * Check if a provider uses session-based usage windows (e.g. Anthropic 5h, Codex 5h).
 * Only these providers should show the session token breakdown on account cards.
 */
export function providerHasSessionWindow(provider: string): boolean {
	return requiresSessionDurationTracking(provider);
}

export function providerShowsWeeklyUsage(provider: string): boolean {
	return (
		provider === PROVIDER_NAMES.ANTHROPIC ||
		provider === PROVIDER_NAMES.CODEX ||
		provider === PROVIDER_NAMES.NANOGPT ||
		provider === PROVIDER_NAMES.ZAI ||
		provider === PROVIDER_NAMES.XAI ||
		// Alibaba Coding Plan emits its own five_hour/weekly/monthly shape
		// (see AlibabaCodingPlanUsageData + alibaba-coding-plan-usage-fetcher).
		// Without this entry the isAlibabaData branch in RateLimitProgress and
		// the pool-usage eligibility set both silently never render.
		provider === PROVIDER_NAMES.ALIBABA_CODING_PLAN ||
		// MiniMax Token Plan normalizes its native weekly window to the
		// canonical `seven_day` key (see minimax-usage-fetcher.ts). Without
		// this entry AccountListItem passes showWeekly=false and both 5h
		// and 7d windows collapse to a single fallback bar — the bug
		// fixed in this branch.
		provider === PROVIDER_NAMES.MINIMAX
	);
}

/**
 * Check if a provider shows a credit balance (USD remaining) instead of utilization windows
 */
export function providerShowsCreditsBalance(provider: string): boolean {
	return provider === PROVIDER_NAMES.KILO;
}

/**
 * Check if a provider supports custom endpoints
 */
export function providerSupportsCustomEndpoints(provider: string): boolean {
	// Most providers support custom endpoints, but we can add specific logic if needed
	return isKnownProvider(provider);
}

/**
 * Get the default endpoint for a provider
 */
export function getDefaultEndpointForProvider(provider: string): string {
	return getDefaultEndpoint(provider);
}

/**
 * Check if a given timestamp (default: now) falls within Zai peak hours.
 * Zai peak hours are weekdays 14:00–18:00 Singapore time (UTC+8), Monday–Friday.
 */
export function isZaiPeakHour(ts?: number): boolean {
	const d = new Date(ts ?? Date.now());
	const sgtDayMs = d.getTime() + 8 * 60 * 60 * 1000;
	const sgtDay = new Date(sgtDayMs).getUTCDay();
	if (sgtDay === 0 || sgtDay === 6) return false;
	// Convert to UTC+8 hour
	const utcHour = d.getUTCHours() + d.getUTCMinutes() / 60;
	const sgtHour = (utcHour + 8) % 24;
	return sgtHour >= 14 && sgtHour < 18;
}

/**
 * Check if a given timestamp (default: now) falls within Anthropic OAuth peak hours.
 * Peak hours are weekdays 5am–11am PT (1pm–7pm UTC), Monday–Friday.
 * During these windows, 5-hour sessions consume a larger share of the weekly budget.
 */
export function isAnthropicPeakHour(ts?: number): boolean {
	const d = new Date(ts ?? Date.now());
	const day = d.getUTCDay();
	// Weekdays only (Mon=1 through Fri=5)
	if (day === 0 || day === 6) return false;
	const utcHour = d.getUTCHours() + d.getUTCMinutes() / 60;
	return utcHour >= 13 && utcHour < 19;
}

/** Chinese public holidays (Beijing dates) used as a fallback until/unless the feed loads. */
const EMBEDDED_CN_HOLIDAYS: ReadonlyArray<readonly [string, string]> = [
	["2026-01-01", "2026-01-03"],
	["2026-02-15", "2026-02-23"],
	["2026-04-04", "2026-04-06"],
	["2026-05-01", "2026-05-05"],
	["2026-06-19", "2026-06-21"],
	["2026-09-25", "2026-09-27"],
	["2026-10-01", "2026-10-07"],
];
const CN_HOLIDAY_FEED =
	"https://raw.githubusercontent.com/NateScarlet/holiday-cn/master";
const cnHolidayFeedByYear = new Map<number, Set<string>>();
const cnHolidayFeedRequested = new Set<number>();

/**
 * Best-effort fetch of the yearly Chinese holiday feed (same source the proxy
 * uses). Safe to call repeatedly; each year is requested once per page load.
 */
export async function loadChineseHolidays(
	years: number[] = [
		new Date().getUTCFullYear(),
		new Date().getUTCFullYear() + 1,
	],
): Promise<void> {
	for (const year of years) {
		if (cnHolidayFeedRequested.has(year)) continue;
		cnHolidayFeedRequested.add(year);
		try {
			const res = await fetch(`${CN_HOLIDAY_FEED}/${year}.json`);
			if (!res.ok) continue;
			const body = (await res.json()) as {
				days?: Array<{ date?: string; isOffDay?: boolean }>;
			};
			if (!Array.isArray(body.days)) continue;
			cnHolidayFeedByYear.set(
				year,
				new Set(
					body.days
						.filter((d) => d.isOffDay === true && typeof d.date === "string")
						.map((d) => d.date as string),
				),
			);
		} catch {
			// Offline or blocked — embedded table / weekday rule still applies.
		}
	}
}

function isChineseHoliday(date: string): boolean {
	const feed = cnHolidayFeedByYear.get(Number(date.slice(0, 4)));
	if (feed) return feed.has(date);
	return EMBEDDED_CN_HOLIDAYS.some(([from, to]) => date >= from && date <= to);
}

/**
 * Check if a given timestamp (default: now) falls within DeepSeek peak hours.
 * Peak hours are 01:00–04:00 and 06:00–10:00 UTC, Monday–Friday, excluding
 * Chinese public holidays.
 */
export function isDeepseekPeakHour(ts?: number): boolean {
	const d = new Date(ts ?? Date.now());
	const day = d.getUTCDay();
	if (day === 0 || day === 6) return false;
	if (isChineseHoliday(d.toISOString().slice(0, 10))) return false;
	const utcHour = d.getUTCHours() + d.getUTCMinutes() / 60;
	return (utcHour >= 1 && utcHour < 4) || (utcHour >= 6 && utcHour < 10);
}
