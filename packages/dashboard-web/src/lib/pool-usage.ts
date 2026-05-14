import type { AccountResponse, FullUsageData } from "@better-ccflare/types";

export type PoolWindow = "five_hour" | "seven_day";

export type ExcludedReason =
	| "paused"
	| "rate_limited"
	| "token_expired"
	| "usage_rate_limited"
	| "no_usage_data";

export interface PoolUsageContribution {
	name: string;
	pct: number;
	resetMs: number | null;
}

export interface PoolUsageExclusion {
	name: string;
	reason: ExcludedReason;
}

export interface PoolUsageFallback {
	name: string;
	provider: string;
}

export interface PoolUsageResult {
	average: number | null;
	activeAverage: number | null;
	worst: { name: string; pct: number } | null;
	contributing: PoolUsageContribution[];
	exhausted: PoolUsageExclusion[];
	excluded: PoolUsageExclusion[];
	fallback: PoolUsageFallback[];
	earliestResetMs: number | null;
	earliestResetAccountName: string | null;
}

const FIVE_HOUR_ELIGIBLE_PROVIDERS: ReadonlySet<string> = new Set([
	"anthropic",
	"codex",
	"alibaba-coding-plan",
	"zai",
]);

const SEVEN_DAY_ELIGIBLE_PROVIDERS: ReadonlySet<string> = new Set([
	"anthropic",
	"codex",
	"alibaba-coding-plan",
]);

export function normalizeResetMs(
	value: string | number | null | undefined,
): number | null {
	if (value === null || value === undefined) return null;
	if (typeof value === "number") {
		return Number.isFinite(value) ? value : null;
	}
	if (typeof value === "string") {
		const parsed = Date.parse(value);
		return Number.isFinite(parsed) ? parsed : null;
	}
	return null;
}

export function isNanoGPTShape(
	usageData: FullUsageData | null | undefined,
): boolean {
	return (
		usageData != null &&
		"active" in usageData &&
		"daily" in usageData &&
		"monthly" in usageData
	);
}

export function isAlibabaShape(
	usageData: FullUsageData | null | undefined,
): boolean {
	return usageData != null && "five_hour" in usageData && "weekly" in usageData;
}

export function isZaiShape(
	usageData: FullUsageData | null | undefined,
): boolean {
	return (
		usageData != null &&
		("time_limit" in usageData || "tokens_limit" in usageData)
	);
}

export function isAnthropicStyleShape(
	usageData: FullUsageData | null | undefined,
): boolean {
	if (usageData == null) return false;
	if (isNanoGPTShape(usageData)) return false;
	if (isAlibabaShape(usageData)) return false;
	if (isZaiShape(usageData)) return false;
	return "five_hour" in usageData && "seven_day" in usageData;
}

interface ExtractedValue {
	pct: number | null;
	resetMs: number | null;
}

function extractFiveHour(usageData: FullUsageData): ExtractedValue | null {
	if (isNanoGPTShape(usageData)) return null;
	if (isAlibabaShape(usageData)) {
		const data = usageData as {
			five_hour: { percentUsed: number | null; resetAt: number | null };
		};
		return {
			pct: data.five_hour?.percentUsed ?? null,
			resetMs: normalizeResetMs(data.five_hour?.resetAt ?? null),
		};
	}
	if (isZaiShape(usageData)) {
		const data = usageData as {
			tokens_limit?: {
				percentage: number | null;
				resetAt: number | null;
			} | null;
		};
		const tokens = data.tokens_limit;
		if (!tokens) {
			return { pct: null, resetMs: null };
		}
		return {
			pct: tokens.percentage ?? null,
			resetMs: normalizeResetMs(tokens.resetAt ?? null),
		};
	}
	if (isAnthropicStyleShape(usageData)) {
		const data = usageData as {
			five_hour?: { utilization: number | null; resets_at: string | null };
		};
		const five = data.five_hour;
		if (!five) {
			return { pct: null, resetMs: null };
		}
		return {
			pct: five.utilization ?? null,
			resetMs: normalizeResetMs(five.resets_at ?? null),
		};
	}
	return null;
}

function extractSevenDay(usageData: FullUsageData): ExtractedValue | null {
	if (isNanoGPTShape(usageData)) return null;
	if (isAlibabaShape(usageData)) {
		const data = usageData as {
			weekly: { percentUsed: number | null; resetAt: number | null };
		};
		return {
			pct: data.weekly?.percentUsed ?? null,
			resetMs: normalizeResetMs(data.weekly?.resetAt ?? null),
		};
	}
	if (isZaiShape(usageData)) {
		return null;
	}
	if (isAnthropicStyleShape(usageData)) {
		const data = usageData as {
			seven_day?: { utilization: number | null; resets_at: string | null };
		};
		const seven = data.seven_day;
		if (!seven) {
			return { pct: null, resetMs: null };
		}
		return {
			pct: seven.utilization ?? null,
			resetMs: normalizeResetMs(seven.resets_at ?? null),
		};
	}
	return null;
}

function eligibleProvidersFor(window: PoolWindow): ReadonlySet<string> {
	return window === "five_hour"
		? FIVE_HOUR_ELIGIBLE_PROVIDERS
		: SEVEN_DAY_ELIGIBLE_PROVIDERS;
}

function classifyExclusion(
	account: AccountResponse,
	now: number,
): ExcludedReason | null {
	if (account.paused === true) return "paused";
	if (account.rateLimitedUntil != null && account.rateLimitedUntil > now) {
		return "rate_limited";
	}
	if (account.hasRefreshToken === true && account.tokenExpiresAt) {
		const expiresMs = Date.parse(account.tokenExpiresAt);
		if (Number.isFinite(expiresMs) && expiresMs < now) {
			return "token_expired";
		}
	}
	if (
		account.usageRateLimitedUntil != null &&
		account.usageRateLimitedUntil > now &&
		!account.usageData
	) {
		return "usage_rate_limited";
	}
	return null;
}

export function computePoolUsage(
	accounts: AccountResponse[],
	window: PoolWindow,
	now: number,
): PoolUsageResult {
	const contributing: PoolUsageContribution[] = [];
	const exhausted: PoolUsageExclusion[] = [];
	const excluded: PoolUsageExclusion[] = [];
	const fallback: PoolUsageFallback[] = [];

	const eligible = eligibleProvidersFor(window);

	for (const account of accounts) {
		if (!eligible.has(account.provider)) {
			fallback.push({ name: account.name, provider: account.provider });
			continue;
		}

		const exclusion = classifyExclusion(account, now);
		if (exclusion) {
			exhausted.push({ name: account.name, reason: exclusion });
			continue;
		}

		if (!account.usageData) {
			excluded.push({ name: account.name, reason: "no_usage_data" });
			continue;
		}

		const extracted =
			window === "five_hour"
				? extractFiveHour(account.usageData)
				: extractSevenDay(account.usageData);

		if (extracted === null) {
			fallback.push({ name: account.name, provider: account.provider });
			continue;
		}

		if (extracted.pct === null) {
			excluded.push({ name: account.name, reason: "no_usage_data" });
			continue;
		}

		contributing.push({
			name: account.name,
			pct: extracted.pct,
			resetMs: extracted.resetMs,
		});
	}

	const activeAverage =
		contributing.length === 0
			? null
			: contributing.reduce((sum, c) => sum + c.pct, 0) / contributing.length;
	const capacityCount = contributing.length + exhausted.length;
	const average =
		capacityCount === 0
			? null
			: (contributing.reduce((sum, c) => sum + c.pct, 0) +
					exhausted.length * 100) /
				capacityCount;

	let worst: { name: string; pct: number } | null = null;
	for (const c of contributing) {
		if (worst === null || c.pct > worst.pct) {
			worst = { name: c.name, pct: c.pct };
		}
	}
	for (const e of exhausted) {
		if (worst === null || 100 > worst.pct) {
			worst = { name: e.name, pct: 100 };
		}
	}

	const resetCandidates = contributing.filter(
		(c): c is PoolUsageContribution & { resetMs: number } => c.resetMs != null,
	);
	const earliestResetMs =
		resetCandidates.length === 0
			? null
			: Math.min(...resetCandidates.map((c) => c.resetMs));
	const earliestResetAccountName =
		earliestResetMs === null
			? null
			: (resetCandidates.find((c) => c.resetMs === earliestResetMs)?.name ??
				null);

	return {
		average,
		activeAverage,
		worst,
		contributing,
		exhausted,
		excluded,
		fallback,
		earliestResetMs,
		earliestResetAccountName,
	};
}
