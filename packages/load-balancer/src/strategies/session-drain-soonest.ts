import { isAccountAvailable, TIME_CONSTANTS } from "@better-ccflare/core";
import { Logger } from "@better-ccflare/logger";
import type {
	Account,
	LoadBalancingStrategy,
	RequestMeta,
	StrategyStore,
} from "@better-ccflare/types";
import {
	PROVIDER_NAMES,
	requiresSessionDurationTracking,
} from "@better-ccflare/types";
import { isPeekAvailable } from "./peek-availability";

/**
 * SessionDrainSoonestStrategy — identical session-affinity semantics to
 * {@link SessionStrategy} (same 5h Anthropic session window, same
 * rate-limit-window-reset session invalidation, same auto-fallback
 * reactivation) EXCEPT it has no priority-based preemption: an active,
 * available, non-expired session is NEVER interrupted, regardless of any
 * other account's priority or weekly reset. The ranking of *which* account
 * to prefer only applies at re-selection time (session start, session
 * expiry, or the active account becoming unavailable) and is driven by each
 * account's weekly_all usage-window reset time instead of a static
 * `priority` field:
 *
 *   - Accounts whose weekly_all window resets SOONER are preferred over ones
 *     that reset later, so unused weekly capacity gets drained before it is
 *     replaced by a fresh (unrelated) allowance — "use it or lose it".
 *   - Accounts with an unknown/expired reset (no usage telemetry yet, or the
 *     provider doesn't expose a weekly_all window) sort last, behind every
 *     account with a known future reset.
 *   - Ties (equal reset, or both unknown) fall back to `priority` ASC, then
 *     upstream utilization ASC — identical tie-break order to SessionStrategy.
 *
 * Auto-fallback reactivation is a priority rule that overrides drain-soonest
 * ranking: the chosen fallback account (first available candidate from
 * checkForAutoFallbackAccounts, in priority order) is always placed at
 * position 0 of select()'s return value, even when another available
 * account has an earlier weekly reset.
 *
 * peek() mirrors select()'s decision exactly (same requirement as every
 * other strategy here) since the dashboard's "Primary" badge is driven by it.
 */
export class SessionDrainSoonestStrategy implements LoadBalancingStrategy {
	private sessionDurationMs: number;
	private store: StrategyStore | null = null;
	private log = new Logger("SessionDrainSoonestStrategy");

	constructor(
		sessionDurationMs: number = TIME_CONSTANTS.ANTHROPIC_SESSION_DURATION_DEFAULT,
	) {
		this.sessionDurationMs = sessionDurationMs;
	}

	initialize(store: StrategyStore): void {
		this.store = store;
	}

	/**
	 * Weekly_all reset time (epoch ms) for the account, or null when unknown
	 * OR already in the past (stale telemetry that hasn't caught up to a
	 * reset that already happened — treated the same as "no data" rather than
	 * ranked as if it were the soonest reset).
	 */
	private getWeeklyReset(account: Account, now: number): number | null {
		const reset =
			this.store?.getAccountWeeklyReset?.(account.id, account.provider) ?? null;
		if (reset === null || reset <= now) return null;
		return reset;
	}

	/**
	 * Rank comparator: earliest future weekly_all reset first (unknown last),
	 * then priority ASC, then utilization ASC. Shared by both peek() and
	 * select() so the two never disagree on ordering.
	 */
	private compareAccounts(a: Account, b: Account, now: number): number {
		const resetA = this.getWeeklyReset(a, now);
		const resetB = this.getWeeklyReset(b, now);
		if (resetA !== resetB) {
			if (resetA === null) return 1;
			if (resetB === null) return -1;
			return resetA - resetB;
		}
		if (a.priority !== b.priority) return a.priority - b.priority;
		const utilA = this.store?.getAccountUtilization?.(a.id, a.provider) ?? 0;
		const utilB = this.store?.getAccountUtilization?.(b.id, b.provider) ?? 0;
		return utilA - utilB;
	}

	private resetSessionIfExpired(account: Account): void {
		const now = Date.now();

		const fixedDurationExpired =
			requiresSessionDurationTracking(account.provider) &&
			(!account.session_start ||
				now - account.session_start >= this.sessionDurationMs);

		const rateLimitWindowReset =
			account.provider === PROVIDER_NAMES.ANTHROPIC &&
			account.rate_limit_reset &&
			account.rate_limit_reset < now - 1000; // 1 second buffer for clock skew protection

		if (fixedDurationExpired || rateLimitWindowReset) {
			if (this.store) {
				const wasExpired = account.session_start !== null;
				const resetReason = rateLimitWindowReset
					? "rate limit window reset"
					: "fixed duration expired";
				this.log.info(
					wasExpired
						? `Session expired for account ${account.name} due to ${resetReason}, starting new session`
						: `Starting new session for account ${account.name}`,
				);
				this.store.resetAccountSession(account.id, now);

				account.session_start = now;
				account.session_request_count = 0;
			}
		}
	}

	/**
	 * Determines if an account has an active session based on provider requirements.
	 * Identical semantics to SessionStrategy.hasActiveSession — see that file
	 * for the full rationale on the rate-limited-but-in-window carve-out.
	 */
	private hasActiveSession(account: Account, now: number): boolean {
		if (!requiresSessionDurationTracking(account.provider)) {
			return false;
		}

		if (account.rate_limited_until && account.rate_limited_until > now) {
			return false;
		}

		return (
			!!account.session_start &&
			now - account.session_start < this.sessionDurationMs
		);
	}

	peek(accounts: Account[]): string | null {
		const now = Date.now();

		const isAvailable = (account: Account): boolean =>
			isPeekAvailable(account, now);

		// Mirror select()'s auto-fallback path, without unpausing. select()
		// walks fallbackCandidates in priority order and forces the first
		// available one to position 0 regardless of drain ranking — peek must
		// return that exact id, not just the drain-soonest winner among all
		// available accounts.
		const fallbackCandidates = this.checkForAutoFallbackAccounts(accounts, now);
		const chosenFallback = fallbackCandidates.find((c) => isAvailable(c));
		if (chosenFallback) {
			return chosenFallback.id;
		}

		let activeAccount: Account | null = null;
		let mostRecentSessionStart = 0;
		for (const account of accounts) {
			if (
				this.hasActiveSession(account, now) &&
				account.session_start &&
				account.session_start > mostRecentSessionStart
			) {
				activeAccount = account;
				mostRecentSessionStart = account.session_start;
			}
		}

		// An active, available session is never preempted by drain-soonest
		// ranking — it always wins re-selection, no matter how much earlier
		// another candidate's weekly reset is.
		if (activeAccount && isAvailable(activeAccount)) {
			return activeAccount.id;
		}

		const available = accounts
			.filter((a) => isAvailable(a))
			.sort((a, b) => this.compareAccounts(a, b, now));

		return available[0]?.id ?? null;
	}

	select(accounts: Account[], meta: RequestMeta): Account[] {
		const now = Date.now();

		const bypassHeader = meta.headers?.get("x-better-ccflare-bypass-session");
		const bypassSession = bypassHeader === "true";

		this.log.info(
			`Bypass header: ${bypassHeader}, bypassSession: ${bypassSession}`,
		);

		if (bypassSession) {
			this.log.info("Session tracking bypassed due to bypass header");
		}

		const availabilityCache = new Map<string, boolean>();
		const getCachedAvailability = (account: Account): boolean => {
			if (!availabilityCache.has(account.id)) {
				availabilityCache.set(account.id, isAccountAvailable(account, now));
			}
			return availabilityCache.get(account.id) || false;
		};

		const fallbackCandidates = this.checkForAutoFallbackAccounts(accounts, now);
		let chosenFallback: Account | null = null;
		const skippedByReason = new Map<string, string[]>();
		for (const candidate of fallbackCandidates) {
			if (candidate.paused && this.store?.resumeAccount) {
				const canAutoUnpause =
					!candidate.pause_reason ||
					candidate.pause_reason === "overage" ||
					candidate.pause_reason === "rate_limit_window";
				if (canAutoUnpause) {
					this.log.info(
						`Unpausing account ${candidate.name} due to auto-fallback reactivation`,
					);
					this.store.resumeAccount(candidate.id);
					candidate.paused = false;
					availabilityCache.delete(candidate.id);
				} else {
					const reason = candidate.pause_reason || "unknown";
					if (!skippedByReason.has(reason)) {
						skippedByReason.set(reason, []);
					}
					skippedByReason.get(reason)?.push(candidate.name);
					continue;
				}
			}

			if (getCachedAvailability(candidate)) {
				chosenFallback = candidate;
				break;
			}
		}

		for (const [reason, names] of skippedByReason) {
			this.log.info(
				`Skipping auto-unpause of ${names.length} account(s) paused for '${reason}': ${names.join(", ")}`,
			);
		}

		if (chosenFallback !== null) {
			if (!bypassSession) {
				this.resetSessionIfExpired(chosenFallback);
			}
			this.log.info(
				`Auto-fallback triggered to account ${chosenFallback.name} (priority: ${chosenFallback.priority}, auto-fallback enabled)`,
			);
			// chosenFallback is forced to position 0 — auto-fallback is a
			// priority rule that overrides drain-soonest ranking. The rest of
			// the available pool is drain-sorted behind it.
			const others = accounts
				.filter((a) => a.id !== chosenFallback.id && getCachedAvailability(a))
				.sort((a, b) => this.compareAccounts(a, b, now));
			return [chosenFallback, ...others];
		}

		let activeAccount: Account | null = null;
		let mostRecentSessionStart = 0;

		for (const account of accounts) {
			if (
				this.hasActiveSession(account, now) &&
				account.session_start &&
				account.session_start > mostRecentSessionStart
			) {
				activeAccount = account;
				mostRecentSessionStart = account.session_start;
			}
		}

		if (activeAccount) {
			this.log.debug(
				`Active session found for account ${activeAccount.name} (provider: ${activeAccount.provider})`,
			);
		} else {
			this.log.debug(
				`No active sessions found, will select from available accounts`,
			);
		}

		// An active, available session is NEVER preempted — no priority-based
		// override (unlike SessionStrategy) and no drain-soonest override
		// either. Drain-soonest ranking only governs which account is
		// (re-)selected when there is no active session, or the active
		// account has become unavailable.
		if (activeAccount && getCachedAvailability(activeAccount)) {
			if (!bypassSession) {
				this.resetSessionIfExpired(activeAccount);
			}
			this.log.info(
				`Continuing session for account ${activeAccount.name} (${activeAccount.session_request_count} requests in session)`,
			);
			const others = accounts
				.filter((a) => a.id !== activeAccount.id && getCachedAvailability(a))
				.sort((a, b) => this.compareAccounts(a, b, now));
			return [activeAccount, ...others];
		}

		// No active session, or the active account is unavailable. Filter
		// available accounts and rank by drain-soonest (earliest weekly
		// reset, then priority, then utilization).
		const available = accounts
			.filter((a) => getCachedAvailability(a))
			.sort((a, b) => this.compareAccounts(a, b, now));

		if (available.length === 0) return [];

		const chosenAccount = available[0];
		if (!bypassSession) {
			this.resetSessionIfExpired(chosenAccount);
		}

		const others = available.filter((a) => a.id !== chosenAccount.id);
		return [chosenAccount, ...others];
	}

	/**
	 * Check for higher priority accounts that have auto-fallback enabled and
	 * have become available due to rate limit reset. Identical to
	 * SessionStrategy.checkForAutoFallbackAccounts — this determines which
	 * *unavailable* accounts should be probed for reactivation, which is
	 * orthogonal to the drain-soonest ranking used for already-available
	 * accounts, so it intentionally keeps priority-based ordering.
	 */
	private checkForAutoFallbackAccounts(
		accounts: Account[],
		now: number,
	): Account[] {
		const resetAccounts = accounts.filter((account) => {
			if (!account.auto_fallback_enabled) return false;

			const supportsWindowReset =
				account.provider === PROVIDER_NAMES.ANTHROPIC ||
				account.provider === PROVIDER_NAMES.CODEX ||
				account.provider === PROVIDER_NAMES.ZAI;
			const providerWindowReset =
				supportsWindowReset &&
				account.rate_limit_reset &&
				account.rate_limit_reset < now - 1000; // 1 second buffer for clock skew protection

			const notRateLimited =
				!account.rate_limited_until || account.rate_limited_until <= now;

			return providerWindowReset && notRateLimited;
		});

		if (resetAccounts.length === 0) return [];

		return resetAccounts.sort((a, b) => a.priority - b.priority);
	}
}
