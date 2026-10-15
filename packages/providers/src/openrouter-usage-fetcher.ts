import { Logger } from "@better-ccflare/logger";
import type { OpenRouterUsageData } from "@better-ccflare/types";

export type { OpenRouterUsageData };

const log = new Logger("OpenRouterUsageFetcher");

const OPENROUTER_KEY_ENDPOINT = "https://openrouter.ai/api/v1/key";
const OPENROUTER_CREDITS_ENDPOINT = "https://openrouter.ai/api/v1/credits";

/**
 * Deadline for a usage request, covering both the response headers and the
 * body read. Mirrors the Codex and MiniMax fetchers: without it a stalled
 * upstream holds the in-flight polling slot for that account open, and
 * `UsageCache.fetchAndCache` keeps handing back that unfinished promise
 * instead of scheduling a new poll — the balance would freeze until the
 * account's polling is restarted.
 */
const OPENROUTER_USAGE_REQUEST_TIMEOUT_MS = 5000;

/**
 * GET an OpenRouter endpoint and return the parsed payload, or null on any
 * failure. Never throws — usage polling must not affect provider operation.
 */
async function fetchOpenRouterJson(
	url: string,
	apiKey: string,
): Promise<Record<string, unknown> | null> {
	const controller = new AbortController();
	const timeoutId = setTimeout(
		() => controller.abort(),
		OPENROUTER_USAGE_REQUEST_TIMEOUT_MS,
	);
	try {
		const response = await fetch(url, {
			method: "GET",
			headers: {
				Authorization: `Bearer ${apiKey}`,
				Accept: "application/json",
			},
			signal: controller.signal,
		});

		if (!response.ok) {
			const statusText = response.statusText;
			const responseHeaders = Object.fromEntries(response.headers.entries());
			const context = {
				status: response.status,
				statusText,
				url,
				headers: responseHeaders,
				timestamp: new Date().toISOString(),
			};
			try {
				const errorBody = await response.text();
				log.warn(
					`Failed to fetch OpenRouter usage data: ${response.status} ${statusText}`,
					{ ...context, errorBody },
				);
			} catch {
				log.warn(
					`Failed to fetch OpenRouter usage data: ${response.status} ${statusText}`,
					context,
				);
			}
			return null;
		}

		// Body read inherits the same abort signal: a stalled response with
		// headers flushed but no body would otherwise block indefinitely.
		const json = await response.json();
		return (json?.data ?? json) as Record<string, unknown>;
	} catch (error) {
		log.warn(`Error fetching OpenRouter usage data from ${url}:`, error);
		return null;
	} finally {
		clearTimeout(timeoutId);
	}
}

/** Coerce a JSON value to a finite number, or null when absent/not numeric. */
function toNumber(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * Usage spent within the key's CURRENT limit period.
 *
 * The API's `usage` field is lifetime, while `limit` resets on the interval
 * named by `limit_reset`. Pairing the two overstates depletion for any key
 * that has rolled over at least once — a renewed monthly key that has spent
 * $260 over its life against a $100 monthly cap would read as 260% and get
 * benched while it still has money on it. The API also exposes period-scoped
 * counters; prefer the one matching `limit_reset`.
 *
 * Returns null when the reset interval is absent or unrecognised, in which
 * case `limit` is a lifetime cap and the caller's lifetime `usage` is the
 * correct figure.
 */
function periodUsageForReset(
	data: Record<string, unknown>,
	resetInterval: string | null,
): number | null {
	switch (resetInterval) {
		case "daily":
			return toNumber(data.usage_daily);
		case "weekly":
			return toNumber(data.usage_weekly);
		case "monthly":
			return toNumber(data.usage_monthly);
		default:
			return null;
	}
}

/**
 * The budget entry describing the key's OWN limit, if the payload carries one.
 *
 * `budgets[]` / `effective_budget` describe guardrails, which are not always
 * the key's limit — a workspace may also cap a member on a different interval.
 * Only the `key_limit`-scoped entry lines up with `limit` / `limit_remaining`,
 * so only that one may supply a reset time for it.
 */
function keyLimitBudget(
	data: Record<string, unknown>,
): Record<string, unknown> | null {
	const candidates: unknown[] = [];
	const effective = data.effective_budget;
	if (effective && typeof effective === "object") candidates.push(effective);
	if (Array.isArray(data.budgets)) candidates.push(...data.budgets);

	for (const candidate of candidates) {
		if (
			candidate &&
			typeof candidate === "object" &&
			(candidate as { scope?: unknown }).scope === "key_limit"
		) {
			return candidate as Record<string, unknown>;
		}
	}
	return null;
}

/**
 * Account-level credit balance from `/api/v1/credits`.
 *
 * Unlike `/api/v1/key` this is per-account, not per-key: every key on the same
 * account sees the same `total_credits` / `total_usage`. Used only as the
 * fallback for keys that carry no budget of their own.
 */
async function fetchOpenRouterAccountCredits(
	apiKey: string,
): Promise<{ usageUsd: number; remainingUsd: number } | null> {
	const data = await fetchOpenRouterJson(OPENROUTER_CREDITS_ENDPOINT, apiKey);
	if (!data) return null;

	const totalCredits = toNumber(data.total_credits);
	if (totalCredits === null) return null;
	const totalUsage = toNumber(data.total_usage) ?? 0;

	return {
		usageUsd: totalUsage,
		remainingUsd: Math.max(0, totalCredits - totalUsage),
	};
}

/**
 * Fetch the credit balance for an OpenRouter API key.
 *
 * Reads `/api/v1/key` first, which reports the key's own allowance as
 * `limit` / `limit_remaining` / `usage` (USD). A key created without a budget
 * returns `limit: null`; rather than reporting that as "unlimited" and hiding
 * the balance entirely, we fall back to `/api/v1/credits` for the
 * account-level credit pool so the dashboard still shows what is spendable.
 *
 * Utilization, reset interval and reset time are reported **only for keys that
 * carry their own limit**. A limited key depletes on a schedule, so it can be
 * gated on like any other provider's window; an unlimited key's purchased
 * credit pool has no window to gate on, so it contributes no utilization and
 * can never be filtered out of selection.
 *
 * Non-blocking: failures return null and never affect provider operation.
 */
export async function fetchOpenRouterUsageData(
	apiKey: string,
): Promise<OpenRouterUsageData | null> {
	const data = await fetchOpenRouterJson(OPENROUTER_KEY_ENDPOINT, apiKey);
	if (!data) return null;

	const usage = toNumber(data.usage) ?? toNumber(data.usage_usd) ?? 0;
	const limit =
		toNumber(data.limit) ??
		toNumber(data.limit_usd) ??
		toNumber((data.effective_budget as Record<string, unknown>)?.limit_usd);

	// No key-level budget: report the account pool as a plain balance. No
	// utilization or reset window — there is no schedule to report against.
	if (limit === null) {
		const credits = await fetchOpenRouterAccountCredits(apiKey);
		if (credits) {
			return {
				usageUsd: credits.usageUsd,
				limitUsd: null,
				remainingUsd: credits.remainingUsd,
				utilizationPercent: null,
				balanceScope: "account",
				resetInterval: null,
				resetsAt: null,
			};
		}
		return {
			usageUsd: usage,
			limitUsd: null,
			remainingUsd: null,
			utilizationPercent: null,
			balanceScope: "unknown",
			resetInterval: null,
			resetsAt: null,
		};
	}

	const limitRemaining =
		toNumber(data.limit_remaining) ?? toNumber(data.remaining_usd);
	const remaining = limitRemaining ?? Math.max(0, limit - usage);

	// `limit_remaining` already reflects the current period, so the difference
	// against `limit` is exactly this period's spend. Only fall back to the
	// period counters (and finally lifetime usage for a non-resetting cap) when
	// the payload omits it.
	const resetInterval =
		typeof data.limit_reset === "string" ? data.limit_reset : null;
	const periodUsage =
		limitRemaining !== null
			? Math.max(0, limit - limitRemaining)
			: (periodUsageForReset(data, resetInterval) ?? usage);

	// Reset timing comes from the key_limit budget when present; `limit_reset`
	// alone only names the interval, not when the current period ends.
	const budget = keyLimitBudget(data);
	const resetsAtRaw = budget?.resets_at;
	const resetsAt =
		typeof resetsAtRaw === "string" && resetsAtRaw.length > 0
			? resetsAtRaw
			: null;

	return {
		usageUsd: usage,
		limitUsd: limit,
		remainingUsd: remaining,
		utilizationPercent:
			limit > 0 ? Math.min(100, (periodUsage / limit) * 100) : null,
		balanceScope: "key",
		resetInterval,
		resetsAt,
	};
}

/**
 * Representative utilization percent (0-100), or null when it cannot be
 * computed. Credits deplete on the key's own reset interval, so a limited key
 * gates selection like any other provider's window — but only ever from a
 * period-correct figure. Unlimited keys report null and are never gated.
 */
export function getRepresentativeOpenRouterUtilization(
	usage: OpenRouterUsageData | null,
): number | null {
	if (!usage) return null;
	return usage.utilizationPercent;
}
