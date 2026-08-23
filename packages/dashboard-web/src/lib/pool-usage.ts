import { computeWindowStartMs, getModelFamily } from "@better-ccflare/core";
import type { AccountResponse, FullUsageData } from "@better-ccflare/types";
import type { RoutingObservation } from "../api";

export type PoolWindow = "five_hour" | "seven_day";

/**
 * What a PoolUsageRow can display: the two account-wide windows, or an
 * aggregated per-model-family weekly_scoped pool (computed by
 * computeScopedPoolUsage). Only the row's date formatting depends on this;
 * computePoolUsage itself accepts the two account-wide windows only.
 */
export type PoolCardWindow = PoolWindow | "weekly_scoped";

export type ExcludedReason =
	| "paused"
	| "rate_limited"
	| "token_expired"
	| "usage_rate_limited"
	| "five_hour_exhausted"
	| "seven_day_exhausted"
	| "family_exhausted"
	| "no_usage_data";

export interface PoolUsageContribution {
	name: string;
	pct: number;
	resetMs: number | null;
}

export interface PoolUsageProjection
	extends Omit<PoolUsageContribution, "resetMs"> {
	resetMs: number;
	exhaustsAtMs: number;
	timeToExhaustMs: number;
	remainingMs: number;
}

export interface PoolUsageExclusion {
	name: string;
	reason: ExcludedReason;
	resetMs: number | null;
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
	atRisk: PoolUsageProjection[];
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
	return (
		("five_hour" in usageData && "seven_day" in usageData) ||
		Array.isArray((usageData as { limits?: unknown }).limits)
	);
}

interface ExtractedValue {
	pct: number | null;
	resetMs: number | null;
}

// Read a session / weekly_all entry from Anthropic's generic limits[] array
// (the authoritative source). NanoGPT's `limits` is an object, so we guard with
// Array.isArray. Returns null when limits[] is absent -> caller falls back to
// the legacy flat five_hour / seven_day windows.
function extractAnthropicLimit(
	usageData: FullUsageData,
	kind: "session" | "weekly_all",
): ExtractedValue | null {
	const limits = (usageData as { limits?: unknown }).limits;
	if (!Array.isArray(limits)) return null;
	const entry = limits.find(
		(l) => l && typeof l === "object" && (l as { kind?: string }).kind === kind,
	) as { percent?: number | null; resets_at?: string | null } | undefined;
	// Absent OR present-but-null percent -> return null so the caller falls back to
	// the legacy flat window instead of excluding the account as no_usage_data.
	if (!entry || entry.percent == null) return null;
	return {
		pct: entry.percent,
		resetMs: normalizeResetMs(entry.resets_at ?? null),
	};
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
		// PRIMARY: the generic limits[] session entry; FALLBACK: legacy five_hour.
		const fromLimits = extractAnthropicLimit(usageData, "session");
		if (fromLimits) return fromLimits;
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
		// PRIMARY: the generic limits[] weekly_all entry; FALLBACK: legacy seven_day.
		const fromLimits = extractAnthropicLimit(usageData, "weekly_all");
		if (fromLimits) return fromLimits;
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
): { reason: ExcludedReason; resetMs: number | null } | null {
	if (account.paused === true) return { reason: "paused", resetMs: null };
	if (account.rateLimitedUntil != null && account.rateLimitedUntil > now) {
		return { reason: "rate_limited", resetMs: account.rateLimitedUntil };
	}
	if (account.hasRefreshToken === true && account.tokenExpiresAt) {
		const expiresMs = Date.parse(account.tokenExpiresAt);
		if (Number.isFinite(expiresMs) && expiresMs < now) {
			return { reason: "token_expired", resetMs: null };
		}
	}
	if (
		account.usageRateLimitedUntil != null &&
		account.usageRateLimitedUntil > now &&
		!account.usageData
	) {
		return {
			reason: "usage_rate_limited",
			resetMs: account.usageRateLimitedUntil,
		};
	}
	return null;
}

function classifyQuotaExhaustion(
	account: AccountResponse,
): { reason: ExcludedReason; resetMs: number | null } | null {
	if (!account.usageData) return null;

	const fiveHour = extractFiveHour(account.usageData);
	if (fiveHour?.pct != null && fiveHour.pct >= 100) {
		return { reason: "five_hour_exhausted", resetMs: fiveHour.resetMs };
	}

	const sevenDay = extractSevenDay(account.usageData);
	if (sevenDay?.pct != null && sevenDay.pct >= 100) {
		return { reason: "seven_day_exhausted", resetMs: sevenDay.resetMs };
	}

	return null;
}

/**
 * Aggregation tail shared by computePoolUsage (account-wide five_hour/seven_day
 * pools) and computeScopedPoolUsage (per-model-family weekly_scoped pools):
 * turns the already-classified contributing/exhausted/excluded/fallback lists
 * into averages, the worst offender, the earliest reset, and the at-risk
 * (burn-rate) projection. `window` only feeds the at-risk projection's window
 * start calculation (computeWindowStartMs accepts any SupportedWindow-like
 * string, so "seven_day" is also correct for a weekly_scoped family pool).
 */
function finalizePoolResult(params: {
	contributing: PoolUsageContribution[];
	exhausted: PoolUsageExclusion[];
	excluded: PoolUsageExclusion[];
	fallback: PoolUsageFallback[];
	window: PoolWindow;
	now: number;
}): PoolUsageResult {
	const { contributing, exhausted, excluded, fallback, window, now } = params;

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

	const resetCandidates = [...contributing, ...exhausted].filter(
		(
			c,
		): c is (PoolUsageContribution | PoolUsageExclusion) & {
			resetMs: number;
		} => c.resetMs != null && c.resetMs > now,
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

	const atRisk: PoolUsageProjection[] = [];
	for (const c of contributing) {
		if (c.resetMs == null) continue;
		const startMs = computeWindowStartMs(c.resetMs, window);
		if (startMs == null) continue;
		const elapsed = now - startMs;
		const remainingMs = c.resetMs - now;
		if (elapsed <= 0 || remainingMs <= 0) continue;
		const f = c.pct / 100;
		if (f <= 0 || f >= 1) continue;
		const timeToExhaustMs = ((1 - f) / f) * elapsed;
		if (timeToExhaustMs < remainingMs) {
			atRisk.push({
				name: c.name,
				pct: c.pct,
				resetMs: c.resetMs,
				exhaustsAtMs: now + timeToExhaustMs,
				timeToExhaustMs,
				remainingMs,
			});
		}
	}

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
		atRisk,
	};
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

		const exclusion =
			classifyExclusion(account, now) ?? classifyQuotaExhaustion(account);
		if (exclusion) {
			exhausted.push({
				name: account.name,
				reason: exclusion.reason,
				resetMs: exclusion.resetMs,
			});
			continue;
		}

		if (!account.usageData) {
			excluded.push({
				name: account.name,
				reason: "no_usage_data",
				resetMs: null,
			});
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
			excluded.push({
				name: account.name,
				reason: "no_usage_data",
				resetMs: extracted.resetMs,
			});
			continue;
		}

		contributing.push({
			name: account.name,
			pct: extracted.pct,
			resetMs: extracted.resetMs,
		});
	}

	return finalizePoolResult({
		contributing,
		exhausted,
		excluded,
		fallback,
		window,
		now,
	});
}

// Normalizes a weekly_scoped display name into the same family key the
// proxy's routing/capacity logic uses (getModelFamily), so the dashboard's
// pool grouping can never drift from what the backend actually routed on --
// see usage-throttling.ts:collectWindows and model-capacity.ts:
// isAccountExhaustedForModel, both of which key their weekly_scoped rows on
// `getModelFamily(display_name.trim()) ?? undefined`. A display name
// matching no known pattern (a family the normalizer doesn't recognize yet)
// falls back to its own trimmed, lowercased key instead of being dropped --
// silently discarding it would make a genuinely new family invisible in the
// overview instead of surfaced as its own pool. NEVER use this for display
// -- see formatFamilyLabel below for that.
function deriveScopedFamilyKey(displayName: string): string {
	const trimmed = displayName.trim();
	return getModelFamily(trimmed) ?? trimmed.toLowerCase();
}

interface ScopedExtractedValue extends ExtractedValue {
	// True only when EVERY weekly_scoped row matched for this family has a
	// numeric percent >= 100 -- mirrors the backend's
	// isAccountExhaustedForModel (model-capacity.ts), which requires ALL
	// scoped rows for a family to be exhausted before excluding the account.
	// A row with percent === null makes this false (fail open), matching the
	// backend's countRawScopedFamilyRows guard against exhaustion-by-omission.
	allRowsExhausted: boolean;
}

// Read every weekly_scoped entry (a per-model-family weekly cap) from the
// generic limits[] array that normalizes to the given family key. Unlike
// extractAnthropicLimit (session/weekly_all), this returns null ONLY when no
// matching row exists at all -- that is the family-pool membership signal
// (computeScopedPoolUsage skips accounts entirely when they have no entry for
// the family, per the "no fallback noise" requirement). An account can carry
// MULTIPLE rows for one family (e.g. distinct surfaces); when it does:
//   - pct is the MAXIMUM of the rows' non-null percents -- the binding
//     constraint, i.e. the value the user actually feels. Rows with
//     percent == null are excluded from the maximum. pct is null only when
//     NONE of the matched rows carry a numeric percent.
//   - resetMs is the earliest reset among the rows that hold that maximum
//     value; if none of those carry a reset, it falls back to the earliest
//     reset among all matched rows.
//   - allRowsExhausted is true only when every matched row is individually
//     at percent >= 100 AND still has a reset in the future (see
//     ScopedExtractedValue).
function extractWeeklyScoped(
	usageData: FullUsageData,
	family: string,
	now: number,
): ScopedExtractedValue | null {
	const limits = (usageData as { limits?: unknown }).limits;
	if (!Array.isArray(limits)) return null;

	const rows = limits.filter(
		(l) =>
			l &&
			typeof l === "object" &&
			(l as { kind?: string }).kind === "weekly_scoped" &&
			deriveScopedFamilyKey(
				(l as { scope?: { model?: { display_name?: string } } }).scope?.model
					?.display_name ?? "",
			) === family,
	) as Array<{ percent?: number | null; resets_at?: string | null }>;
	if (rows.length === 0) return null;

	const numericPercents = rows
		.map((row) => row.percent)
		.filter((percent): percent is number => typeof percent === "number");
	const pct =
		numericPercents.length === 0 ? null : Math.max(...numericPercents);

	const resetsOf = (candidates: typeof rows): number | null => {
		const resets = candidates
			.map((row) => normalizeResetMs(row.resets_at ?? null))
			.filter((reset): reset is number => reset !== null);
		return resets.length === 0 ? null : Math.min(...resets);
	};
	const maxRows = pct === null ? [] : rows.filter((row) => row.percent === pct);
	const resetMs = resetsOf(maxRows) ?? resetsOf(rows);

	// Backend parity (model-capacity.ts:111-113): a row only proves exhaustion
	// when it is at/over 100% AND its reset still lies in the future. A 100% row
	// with a passed or unparsable reset is stale/unproven telemetry the router
	// fails OPEN on — branding it family_exhausted here would claim an exclusion
	// routing does not make.
	const allRowsExhausted = rows.every((row) => {
		if (typeof row.percent !== "number" || row.percent < 100) return false;
		const rowReset = normalizeResetMs(row.resets_at ?? null);
		return rowReset !== null && rowReset > now;
	});

	return { pct, resetMs, allRowsExhausted };
}

// Discover the set of per-model-family weekly_scoped pools present across all
// accounts' usageData, in stable alphabetical order. Keyed by the normalized
// family (deriveScopedFamilyKey), so two accounts whose scoped display names
// resolve to the same family (e.g. "Fable" and "Claude Fable 5") share ONE
// pool instead of splitting into two. An entry without a display name is
// skipped (mirrors collectAnthropicLimitRows in rate-limit-helpers.ts, which
// does the same for the per-account display).
function discoverScopedFamilies(accounts: AccountResponse[]): string[] {
	const families = new Set<string>();
	for (const account of accounts) {
		const usageData = account.usageData;
		if (!usageData) continue;
		const limits = (usageData as { limits?: unknown }).limits;
		if (!Array.isArray(limits)) continue;
		for (const l of limits) {
			if (!l || typeof l !== "object") continue;
			if ((l as { kind?: string }).kind !== "weekly_scoped") continue;
			const name = (
				l as { scope?: { model?: { display_name?: string } } }
			).scope?.model?.display_name?.trim();
			if (name) families.add(deriveScopedFamilyKey(name));
		}
	}
	return Array.from(families).sort();
}

function computeScopedPoolUsageForFamily(
	accounts: AccountResponse[],
	family: string,
	now: number,
): PoolUsageResult {
	const contributing: PoolUsageContribution[] = [];
	const exhausted: PoolUsageExclusion[] = [];
	const excluded: PoolUsageExclusion[] = [];
	// Scoped pools never record a "fallback" list: accounts without a
	// weekly_scoped entry for this family simply aren't part of the pool at
	// all (see extractWeeklyScoped's membership semantics above) -- there is
	// no separate ineligible-provider concept to surface here.
	const fallback: PoolUsageFallback[] = [];

	for (const account of accounts) {
		if (!account.usageData) continue;

		const extracted = extractWeeklyScoped(account.usageData, family, now);
		if (extracted === null) continue; // not part of this family's pool

		const exclusion =
			classifyExclusion(account, now) ?? classifyQuotaExhaustion(account);
		if (exclusion) {
			exhausted.push({
				name: account.name,
				reason: exclusion.reason,
				resetMs: exclusion.resetMs,
			});
			continue;
		}

		if (extracted.pct === null) {
			excluded.push({
				name: account.name,
				reason: "no_usage_data",
				resetMs: extracted.resetMs,
			});
			continue;
		}

		// Only when EVERY row for this family is exhausted -- mirrors the
		// backend's isAccountExhaustedForModel. An account with one exhausted
		// row and one still-usable row for the same family keeps contributing
		// (with pct at the binding maximum), exactly as routing would still
		// use it for the non-exhausted surface.
		if (extracted.allRowsExhausted) {
			exhausted.push({
				name: account.name,
				reason: "family_exhausted",
				resetMs: extracted.resetMs,
			});
			continue;
		}

		contributing.push({
			name: account.name,
			pct: extracted.pct,
			resetMs: extracted.resetMs,
		});
	}

	return finalizePoolResult({
		contributing,
		exhausted,
		excluded,
		fallback,
		window: "seven_day",
		now,
	});
}

/**
 * Aggregates one PoolUsageResult per per-model-family weekly_scoped pool
 * (e.g. "Fable pool") discovered across all accounts' usageData. Families are
 * discovered from the data itself (discoverScopedFamilies) rather than
 * hardcoded, in stable alphabetical order. Accounts with no weekly_scoped
 * entry for a given family are not part of that family's pool. Returns []
 * when no account has any weekly_scoped limits.
 */
export function computeScopedPoolUsage(
	accounts: AccountResponse[],
	now: number,
): Array<{ family: string; result: PoolUsageResult }> {
	return discoverScopedFamilies(accounts).map((family) => ({
		family,
		result: computeScopedPoolUsageForFamily(accounts, family, now),
	}));
}

export interface PoolSegment {
	name: string;
	pct: number | null;
	kind: "active" | "exhausted" | "unknown";
	reason?: ExcludedReason;
	// The projected exhaustion timestamp (ms) for this segment's account, taken
	// from result.atRisk by name. Only ever set for "active" segments -- atRisk
	// is built exclusively from `contributing` accounts (finalizePoolResult), so
	// an "exhausted" or "unknown" segment never carries one. Undefined (not
	// null) when the account has no burn-rate projection, matching the "absent
	// = not applicable" convention used by the other optional PoolSegment
	// fields (e.g. `reason`).
	exhaustsAtMs?: number;
	// The account's own window reset (ms), carried straight through from its
	// contributing/exhausted/excluded source entry -- null when unknown, never
	// omitted (unlike `reason`/`exhaustsAtMs`, every segment has a resetMs,
	// even if it's null). Feeds the "in Xd Yh" relative-reset mini-row in
	// PoolUsageRow via formatRelativeReset.
	resetMs: number | null;
}

/**
 * Turns a PoolUsageResult into one segment per pool account, for the
 * segmented bar in PoolUsageRow. Only contributing/exhausted/excluded
 * accounts become segments -- fallback accounts are not part of the pool
 * (see computePoolUsage/computeScopedPoolUsage) and are intentionally
 * omitted here too.
 *
 * Sort order groups segments by what their position can actually communicate
 * -- capacity depletion order, never routing order (routing is a backend
 * decision; see PoolUsageRow's "next" badge, driven by isPrimary, for that):
 *
 *   1. Already-exhausted accounts (kind "exhausted") first -- they are
 *      already empty, so there is nothing left to sequence between them;
 *      ties (i.e. all of them) are broken alphabetically by name for a
 *      deterministic order.
 *   2. Accounts with a burn-rate projection (`exhaustsAtMs` present, from
 *      result.atRisk), ascending by exhaustsAtMs -- the one projected to run
 *      out soonest comes first. Ties broken alphabetically by name.
 *   3. Everything else (no projection, including "unknown" segments),
 *      descending by pct, with null (unknown) segments always last and ties
 *      broken alphabetically by name.
 *
 * Within any tie, alphabetical-by-name keeps the overall order fully
 * deterministic regardless of input order.
 */
export function buildPoolSegments(result: PoolUsageResult): PoolSegment[] {
	const exhaustsAtMsByName = new Map<string, number>();
	for (const projection of result.atRisk) {
		exhaustsAtMsByName.set(projection.name, projection.exhaustsAtMs);
	}

	const segments: PoolSegment[] = [
		...result.contributing.map(
			(c): PoolSegment => ({
				name: c.name,
				pct: c.pct,
				kind: "active",
				exhaustsAtMs: exhaustsAtMsByName.get(c.name),
				resetMs: c.resetMs,
			}),
		),
		...result.exhausted.map(
			(e): PoolSegment => ({
				name: e.name,
				pct: 100,
				kind: "exhausted",
				reason: e.reason,
				resetMs: e.resetMs,
			}),
		),
		...result.excluded.map(
			(e): PoolSegment => ({
				name: e.name,
				pct: null,
				kind: "unknown",
				reason: e.reason,
				resetMs: e.resetMs,
			}),
		),
	];

	// 0 = already exhausted, 1 = projected (has exhaustsAtMs), 2 = the rest.
	const groupOf = (s: PoolSegment): 0 | 1 | 2 => {
		if (s.kind === "exhausted") return 0;
		if (s.exhaustsAtMs != null) return 1;
		return 2;
	};

	return segments.sort((a, b) => {
		const groupA = groupOf(a);
		const groupB = groupOf(b);
		if (groupA !== groupB) return groupA - groupB;

		if (groupA === 0) {
			return a.name.localeCompare(b.name);
		}
		if (groupA === 1) {
			// Both have exhaustsAtMs by construction of groupOf.
			const diff = (a.exhaustsAtMs as number) - (b.exhaustsAtMs as number);
			return diff !== 0 ? diff : a.name.localeCompare(b.name);
		}
		if (a.pct === null && b.pct === null) return a.name.localeCompare(b.name);
		if (a.pct === null) return 1;
		if (b.pct === null) return -1;
		if (a.pct !== b.pct) return b.pct - a.pct;
		return a.name.localeCompare(b.name);
	});
}

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Human-readable relative time until `resetMs` ("in 2d 4h" / "in 1h 1m" /
 * "in 45m"), or null when there's nothing to show (no resetMs, or it's
 * already in the past / equal to `now`). Days + hours from 1 full day
 * onward; hours + minutes below that, dropping the hours component
 * entirely under a full hour. Shared between the pool-capacity segments
 * (PoolUsageRow) and the per-account rate-limit rows (RateLimitProgress) --
 * kept here in lib/ rather than a components/ file so both can import it
 * without an awkward components/accounts -> components/overview dependency.
 */
export function formatRelativeReset(
	resetMs: number | null,
	now: number,
): string | null {
	if (resetMs == null) return null;
	const diffMs = resetMs - now;
	if (diffMs <= 0) return null;

	if (diffMs >= ONE_DAY_MS) {
		const days = Math.floor(diffMs / ONE_DAY_MS);
		const hours = Math.floor((diffMs - days * ONE_DAY_MS) / (60 * 60 * 1000));
		return `in ${days}d ${hours}h`;
	}

	const totalMinutes = Math.floor(diffMs / 60000);
	const hours = Math.floor(totalMinutes / 60);
	const minutes = totalMinutes % 60;
	return hours > 0 ? `in ${hours}h ${minutes}m` : `in ${minutes}m`;
}

/**
 * Every recorded routing observation, in stable alphabetical order by family
 * key -- the single source for the "observed routing order" table
 * (ObservedRoutingTable), which shows ALL observed families regardless of
 * whether a family also has its own weekly_scoped pool row (e.g. "fable").
 * Returns [] when observations is absent/null/empty.
 */
export function listObservedFamilies(
	observations: Record<string, RoutingObservation> | undefined | null,
): Array<{ family: string; observation: RoutingObservation }> {
	if (!observations) return [];
	return Object.entries(observations)
		.map(([family, observation]) => ({ family, observation }))
		.sort((a, b) => a.family.localeCompare(b.family));
}

/**
 * Display-only prettification of a routing-observation family key ("fable"
 * -> "Fable"): trims, then uppercases the first character, leaving the rest
 * of the string untouched. NEVER use this for comparisons -- the family key
 * itself (as recorded by the proxy's getModelFamily(), lowercase) is the
 * comparison value; this is rendering only.
 */
export function formatFamilyLabel(family: string): string {
	const trimmed = family.trim();
	if (trimmed === "") return "";
	return trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
}
