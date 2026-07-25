import {
	computeOverloadCooldownMs,
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
 * rest fall through to the next account in the selection order.
 */
export function getRateLimitProbeAdmission(
	account: Account,
	now: number = Date.now(),
): RateLimitProbeAdmission {
	const expiredMatureCooldown =
		account.consecutive_rate_limits >= MATURE_COOLDOWN_STREAK &&
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
 * Cooldown DURATION: a 429 and a 529-with-reset both use the exponential-backoff
 * ramp capped by the upstream reset (if any) — `min(resetTime, now + backoff)`.
 * A reset-less 529 (`upstream_529_overloaded_no_reset`) uses a short fixed
 * cooldown instead (`computeOverloadCooldownMs`): Anthropic gave no retry-after
 * for it, so there is no account-specific signal to honor, and ramping the
 * backoff there only punishes a healthy account for an upstream-wide overload.
 * A 529-with-reset DOES carry Anthropic's retry-after and must not be
 * shortened — see upstream ccflare#271.
 *
 * Streak (`consecutive_rate_limits`): incremented for 429s only. BOTH 529
 * variants (`isOverloadReason`) leave it untouched — the streak also gates
 * `getRateLimitProbeAdmission`'s single-flight recovery probe, so letting a
 * run of transient overloads inflate it would keep throttling an account's
 * concurrency long after its cooldown (and the overload) has cleared, even
 * though the account itself never hit its own quota.
 *
 * Must be called from every 429/529 path (response-processor, model_fallback_429,
 * all_models_exhausted_429, mid-stream sniffer) — never reach into rate_limited_until manually.
 *
 * @param account - The account that just received a 429/529 (mutated in place).
 * @param rateLimitInfo - `resetTime` caps the computed cooldown via min(resetTime, now + backoff).
 *   `remaining` is forwarded to the emitted RateLimitError (429 path only). `reason` overrides the
 *   auto-derived audit reason and determines which cooldown strategy applies.
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
	// carries Anthropic's own retry-after and must keep the normal ramp-capped
	// formula below — shortening it would undercut a real upstream signal.
	const isOverloadNoReset = reason === "upstream_529_overloaded_no_reset";

	// Best-effort in-memory computation. The DB write does the authoritative atomic
	// increment; under parallel 429s the second concurrent request may compute one
	// tier short, but the persisted counter still ramps correctly. For 529s this
	// increment is hypothetical (used only to drive the with-reset duration
	// formula below) and is never persisted to consecutive_rate_limits.
	const nextCount = account.consecutive_rate_limits + 1;
	const backoffMs = isOverloadNoReset
		? computeOverloadCooldownMs()
		: computeRateLimitBackoffMs(nextCount);
	const candidateUntil = now + backoffMs;
	const cooldownUntil = rateLimitInfo.resetTime
		? Math.min(rateLimitInfo.resetTime, candidateUntil)
		: candidateUntil;

	// In-memory update so the rest of this request sees consistent state.
	account.rate_limited_until = cooldownUntil;
	account.rate_limited_at = now;
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
		const persistedCount = await ctx.dbOps.markAccountRateLimited(
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
		// Log AFTER the DB write so the reported consecutive= reflects the persisted value.
		log.warn(
			`[ccflare] account=${account.name} cooldown_applied reason=${reason} until=${new Date(cooldownUntil).toISOString()} consecutive=${persistedCount}`,
		);
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
