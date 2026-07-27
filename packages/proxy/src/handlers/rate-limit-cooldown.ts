import {
	computeOverloadCooldownMs,
	computeOverloadWithResetCapMs,
	computeRateLimitBackoffMs,
	isOverloadReason,
	logError,
	RateLimitError,
} from "@better-ccflare/core";
import { Logger } from "@better-ccflare/logger";
import type { Account, RateLimitReason } from "@better-ccflare/types";
import type { ProxyContext } from "./proxy-types";

const log = new Logger("RateLimitCooldown");

const MATURE_COOLDOWN_STREAK = 5;
const PROBE_LEASE_MS = 2 * 60 * 1000;
const MAX_PROBE_GATES = 10_000;
const probeLeases = new Map<string, number>();

export type RateLimitProbeAdmission =
	| "not_required"
	| "admitted"
	| "suppressed";

function pruneProbeLeases(now: number): void {
	for (const [accountId, leaseUntil] of probeLeases) {
		if (leaseUntil <= now) probeLeases.delete(accountId);
	}
	while (probeLeases.size >= MAX_PROBE_GATES) {
		const oldest = probeLeases.keys().next().value;
		if (oldest === undefined) break;
		probeLeases.delete(oldest);
	}
}

/**
 * Admits one process-local recovery probe after a mature cooldown expires.
 * Ordinary accounts and accounts still cooling down are not gated.
 *
 * Rationale: once an account has racked up a long streak of consecutive
 * 429s, its cooldown expiry is often optimistic relative to the upstream
 * quota window. Letting every concurrently selected request pile onto that
 * account the instant the cooldown clears re-triggers the same 429 storm
 * that produced the streak. Gating to a single in-flight probe lets one
 * request find out whether the account has actually recovered while the
 * rest fall through to the next account in the selection order — provided
 * one is available. If every candidate in the pool is currently suppressed
 * (a single-account pool, or a pool-wide overload storm), there is no next
 * account to fall through to: the caller runs the highest-priority
 * candidate ungated instead (see proxy.ts's "every candidate suppressed"
 * fallback), and this gate suppresses nothing for that request.
 *
 * The gate also arms for any 529 overload cooldown, regardless of streak
 * depth. consecutive_rate_limits is frozen for 529s (see applyRateLimitCooldown)
 * so an account whose failures are exclusively 529s never reaches
 * MATURE_COOLDOWN_STREAK on its own — without this, the single-flight
 * protection could never engage for an all-overload account, and every
 * concurrently selected request would hit it again the instant its (short)
 * cooldown expires.
 */
export function getRateLimitProbeAdmission(
	account: Account,
	now: number = Date.now(),
): RateLimitProbeAdmission {
	const reason = account.rate_limited_reason;
	const isOverload = reason != null && isOverloadReason(reason);
	const expiredMatureCooldown =
		(account.consecutive_rate_limits >= MATURE_COOLDOWN_STREAK || isOverload) &&
		account.rate_limited_until != null &&
		account.rate_limited_until <= now;
	if (!expiredMatureCooldown) return "not_required";

	pruneProbeLeases(now);
	const existingLease = probeLeases.get(account.id);
	if (existingLease && existingLease > now) {
		log.debug(
			`[ccflare] account=${account.name} cooldown_probe_suppressed lease_until=${new Date(existingLease).toISOString()}`,
		);
		return "suppressed";
	}

	const leaseUntil = now + PROBE_LEASE_MS;
	probeLeases.set(account.id, leaseUntil);
	log.info(
		`[ccflare] account=${account.name} cooldown_probe_admitted streak=${account.consecutive_rate_limits} lease_until=${new Date(leaseUntil).toISOString()}`,
	);
	return "admitted";
}

/**
 * Side-effect-free lookahead for `getRateLimitProbeAdmission`: reports
 * whether the account would currently be reported as "suppressed" for a
 * probe, without checking a lease out or pruning expired ones. Used by the
 * account loops in proxy.ts to determine whether every candidate *after*
 * the one about to be attempted would be skipped — if so, the current
 * attempt is the request's actual terminal one, even when it isn't the
 * last index in the pool.
 */
export function wouldSuppressProbe(
	account: Account,
	now: number = Date.now(),
): boolean {
	const reason = account.rate_limited_reason;
	const isOverload = reason != null && isOverloadReason(reason);
	const expiredMatureCooldown =
		(account.consecutive_rate_limits >= MATURE_COOLDOWN_STREAK || isOverload) &&
		account.rate_limited_until != null &&
		account.rate_limited_until <= now;
	if (!expiredMatureCooldown) return false;

	const existingLease = probeLeases.get(account.id);
	return existingLease != null && existingLease > now;
}

/**
 * Releases the single-flight probe lease for an account, if one is held.
 * Must be called on every terminal outcome of a probed request: success
 * (recovered), a fresh cooldown being reapplied, or the request being
 * abandoned (exception, or the account being skipped mid-loop).
 */
export function completeRateLimitProbe(
	account: Account,
	outcome: "recovered" | "cooldown_reapplied" | "abandoned",
): void {
	if (!probeLeases.delete(account.id)) return;
	if (outcome === "recovered") {
		log.info(
			`[ccflare] account=${account.name} cooldown_probe_recovery_success`,
		);
	} else if (outcome === "abandoned") {
		log.debug(`[ccflare] account=${account.name} cooldown_probe_abandoned`);
	}
}

/** Test-only: clears all in-memory probe leases between test cases. */
export function resetRateLimitProbeGatesForTests(): void {
	probeLeases.clear();
}

/**
 * Single entry point for applying an upstream-driven cooldown to an account
 * after a 429 (quota) or 529 (transient overload) response.
 *
 * Cooldown DURATION:
 * - A 429 uses the exponential-backoff ramp capped by the upstream reset (if
 *   any) — `min(resetTime, now + backoff)`. Unchanged by this function's 529
 *   handling.
 * - A reset-less 529 (`upstream_529_overloaded_no_reset`) uses a short fixed
 *   cooldown instead (`computeOverloadCooldownMs`): Anthropic gave no
 *   retry-after for it, so there is no account-specific signal to honor, and
 *   ramping the backoff there only punishes a healthy account for an
 *   upstream-wide overload.
 * - A 529-with-reset (`upstream_529_overloaded_with_reset`) honors Anthropic's
 *   own retry-after directly — `min(resetTime, now + computeOverloadWithResetCapMs())`
 *   — see upstream ccflare#271. This does NOT derive from
 *   computeRateLimitBackoffMs/the 429 streak (unlike before): the streak is
 *   frozen for 529s (see below), so deriving duration from it would silently
 *   drift as more 529s arrive. The cap guards against `resetTime` coming from
 *   the anthropic-ratelimit-unified-reset header — a quota window that can be
 *   hours away (provider.ts:368-380) — rather than a short, real retry-after.
 *
 * Streak (`consecutive_rate_limits`): incremented for 429s only. BOTH 529
 * variants (`isOverloadReason`) leave it untouched — the streak also gates
 * `getRateLimitProbeAdmission`'s single-flight recovery probe (which
 * additionally arms on the overload reason directly, see that function's doc
 * comment), so letting a run of transient overloads inflate it would keep
 * throttling an account's concurrency long after its cooldown (and the
 * overload) has cleared, even though the account itself never hit its own
 * quota.
 *
 * Forward guard: a 529 (either variant) never shortens an active cooldown
 * that already extends past the newly computed one — e.g. a real 429 quota
 * bench that's still running when a 529 arrives mid-window. The longer,
 * already-active bench carries more information than a transient overload
 * does. In that case this function skips every write (in-memory and DB)
 * entirely and only releases the probe lease. This guard is 529-only: the
 * 429 path keeps its existing last-writer-wins behavior. "Never shorten an
 * active cooldown" is not a project-wide invariant to begin with — the
 * successful-response clear in response-processor.ts unconditionally nulls
 * rate_limited_until (even a future one) the moment a response succeeds.
 *
 * Must be called from every 429/529 path (response-processor, model_fallback_429,
 * all_models_exhausted_429, mid-stream sniffer) — never reach into rate_limited_until manually.
 *
 * @param account - The account that just received a 429/529 (mutated in place).
 * @param rateLimitInfo - `resetTime` caps the computed cooldown via min(resetTime, now + backoff)
 *   (429) or min(resetTime, now + cap) (529-with-reset). `remaining` is forwarded to the emitted
 *   RateLimitError (429 path only). `reason` overrides the auto-derived audit reason and
 *   determines which cooldown strategy applies.
 * @param ctx - The proxy context (provides asyncWriter + dbOps).
 */
export function applyRateLimitCooldown(
	account: Account,
	rateLimitInfo: {
		resetTime?: number;
		remaining?: number;
		reason?: RateLimitReason;
	},
	ctx: ProxyContext,
): void {
	const now = Date.now();
	const reason: RateLimitReason =
		rateLimitInfo.reason ??
		(rateLimitInfo.resetTime
			? "upstream_429_with_reset"
			: "upstream_429_no_reset_probe_cooldown");
	const isOverload = isOverloadReason(reason);
	// Only the reset-less 529 gets the fixed short cooldown. A 529-with-reset
	// gets its own capped duration below — see the doc comment above.
	const isOverloadNoReset = reason === "upstream_529_overloaded_no_reset";

	// Best-effort in-memory computation for the 429 ramp. The DB write does the
	// authoritative atomic increment; under parallel 429s the second concurrent
	// request may compute one tier short, but the persisted counter still ramps
	// correctly. Unused for 529s — their duration no longer derives from this
	// (frozen) counter.
	const nextCount = account.consecutive_rate_limits + 1;

	let cooldownUntil: number;
	if (isOverloadNoReset) {
		cooldownUntil = now + computeOverloadCooldownMs();
	} else if (isOverload) {
		const capUntil = now + computeOverloadWithResetCapMs();
		cooldownUntil =
			rateLimitInfo.resetTime != null
				? Math.min(rateLimitInfo.resetTime, capUntil)
				: capUntil;
	} else {
		const backoffMs = computeRateLimitBackoffMs(nextCount);
		const candidateUntil = now + backoffMs;
		cooldownUntil = rateLimitInfo.resetTime
			? Math.min(rateLimitInfo.resetTime, candidateUntil)
			: candidateUntil;
	}

	if (
		isOverload &&
		account.rate_limited_until != null &&
		account.rate_limited_until > cooldownUntil
	) {
		// Forward guard: this 529 found a longer, already-active cooldown (a
		// real 429 quota bench outlives any 529 that arrives while it's
		// running) — don't overwrite it with a shorter overload cooldown.
		// rate_limited_at is deliberately NOT re-stamped here: doing so would
		// delay the stability healing in response-processor.ts (gated on
		// rate_limited_at) on every subsequent 529, even though nothing about
		// the bench itself changed.
		const wasRecoveryProbe = probeLeases.has(account.id);
		completeRateLimitProbe(account, "cooldown_reapplied");
		if (wasRecoveryProbe) {
			log.info(
				`[ccflare] account=${account.name} cooldown_probe_reapplied reason=${reason} until=${new Date(account.rate_limited_until).toISOString()}`,
			);
		}
		log.warn(
			`[ccflare] account=${account.name} upstream_overloaded reason=${reason} found longer active cooldown until=${new Date(account.rate_limited_until).toISOString()} — not overwriting with the shorter 529 cooldown (would have been until=${new Date(cooldownUntil).toISOString()})`,
		);
		return;
	}

	// In-memory update so the rest of this request sees consistent state.
	account.rate_limited_until = cooldownUntil;
	account.rate_limited_at = now;
	account.rate_limited_reason = reason;
	if (!isOverload) {
		account.consecutive_rate_limits = nextCount;
	}
	const wasRecoveryProbe = probeLeases.has(account.id);
	completeRateLimitProbe(account, "cooldown_reapplied");
	if (wasRecoveryProbe) {
		log.info(
			`[ccflare] account=${account.name} cooldown_probe_reapplied reason=${reason} until=${new Date(cooldownUntil).toISOString()}`,
		);
	}

	ctx.asyncWriter.enqueue(async () => {
		const { consecutiveRateLimits: persistedCount, applied } =
			await ctx.dbOps.markAccountRateLimited(
				account.id,
				cooldownUntil,
				reason,
				!isOverload,
			);
		// Reconcile in-memory counter with the authoritative DB value (may differ
		// under concurrent 429s for the same account). Skipped for overload: the
		// streak is not touched by a 529 (with or without reset), so there is
		// nothing to reconcile.
		if (!isOverload) {
			account.consecutive_rate_limits = persistedCount;
		}
		// Log AFTER the DB write so the reported consecutive= reflects the persisted
		// value, and log the outcome the write actually had. A guarded 529 write
		// can be rejected by the repository's forward guard (a concurrent request
		// already set a longer-lived cooldown) — asserting `cooldown_applied` for
		// a write that was in fact skipped left two contradictory log lines for
		// the same event.
		if (applied) {
			log.warn(
				`[ccflare] account=${account.name} cooldown_applied reason=${reason} until=${new Date(cooldownUntil).toISOString()} consecutive=${persistedCount}`,
			);
		} else {
			log.warn(
				`[ccflare] account=${account.name} cooldown_write_skipped reason=${reason} candidate_until=${new Date(cooldownUntil).toISOString()} consecutive=${persistedCount} (existing later cooldown or row absent)`,
			);
		}
	});

	if (isOverload) {
		// A 529 is a transient upstream server state, not a quota signal —
		// emitting a RateLimitError here would misdiagnose it as account
		// exhaustion. Log honestly instead.
		log.warn(
			`[ccflare] account=${account.name} upstream_overloaded reason=${reason} until=${new Date(cooldownUntil).toISOString()} (529 — transient, streak untouched)`,
		);
		return;
	}

	const rateLimitError = new RateLimitError(
		account.id,
		cooldownUntil,
		rateLimitInfo.remaining,
	);
	logError(rateLimitError, log);
}
