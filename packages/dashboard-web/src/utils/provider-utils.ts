/**
 * Utility functions for provider-specific logic in the web UI
 */
import { providerSupportsProviderRouting } from "@better-ccflare/core";
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
 * True when the model field of this provider accepts the inference-provider
 * routing suffix (`model {"only":["deepseek"]}` -> body `provider` object).
 *
 * Separate from `providerAllowsClientModelPassthrough`: that one is about an
 * EMPTY field, this one about a provider routing object. The list of
 * providers lives in core, so the dashboard and the proxy cannot drift.
 */
export function providerSupportsInferenceProviderRouting(
	provider?: string | null,
): boolean {
	return providerSupportsProviderRouting(provider);
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
	return (
		provider === PROVIDER_NAMES.KILO || provider === PROVIDER_NAMES.OPENROUTER
	);
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
 * Per-provider description of what the night window actually requests, keyed
 * by the provider that registers a tier adapter on the server. Keep in sync
 * with the `registerTierAdapter` calls under packages/providers/src.
 */
const NIGHT_WINDOW_TIERS: Record<string, string> = {
	[PROVIDER_NAMES.SAILRESEARCH]: "balanced",
};

/**
 * Check if a provider offers a cheaper completion tier the night window can
 * request. Only these providers show the toggle.
 */
export function providerSupportsNightWindow(provider: string): boolean {
	return provider in NIGHT_WINDOW_TIERS;
}

/**
 * Tooltip for the night-window toggle: names the tier that will be requested.
 * The window itself is server-side (NIGHT_WINDOW / NIGHT_TZ), so it is
 * deliberately not restated here.
 */
export function nightWindowTitle(provider: string): string {
	const tier = NIGHT_WINDOW_TIERS[provider];
	const tierText = tier
		? `the cheaper "${tier}" completion tier`
		: "a cheaper completion tier";
	return `During the configured night window (server NIGHT_WINDOW / NIGHT_TZ), request ${tierText} from this account instead of the default. No header is sent outside the window.`;
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
 * Check if a given timestamp (default: now) falls within DeepSeek peak hours.
 * DeepSeek peak hours are 01:00–04:00 and 06:00–10:00 UTC, Monday–Friday,
 * excluding Chinese public holidays.
 *
 * Keep in sync with isDeepseekPeakHour in packages/proxy/src/peak-hours.ts.
 * This copy exists for RequestsTab's historical timestamps; live state comes
 * from the server (`peakHours` on /api/accounts and on each request summary).
 *
 * Known gap: the holiday calendar is server-side only, so a request on a
 * Chinese public holiday that falls on a weekday is shown as peak here. The
 * server-computed `summary.peakHours` is preferred wherever it is available.
 */
export function isDeepseekPeakHour(ts?: number): boolean {
	const d = new Date(ts ?? Date.now());
	const day = d.getUTCDay();
	if (day === 0 || day === 6) return false;
	const utcHour = d.getUTCHours() + d.getUTCMinutes() / 60;
	return (utcHour >= 1 && utcHour < 4) || (utcHour >= 6 && utcHour < 10);
}

/**
 * Check if a given timestamp (default: now) falls within Anthropic OAuth peak hours.
 * Peak hours are weekdays 5am–11am PT (1pm–7pm UTC), Monday–Friday.
 * During these windows, 5-hour sessions consume a larger share of the weekly budget.
 * Keep in sync with isAnthropicPeakHour in
 * packages/proxy/src/auto-refresh-scheduler.ts. This copy exists for
 * RequestsTab's historical timestamps; live state comes from /api/accounts.
 */
export function isAnthropicPeakHour(ts?: number): boolean {
	const d = new Date(ts ?? Date.now());
	const day = d.getUTCDay();
	// Weekdays only (Mon=1 through Fri=5)
	if (day === 0 || day === 6) return false;
	const utcHour = d.getUTCHours() + d.getUTCMinutes() / 60;
	return utcHour >= 13 && utcHour < 19;
}
