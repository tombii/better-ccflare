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

import type {
	AlibabaCodingPlanUsageData,
	AnyUsageData,
	KiloUsageData,
	NanoGPTUsageData,
	UsageData,
	XaiUsageData,
	ZaiUsageData,
} from "@better-ccflare/providers";
import {
	getRepresentativeAlibabaCodingPlanWindow,
	getRepresentativeKiloWindow,
	getRepresentativeNanoGPTWindow,
	getRepresentativeWindow,
	getRepresentativeXaiWindow,
} from "@better-ccflare/providers";

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
 * Reset time (ms epoch) of the representative usage window, derived the same
 * way for every provider — the single source BOTH the /health usage_exhausted
 * counter and the accounts rateLimitStatus display use, so their staleness
 * guards cannot diverge (PR #299 review finding). Note zai: the display
 * window is labeled "five_hour" (Claude terminology), but the payload key
 * carrying the reset is `tokens_limit` — extraction must use the payload key,
 * not the display label.
 */
export function getRepresentativeUsageResetMs(
	usageData: unknown,
	provider: string,
): number | null {
	if (!usageData || typeof usageData !== "object") return null;
	try {
		const data = usageData as AnyUsageData;
		switch (provider) {
			case "anthropic":
			case "codex": {
				const windowName = getRepresentativeWindow(data as UsageData);
				// Flat legacy shape: the window name is an actual property
				// (five_hour/seven_day/...) carrying its own resets_at.
				const flatReset = extractUsageResetMs(data, windowName);
				if (flatReset !== null) return flatReset;
				// limits[]-only payloads (2026 API): five_hour/seven_day are
				// absent as properties — getRepresentativeWindow derives those
				// same names synthetically from limits[] kind "session" /
				// "weekly_all". Fall back to the matching limits[] entry's own
				// resets_at so the staleness guard still has a real reset time.
				return getRepresentativeLimitResetMs(data as UsageData, windowName);
			}
			case "zai":
				return extractUsageResetMs(
					data,
					(data as ZaiUsageData).tokens_limit ? "tokens_limit" : null,
				);
			case "nanogpt":
				return extractUsageResetMs(
					data,
					getRepresentativeNanoGPTWindow(data as NanoGPTUsageData),
				);
			case "kilo":
				return extractUsageResetMs(
					data,
					getRepresentativeKiloWindow(data as KiloUsageData),
				);
			case "alibaba-coding-plan":
				return extractUsageResetMs(
					data,
					getRepresentativeAlibabaCodingPlanWindow(
						data as AlibabaCodingPlanUsageData,
					),
				);
			case "xai":
				return extractUsageResetMs(
					data,
					getRepresentativeXaiWindow(data as XaiUsageData),
				);
			default:
				return null;
		}
	} catch {
		return null;
	}
}

/**
 * limits[] `kind` that maps to each synthetic window name produced by
 * getRepresentativeWindow's accountLevelLimitWindows fold (session ->
 * five_hour, weekly_all -> seven_day). Kept in lockstep with that mapping in
 * packages/providers/src/usage-fetcher.ts.
 */
const WINDOW_NAME_TO_LIMIT_KIND: Record<string, string> = {
	five_hour: "session",
	seven_day: "weekly_all",
};

/**
 * Reset time (ms epoch) for a limits[]-only Anthropic/Codex payload: finds
 * the limits[] entry whose `kind` corresponds to the given synthetic window
 * name and returns its own `resets_at`.
 */
function getRepresentativeLimitResetMs(
	usage: UsageData,
	windowName: string | null,
): number | null {
	if (!windowName || !Array.isArray(usage.limits)) return null;
	const kind = WINDOW_NAME_TO_LIMIT_KIND[windowName];
	if (!kind) return null;
	const limit = usage.limits.find((l) => l?.kind === kind);
	const resetsAt = limit?.resets_at;
	if (typeof resetsAt !== "string") return null;
	const ms = new Date(resetsAt).getTime();
	return Number.isFinite(ms) ? ms : null;
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
