/**
 * Per-account circuit breaker core state machine.
 *
 * Background: this morning (2026-07-09) a single provider overload became a
 * fleet-wide retry storm — 30+ sessions independently hammering an overloaded
 * upstream at 187 watchdog-amplified calls/hour. Every retry still paid the
 * full network + auth cost before seeing the same 529 again, and the
 * watchdog kept amplifying because nothing was actually shedding load.
 *
 * This module is the **state machine only**. It is NOT wired into the proxy
 * path on purpose — a follow-up task will integrate it with proxy.ts and
 * response-handler.ts. Wiring is deferred so this change stays atomic and
 * reviewable.
 *
 * State machine: `closed -> open -> half-open -> (closed | open)`.
 *
 *   closed     — happy path. recordFailure(kind) increments a per-key
 *                failure counter; after `FAILURE_THRESHOLD` consecutive
 *                failures the key transitions to `open`.
 *   open       — fail fast. `shouldAllow(key)` returns false until
 *                `cooldownEndsAt` is reached.
 *   half-open  — admit EXACTLY ONE probe request. Success closes + resets
 *                the counter. Failure re-opens with exponential backoff
 *                capped at `HALF_OPEN_BACKOFF_MAX_MS`.
 *
 * Keying: `(provider, accountId)`. A bad account never takes down healthy
 * accounts of the same provider — that is the entire point of per-key
 * keying. The module also exposes `isProviderWideOpen(provider)` so a
 * caller may treat a provider as fully down once every tracked account
 * for it is open.
 *
 * Time: every method accepts an injected `now` (default `Date.now()`).
 * No real timers in unit tests.
 */
import { Logger } from "@better-ccflare/logger";

const log = new Logger("CircuitBreaker");

export const CIRCUIT_BREAKER_ENV = "CCFLARE_CIRCUIT_BREAKER";

/**
 * Defaults — chosen to fail fast on a real overload while leaving room for
 * ordinary 429 bursts (e.g. a single hot model) to recover without
 * fail-fast shedding.
 *
 * - FAILURE_THRESHOLD = 5 consecutive failures: a single anomalous 429 is
 *   not enough to fail-fast a healthy account; a genuine overload produces
 *   a tight cluster of identical failures. Five is low enough to open
 *   within seconds of a real incident, high enough to ride out ordinary
 *   per-model jitter.
 * - OPEN_COOLDOWN_MS = 30s: short enough that a transient overload does
 *   not bench the account for long, long enough to drain a real burst.
 *   Once open, `shouldAllow` is false for ~30s before the first probe —
 *   that is the only "fail fast" guarantee.
 * - HALF_OPEN_BACKOFF_MAX_MS = 5min: cap on the exponential backoff after
 *   a probe failure. Keeps the worst-case recovery bounded; matches the
 *   repo's existing 5min rate-limit backoff ceiling (TIME_CONSTANTS.
 *   RATE_LIMIT_BACKOFF_MAX_MS).
 */
const FAILURE_THRESHOLD = 5;
const OPEN_COOLDOWN_MS = 30_000;
const HALF_OPEN_BACKOFF_MAX_MS = 5 * 60 * 1000;
/** Memory bound for tracked (provider, accountId) keys. */
const MAX_TRACKED_KEYS = 4_096;

/** Read an env var defensively — matches the @better-ccflare/logger idiom.
 *  Bun injects `process` automatically; the `declare` keeps tsc happy in
 *  environments without @types/node, the runtime guard keeps it portable. */
declare const process: { env: Record<string, string | undefined> } | undefined;
function readEnv(name: string): string | undefined {
	if (typeof process === "undefined" || !process.env) return undefined;
	return process.env[name];
}

/**
 * Categorizes an upstream failure for circuit-breaker accounting. The
 * caller is responsible for mapping the upstream signal (HTTP status,
 * `rateLimitedReason`, etc.) to one of these kinds BEFORE calling
 * `recordFailure`. Keeping the mapping at the call site lets the breaker
 * stay oblivious to provider-specific wire formats.
 */
export type FailureKind =
	/** 529 overloaded_error — genuine upstream-capacity signal. */
	| "overload_529"
	/**
	 * 429 with account/provider-wide exhaustion (e.g. `upstream_429_with_reset`,
	 * `upstream_429_no_reset_*`, `all_models_exhausted_429`). Counts toward
	 * opening the circuit.
	 */
	| "rate_limit_429_global"
	/**
	 * 429 limited to one model on an account that can still serve other
	 * models via `modelMappings`. Recorded by ccflare as
	 * `rateLimitedReason === "model_fallback_429"` — currently LIVE on
	 * ccmax. See `shouldCountAsCircuitFailure` below.
	 */
	| "rate_limit_429_model_scoped";

export type CircuitState = "closed" | "open" | "half-open";

export interface CircuitKey {
	provider: string;
	accountId: string;
}

export interface CircuitSnapshotEntry {
	key: string;
	provider: string;
	accountId: string;
	state: CircuitState;
	failureCount: number;
	openedAt: number | null;
	cooldownEndsAt: number | null;
	halfOpenProbeInFlight: boolean;
}

interface CircuitEntry {
	provider: string;
	accountId: string;
	state: CircuitState;
	failureCount: number;
	openedAt: number | null;
	cooldownEndsAt: number | null;
	/** Last cooldown duration (ms) for half-open backoff progression. */
	previousCooldownMs: number;
	halfOpenProbeInFlight: boolean;
}

/**
 * THE critical predicate: should this failure trip the circuit?
 *
 * `rate_limit_429_model_scoped` is recorded by ccflare when an account has
 * `modelMappings` and is 429ed on ONE of its mapped models but can still
 * serve others — the upstream is not exhausted, the account is not
 * unhealthy, only that one model is rate-limited. ccflare's client-side
 * model fallback (the rewrite-to-another-model path on the same account)
 * is the recovery mechanism for exactly this case. If the breaker opens
 * the circuit here it destroys that fallback path — the request is
 * fail-fast rejected before the model rewrite ever happens — which is the
 * unacceptable regression the breaker exists to prevent.
 *
 * Exhaustion-shaped 429s (`rate_limit_429_global`) and 529 overload
 * remain circuit failures.
 *
 * Returns true ONLY for kinds that count toward opening the circuit.
 */
export function shouldCountAsCircuitFailure(kind: FailureKind): boolean {
	if (kind === "rate_limit_429_model_scoped") return false;
	return true;
}

function readEnabledFlag(envValue: string | undefined): boolean {
	// Default ON. CCFLARE_CIRCUIT_BREAKER=0 (or "false") disables. Anything
	// else (unset, empty, "1", "true") keeps it on.
	if (envValue === undefined || envValue === "") return true;
	const v = envValue.trim().toLowerCase();
	return v !== "0" && v !== "false";
}

function makeKey(provider: string, accountId: string): string {
	// `:` is the only delimiter — account IDs in this repo are UUIDs or
	// short slugs and never contain `:`. The matching split lives in
	// snapshot() below; if account IDs ever grow colons, switch both
	// sides to an unambiguous separator.
	return `${provider}:${accountId}`;
}

export class CircuitBreaker {
	private readonly failureThreshold: number;
	private readonly openCooldownMs: number;
	private readonly halfOpenBackoffMaxMs: number;
	private readonly enabled: boolean;
	private readonly entries = new Map<string, CircuitEntry>();

	constructor(opts?: {
		failureThreshold?: number;
		openCooldownMs?: number;
		halfOpenBackoffMaxMs?: number;
		enabled?: boolean;
	}) {
		this.failureThreshold =
			opts?.failureThreshold ?? FAILURE_THRESHOLD;
		this.openCooldownMs = opts?.openCooldownMs ?? OPEN_COOLDOWN_MS;
		this.halfOpenBackoffMaxMs =
			opts?.halfOpenBackoffMaxMs ?? HALF_OPEN_BACKOFF_MAX_MS;
		this.enabled = opts?.enabled ?? readEnabledFlag(readEnv(CIRCUIT_BREAKER_ENV));
	}

	isEnabled(): boolean {
		return this.enabled;
	}

	/**
	 * Should the breaker let this request through right now? When disabled
	 * (env kill-switch) this is always a pass-through.
	 *
	 * Side effect: when an `open` circuit's cooldown has elapsed, the
	 * first call transitions it to `half-open` and admits the probe. The
	 * second concurrent call in the same half-open window is rejected —
	 * that is what "EXACTLY ONE probe" means.
	 */
	shouldAllow(key: CircuitKey, now: number = Date.now()): boolean {
		if (!this.enabled) return true;
		const composite = makeKey(key.provider, key.accountId);
		const entry = this.entries.get(composite);
		if (!entry) return true;
		if (entry.state === "closed") return true;
		if (entry.state === "open") {
			if (entry.cooldownEndsAt === null || now < entry.cooldownEndsAt) {
				return false;
			}
			// Cooldown elapsed — promote to half-open and admit the probe.
			entry.state = "half-open";
			entry.halfOpenProbeInFlight = true;
			log.info(
				`circuit_half_open provider=${entry.provider} account=${entry.accountId} after_ms=${now - (entry.openedAt ?? now)}`,
			);
			return true;
		}
		// half-open: exactly one probe in flight.
		if (entry.halfOpenProbeInFlight) return false;
		entry.halfOpenProbeInFlight = true;
		return true;
	}

	/**
	 * Record a success. In `half-open` this closes the circuit and resets
	 * all counters. In `closed` it clears the failure streak so the next
	 * failure starts at zero. In `open` it is a no-op (shouldAllow never
	 * admitted the request).
	 */
	recordSuccess(key: CircuitKey, _now: number = Date.now()): void {
		if (!this.enabled) return;
		const composite = makeKey(key.provider, key.accountId);
		const entry = this.entries.get(composite);
		if (!entry) return;
		if (entry.state === "half-open") {
			this.resetEntry(entry);
			log.info(
				`circuit_closed provider=${entry.provider} account=${entry.accountId} reason=probe_success`,
			);
			return;
		}
		if (entry.state === "closed" && entry.failureCount > 0) {
			entry.failureCount = 0;
			return;
		}
	}

	/**
	 * Record a failure. Failures of kind `rate_limit_429_model_scoped` are
	 * NOT counted (see `shouldCountAsCircuitFailure`); the breaker stays
	 * closed because client-side model fallback handles that case.
	 *
	 * In `closed`: increments the failure counter and transitions to
	 * `open` at `failureThreshold`.
	 *
	 * In `half-open`: the probe failed — re-open with exponential
	 * backoff (2x previous cooldown, capped at halfOpenBackoffMaxMs).
	 *
	 * In `open`: shouldAllow already rejected the request, so this can
	 * only happen from a stale caller; counted anyway as a streak
	 * refresh so the cooldown window extends if upstream is still down.
	 */
	recordFailure(
		key: CircuitKey,
		kind: FailureKind,
		now: number = Date.now(),
	): void {
		if (!this.enabled) return;
		if (!shouldCountAsCircuitFailure(kind)) {
			// Model-scoped 429: do not let this tip the breaker. The
			// client-side fallback path is the recovery mechanism.
			return;
		}

		const composite = makeKey(key.provider, key.accountId);
		let entry = this.entries.get(composite);
		if (!entry) {
			entry = {
				provider: key.provider,
				accountId: key.accountId,
				state: "closed",
				failureCount: 0,
				openedAt: null,
				cooldownEndsAt: null,
				previousCooldownMs: this.openCooldownMs,
				halfOpenProbeInFlight: false,
			};
			this.entries.set(composite, entry);
			this.evictIfOverCapacity(composite);
		}

		if (entry.state === "half-open") {
			const nextCooldownMs = Math.min(
				entry.previousCooldownMs * 2,
				this.halfOpenBackoffMaxMs,
			);
			entry.state = "open";
			entry.openedAt = now;
			entry.cooldownEndsAt = now + nextCooldownMs;
			entry.previousCooldownMs = nextCooldownMs;
			entry.halfOpenProbeInFlight = false;
			log.warn(
				`circuit_reopened provider=${entry.provider} account=${entry.accountId} cooldown_ms=${nextCooldownMs} reason=probe_failure`,
			);
			return;
		}

		if (entry.state === "open") {
			// Streak refresh: extend the cooldown rather than letting a
			// stuck caller reset it by going silent.
			entry.cooldownEndsAt = now + this.openCooldownMs;
			entry.openedAt = now;
			return;
		}

		// closed → maybe open
		entry.failureCount++;
		if (entry.failureCount >= this.failureThreshold) {
			entry.state = "open";
			entry.openedAt = now;
			entry.cooldownEndsAt = now + this.openCooldownMs;
			entry.previousCooldownMs = this.openCooldownMs;
			log.warn(
				`circuit_open provider=${entry.provider} account=${entry.accountId} failures=${entry.failureCount} kind=${kind}`,
			);
		}
	}

	getState(key: CircuitKey): CircuitState {
		if (!this.enabled) return "closed";
		const entry = this.entries.get(makeKey(key.provider, key.accountId));
		return entry?.state ?? "closed";
	}

	/**
	 * True iff at least two accounts for `provider` are tracked AND every
	 * tracked account for that provider is currently `open`. A single open
	 * account is NOT enough — there may be healthy accounts we haven't
	 * observed yet, and "treat the whole provider as down" is too
	 * aggressive a stance for that case. Requiring at least two tracked
	 * accounts makes "all are open" a meaningful signal.
	 *
	 * Half-open and closed accounts keep the provider from being marked
	 * wide-open — the caller can still attempt a probe on a candidate that
	 * is not currently open.
	 */
	isProviderWideOpen(provider: string): boolean {
		if (!this.enabled) return false;
		let trackedForProvider = 0;
		for (const entry of this.entries.values()) {
			if (entry.provider !== provider) continue;
			trackedForProvider++;
			if (entry.state !== "open") return false;
		}
		return trackedForProvider >= 2;
	}

	/** JSON-serializable snapshot. A later task exposes this via HTTP. */
	snapshot(): CircuitSnapshotEntry[] {
		const out: CircuitSnapshotEntry[] = [];
		for (const [composite, entry] of this.entries.entries()) {
			out.push({
				key: composite,
				provider: entry.provider,
				accountId: entry.accountId,
				state: entry.state,
				failureCount: entry.failureCount,
				openedAt: entry.openedAt,
				cooldownEndsAt: entry.cooldownEndsAt,
				halfOpenProbeInFlight: entry.halfOpenProbeInFlight,
			});
		}
		return out;
	}

	/** Test hook: clear all tracked state. */
	resetAll(): void {
		this.entries.clear();
	}

	private resetEntry(entry: CircuitEntry): void {
		entry.state = "closed";
		entry.failureCount = 0;
		entry.openedAt = null;
		entry.cooldownEndsAt = null;
		entry.previousCooldownMs = this.openCooldownMs;
		entry.halfOpenProbeInFlight = false;
	}

	private evictIfOverCapacity(protectedKey: string): void {
		if (this.entries.size <= MAX_TRACKED_KEYS) return;
		// Drop the oldest-inserted key that isn't the one we just added.
		// Insertion order is preserved by Map; the protected key is the
		// most-recently inserted, so the first key from the iterator is
		// the oldest non-protected entry.
		for (const oldKey of this.entries.keys()) {
			if (oldKey === protectedKey) continue;
			this.entries.delete(oldKey);
			break;
		}
	}
}

let _default: CircuitBreaker | null = null;

/** Lazily-constructed default breaker; reads CCFLARE_CIRCUIT_BREAKER at first use. */
export function getDefaultCircuitBreaker(): CircuitBreaker {
	if (!_default) _default = new CircuitBreaker();
	return _default;
}

/** Test hook: drop the default breaker so the next call rebuilds from env. */
export function resetDefaultCircuitBreaker(): void {
	_default = null;
}

// Module-level convenience API on the default breaker. Tests construct
// their own CircuitBreaker instances and ignore these.
export function shouldAllow(key: CircuitKey, now?: number): boolean {
	return getDefaultCircuitBreaker().shouldAllow(key, now);
}

export function recordSuccess(key: CircuitKey, now?: number): void {
	getDefaultCircuitBreaker().recordSuccess(key, now);
}

export function recordFailure(
	key: CircuitKey,
	kind: FailureKind,
	now?: number,
): void {
	getDefaultCircuitBreaker().recordFailure(key, kind, now);
}

export function getState(key: CircuitKey): CircuitState {
	return getDefaultCircuitBreaker().getState(key);
}

export function isProviderWideOpen(provider: string): boolean {
	return getDefaultCircuitBreaker().isProviderWideOpen(provider);
}

export function snapshot(): CircuitSnapshotEntry[] {
	return getDefaultCircuitBreaker().snapshot();
}