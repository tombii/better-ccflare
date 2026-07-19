import { getModelFamily } from "@better-ccflare/core";
import type { AnyUsageData } from "@better-ccflare/providers";
import { collectWindows } from "./usage-throttling";

export interface ModelExhaustionResult {
	exhausted: boolean;
	/** Epoch ms of the scoped cap's reset, when known. */
	resetAt: number | null;
}

export type OverageStatus = "available" | "unavailable" | "unknown";

/**
 * Tri-state resolver for whether an account's overage/pay-as-you-go billing
 * would still serve requests past a 100%-exhausted weekly_scoped cap.
 * Precedence: the newer `spend.enabled` field (2026 API) wins over the
 * legacy `extra_usage.is_enabled` field when both are present; when neither
 * resolves to an actual boolean, the status is "unknown" — not assumed
 * disabled — since a missing/contradictory signal says nothing about the
 * account's real billing state.
 */
export function resolveOverageStatus(
	usageData: AnyUsageData | null | undefined,
): OverageStatus {
	const data = usageData as
		| {
				spend?: { enabled?: boolean } | null;
				extra_usage?: { is_enabled?: boolean } | null;
		  }
		| null
		| undefined;

	if (data?.spend && typeof data.spend.enabled === "boolean") {
		return data.spend.enabled ? "available" : "unavailable";
	}
	if (data?.extra_usage && typeof data.extra_usage.is_enabled === "boolean") {
		return data.extra_usage.is_enabled ? "available" : "unavailable";
	}
	return "unknown";
}

/**
 * Checks whether the account's weekly per-model (weekly_scoped) cap for the
 * given model's family is fully exhausted: EVERY weekly_scoped row for that
 * family is at percent >= 100 with a reset still in the future (a single
 * non-exhausted row — e.g. a distinct surface — means the family still has
 * usable capacity), AND overage/pay-as-you-go billing has not been
 * explicitly confirmed as available for this account (see
 * {@link resolveOverageStatus}: only a confirmed "available" status keeps
 * the account in rotation past 100% — "unavailable" and "unknown" both
 * exclude, since the 100%+future-reset telemetry is itself the primary
 * exhaustion signal).
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

	const familyRows = collectWindows(usageData ?? null).filter(
		(window) => window.scoped && window.modelFamily === family,
	);
	if (familyRows.length === 0) return { exhausted: false, resetAt: null };

	const exhaustedRows = familyRows.filter(
		(window) => window.utilization >= 100 && window.resetAtMs > now,
	);
	if (exhaustedRows.length !== familyRows.length) {
		return { exhausted: false, resetAt: null };
	}

	// Only a CONFIRMED-unavailable overage signal may exclude: "available"
	// means upstream will still serve past 100% via overage, and "unknown"
	// (missing/contradictory spend + extra_usage signals) must fail open —
	// a false exclusion removes a working account, a false pass costs one
	// reactive 429 round-trip.
	if (resolveOverageStatus(usageData) !== "unavailable") {
		return { exhausted: false, resetAt: null };
	}

	const resetAt = Math.min(...exhaustedRows.map((window) => window.resetAtMs));
	return { exhausted: true, resetAt };
}

// ── Negative cache ────────────────────────────────────────────────────────────
//
// Fed by observed out_of_credits 429s (proxy-operations.ts): a reactive
// signal that an (account, family) pair is exhausted, used alongside the
// telemetry-based check above because usageCache is only refreshed on a
// poll interval and can lag a real upstream rejection by several minutes.

const DEFAULT_NEGATIVE_CACHE_TTL_MS = 5 * 60 * 1000;

/**
 * Provenance of a negative-cache exhaustion mark: "telemetry_confirmed"
 * means the account's own limits[] telemetry showed the weekly_scoped cap
 * at >=100%; "recent_upstream_rejection" means the mark came only from an
 * observed out_of_credits 429 without corroborating telemetry. Only a
 * telemetry_confirmed mark may claim "weekly capacity exhausted" in a
 * user-facing response — a purely reactive mark uses neutral wording.
 */
export type FamilyExhaustionOrigin =
	| "telemetry_confirmed"
	| "recent_upstream_rejection";

interface ExhaustionEntry {
	until: number;
	origin: FamilyExhaustionOrigin;
}

const negativeCache = new Map<string, ExhaustionEntry>();

function negativeCacheKey(accountId: string, family: string): string {
	return `${accountId}:${family}`;
}

/**
 * Records that (accountId, family) is exhausted until `untilMs`. When
 * `untilMs` is missing or already in the past, falls back to a short
 * default TTL so a single 429 can't wedge the account out of rotation
 * indefinitely if the real reset time is never resolved. The TTL is always
 * this fixed default (or an explicit shorter `untilMs`) — there is no
 * longer-lived seeding from a scoped-cap reset; the cache only needs to
 * bridge the ~90s telemetry poll interval, not survive until the real
 * weekly reset.
 */
export function markFamilyExhausted(
	accountId: string,
	family: string,
	untilMs?: number | null,
	now: number = Date.now(),
	origin: FamilyExhaustionOrigin = "recent_upstream_rejection",
): void {
	const until =
		untilMs != null && untilMs > now
			? untilMs
			: now + DEFAULT_NEGATIVE_CACHE_TTL_MS;
	negativeCache.set(negativeCacheKey(accountId, family), { until, origin });
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

/**
 * Provenance of the current negative-cache mark for (accountId, family), or
 * null when nothing is marked (or the mark has expired — the entry is
 * evicted, matching {@link isFamilyExhausted}'s eviction behavior).
 */
export function getFamilyExhaustionOrigin(
	accountId: string,
	family: string,
	now: number = Date.now(),
): FamilyExhaustionOrigin | null {
	const key = negativeCacheKey(accountId, family);
	const entry = negativeCache.get(key);
	if (!entry) return null;
	if (entry.until <= now) {
		negativeCache.delete(key);
		return null;
	}
	return entry.origin;
}

/** Test-only: reset all negative-cache state between test cases. */
export function clearFamilyExhaustionCache(): void {
	negativeCache.clear();
}

// ── model_family_exhausted response ─────────────────────────────────────────

export interface ModelFamilyExhaustionInfo {
	family: string;
	resetAt: number | null;
	origin: FamilyExhaustionOrigin;
}

const DEFAULT_RETRY_AFTER_SECONDS = 60;
const MAX_RETRY_AFTER_SECONDS = 3600;

/**
 * Structured 429 returned when every candidate account for a request's
 * model family has been filtered out as capacity-exhausted, instead of
 * exhausting the normal per-account failover loop against accounts that are
 * already known to reject this model family. Anthropic-compatible shape:
 * `error.type` is the standard "rate_limit_error", with a separate
 * machine-readable `error.code` of "model_family_exhausted".
 *
 * Only a telemetry_confirmed origin may assert "weekly capacity exhausted"
 * in the message — a purely reactive (recent_upstream_rejection) mark uses
 * neutral wording, since it was never corroborated by the account's own
 * limits[] telemetry and may be misattributed to the wrong window.
 */
export function createModelFamilyExhaustedResponse(
	info: ModelFamilyExhaustionInfo,
): Response {
	const retryAfterSeconds =
		info.resetAt != null
			? Math.max(
					1,
					Math.min(
						MAX_RETRY_AFTER_SECONDS,
						Math.ceil((info.resetAt - Date.now()) / 1000),
					),
				)
			: DEFAULT_RETRY_AFTER_SECONDS;

	const resetIso =
		info.resetAt != null ? new Date(info.resetAt).toISOString() : null;

	const message =
		info.origin === "telemetry_confirmed"
			? `All available accounts have exhausted their weekly ${info.family} capacity.` +
				(resetIso ? ` Earliest reset at ${resetIso}.` : "")
			: `All available accounts have recently rejected requests for the ${info.family} model family.` +
				(resetIso ? ` Retry after ${resetIso}.` : "");

	return new Response(
		JSON.stringify({
			type: "error",
			error: {
				type: "rate_limit_error",
				code: "model_family_exhausted",
				message,
				family: info.family,
				resetAt: info.resetAt,
			},
		}),
		{
			status: 429,
			headers: {
				"Content-Type": "application/json",
				"Retry-After": String(retryAfterSeconds),
			},
		},
	);
}
