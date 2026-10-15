import { Logger } from "@better-ccflare/logger";

const log = new Logger("OpenRouterUsageFetcher");

const OPENROUTER_KEY_ENDPOINT = "https://openrouter.ai/api/v1/key";
const OPENROUTER_CREDITS_ENDPOINT = "https://openrouter.ai/api/v1/credits";

export interface OpenRouterUsageData {
	/** Usage counted against whatever `remainingUsd` was derived from, in USD */
	usageUsd: number;
	/** The key's own credit limit in USD; null when the key carries no budget */
	limitUsd: number | null;
	/** Remaining balance in USD, null when it could not be determined */
	remainingUsd: number | null;
	/** Utilization as percentage 0-100 */
	utilizationPercent: number;
	/**
	 * Where the balance came from:
	 * - `key`     — the key's own credit limit (`/api/v1/key`)
	 * - `account` — account-level credits, used for unlimited keys (`/api/v1/credits`)
	 * - `unknown` — neither could be read
	 */
	balanceScope: "key" | "account" | "unknown";
}

/**
 * GET an OpenRouter endpoint and return the parsed payload, or null on any
 * failure. Never throws — usage polling must not affect provider operation.
 */
async function fetchOpenRouterJson(
	url: string,
	apiKey: string,
): Promise<Record<string, unknown> | null> {
	try {
		const response = await fetch(url, {
			method: "GET",
			headers: {
				Authorization: `Bearer ${apiKey}`,
				Accept: "application/json",
			},
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

		const json = await response.json();
		return (json?.data ?? json) as Record<string, unknown>;
	} catch (error) {
		log.warn(`Error fetching OpenRouter usage data from ${url}:`, error);
		return null;
	}
}

/**
 * Account-level credit balance from `/api/v1/credits`.
 *
 * Unlike `/api/v1/key` this is per-account, not per-key: every key on the same
 * account sees the same `total_credits` / `total_usage`. Used only as the
 * fallback for keys that carry no budget of their own.
 */
async function fetchOpenRouterAccountCredits(apiKey: string): Promise<{
	usageUsd: number;
	remainingUsd: number;
	utilizationPercent: number;
} | null> {
	const data = await fetchOpenRouterJson(OPENROUTER_CREDITS_ENDPOINT, apiKey);
	if (!data) return null;

	const totalCredits = toNumber(data.total_credits);
	const totalUsage = toNumber(data.total_usage) ?? 0;
	if (totalCredits === null) return null;

	return {
		usageUsd: totalUsage,
		remainingUsd: Math.max(0, totalCredits - totalUsage),
		utilizationPercent:
			totalCredits > 0 ? Math.min(100, (totalUsage / totalCredits) * 100) : 0,
	};
}

/**
 * Fetch credit/usage data for an OpenRouter API key.
 *
 * Reads `/api/v1/key` first, which reports the key's own allowance as
 * `limit` / `limit_remaining` / `usage` (USD). A key created without a budget
 * returns `limit: null`; rather than reporting that as "unlimited" and hiding
 * the balance entirely, we fall back to `/api/v1/credits` for the
 * account-level credit pool so the dashboard still shows what is spendable.
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

	if (limit === null) {
		const credits = await fetchOpenRouterAccountCredits(apiKey);
		if (credits) {
			return {
				usageUsd: credits.usageUsd,
				limitUsd: null,
				remainingUsd: credits.remainingUsd,
				utilizationPercent: credits.utilizationPercent,
				balanceScope: "account",
			};
		}
		return {
			usageUsd: usage,
			limitUsd: null,
			remainingUsd: null,
			utilizationPercent: 0,
			balanceScope: "unknown",
		};
	}

	const remaining =
		toNumber(data.limit_remaining) ??
		toNumber(data.remaining_usd) ??
		Math.max(0, limit - usage);

	return {
		usageUsd: usage,
		limitUsd: limit,
		remainingUsd: remaining,
		utilizationPercent: limit > 0 ? Math.min(100, (usage / limit) * 100) : 0,
		balanceScope: "key",
	};
}

/** Coerce a JSON value to a finite number, or null when absent/not numeric. */
function toNumber(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * Get the representative utilization percentage (0-100)
 */
export function getRepresentativeOpenRouterUtilization(
	usage: OpenRouterUsageData | null,
): number | null {
	if (!usage) return null;
	return usage.utilizationPercent;
}

/**
 * Get the representative window label
 */
export function getRepresentativeOpenRouterWindow(
	usage: OpenRouterUsageData | null,
): string | null {
	if (!usage) return null;
	return "credits";
}
