import { getModelFamily } from "@better-ccflare/core";
import type { AnyUsageData } from "@better-ccflare/providers";
import { collectWindows } from "./usage-throttling";

export interface ModelExhaustionResult {
	exhausted: boolean;
	/** Epoch ms of the scoped cap's reset, when known. */
	resetAt: number | null;
}

/**
 * Checks whether the account's weekly per-model (weekly_scoped) cap for the
 * given model's family is fully exhausted: percent >= 100 AND the reset is
 * still in the future.
 *
 * Fails open (returns {exhausted:false}) whenever the family can't be
 * confidently attributed: unknown request-model family, a scoped row whose
 * display name has no known family mapping, a reset that has already
 * passed (stale telemetry), or missing telemetry altogether. A false
 * positive here removes a working account from rotation; a false negative
 * just costs one extra 429 round-trip, so the asymmetry favors not excluding.
 */
export function isAccountExhaustedForModel(
	usageData: AnyUsageData | null | undefined,
	model: string | null | undefined,
	now: number = Date.now(),
): ModelExhaustionResult {
	const family = model ? getModelFamily(model) : null;
	if (!family) return { exhausted: false, resetAt: null };

	for (const window of collectWindows(usageData ?? null)) {
		if (!window.scoped || window.modelFamily !== family) continue;
		if (window.utilization < 100) continue;
		if (window.resetAtMs <= now) continue;
		return { exhausted: true, resetAt: window.resetAtMs };
	}
	return { exhausted: false, resetAt: null };
}

/**
 * Finds the reset time of the account's weekly_scoped cap for the given
 * model's family, regardless of current utilization. Used to seed the
 * negative-cache TTL from a real out_of_credits 429 even when locally
 * cached usage telemetry hasn't caught up to 100% yet.
 */
export function findScopedResetAt(
	usageData: AnyUsageData | null | undefined,
	model: string | null | undefined,
	now: number = Date.now(),
): number | null {
	const family = model ? getModelFamily(model) : null;
	if (!family) return null;

	for (const window of collectWindows(usageData ?? null)) {
		if (!window.scoped || window.modelFamily !== family) continue;
		if (window.resetAtMs > now) return window.resetAtMs;
	}
	return null;
}

// ── Negative cache ────────────────────────────────────────────────────────────
//
// Fed by observed out_of_credits 429s (proxy-operations.ts): a reactive
// signal that an (account, family) pair is exhausted, used alongside the
// telemetry-based check above because usageCache is only refreshed on a
// poll interval and can lag a real upstream rejection by several minutes.

const DEFAULT_NEGATIVE_CACHE_TTL_MS = 5 * 60 * 1000;

interface ExhaustionEntry {
	until: number;
}

const negativeCache = new Map<string, ExhaustionEntry>();

function negativeCacheKey(accountId: string, family: string): string {
	return `${accountId}:${family}`;
}

/**
 * Records that (accountId, family) is exhausted until `untilMs`. When
 * `untilMs` is missing or already in the past, falls back to a short
 * default TTL so a single 429 can't wedge the account out of rotation
 * indefinitely if the real reset time is never resolved.
 */
export function markFamilyExhausted(
	accountId: string,
	family: string,
	untilMs?: number | null,
	now: number = Date.now(),
): void {
	const until =
		untilMs != null && untilMs > now
			? untilMs
			: now + DEFAULT_NEGATIVE_CACHE_TTL_MS;
	negativeCache.set(negativeCacheKey(accountId, family), { until });
}

/** Whether (accountId, family) was recently marked exhausted and hasn't expired. */
export function isFamilyExhausted(
	accountId: string,
	family: string,
	now: number = Date.now(),
): boolean {
	const key = negativeCacheKey(accountId, family);
	const entry = negativeCache.get(key);
	if (!entry) return false;
	if (entry.until <= now) {
		negativeCache.delete(key);
		return false;
	}
	return true;
}

/** Test-only: reset all negative-cache state between test cases. */
export function clearFamilyExhaustionCache(): void {
	negativeCache.clear();
}

// ── model_family_exhausted response ─────────────────────────────────────────

export interface ModelFamilyExhaustionInfo {
	family: string;
	resetAt: number | null;
}

const DEFAULT_RETRY_AFTER_SECONDS = 60;

/**
 * Structured 529 returned when every candidate account for a request's
 * model family has been filtered out as capacity-exhausted, instead of
 * exhausting the normal per-account failover loop against accounts that are
 * already known to reject this model family.
 */
export function createModelFamilyExhaustedResponse(
	info: ModelFamilyExhaustionInfo,
): Response {
	const retryAfterSeconds =
		info.resetAt != null
			? Math.max(1, Math.ceil((info.resetAt - Date.now()) / 1000))
			: DEFAULT_RETRY_AFTER_SECONDS;

	return new Response(
		JSON.stringify({
			type: "error",
			error: {
				type: "model_family_exhausted",
				message:
					`All available accounts have exhausted their weekly ${info.family} capacity.` +
					(info.resetAt != null
						? ` Earliest reset at ${new Date(info.resetAt).toISOString()}.`
						: ""),
				family: info.family,
				resetAt: info.resetAt,
			},
		}),
		{
			status: 529,
			headers: {
				"Content-Type": "application/json",
				"Retry-After": String(retryAfterSeconds),
			},
		},
	);
}
