import { isAccountAvailable, TIME_CONSTANTS } from "@better-ccflare/core";
import { Logger } from "@better-ccflare/logger";
import type {
	Account,
	LoadBalancingStrategy,
	RequestMeta,
	StrategyStore,
} from "@better-ccflare/types";

export class SessionStrategy implements LoadBalancingStrategy {
	private sessionDurationMs: number;
	private store: StrategyStore | null = null;
	private log = new Logger("SessionStrategy");

	constructor(
		sessionDurationMs: number = TIME_CONSTANTS.SESSION_DURATION_DEFAULT,
	) {
		this.sessionDurationMs = sessionDurationMs;
	}

	initialize(store: StrategyStore): void {
		this.store = store;
	}

	private resetSessionIfExpired(account: Account): void {
		const now = Date.now();

		if (
			!account.session_start ||
			now - account.session_start >= this.sessionDurationMs
		) {
			// Reset session
			if (this.store) {
				const wasExpired = account.session_start !== null;
				this.log.info(
					wasExpired
						? `Session expired for account ${account.name}, starting new session`
						: `Starting new session for account ${account.name}`,
				);
				this.store.resetAccountSession(account.id, now);

				// Update the account object to reflect changes
				account.session_start = now;
				account.session_request_count = 0;
			}
		}
	}

	select(accounts: Account[], _meta: RequestMeta): Account[] {
		const now = Date.now();

		// Check for higher priority accounts that have become available due to rate limit reset
		const fallbackCandidates = this.checkForAutoFallbackAccounts(accounts, now);
		if (fallbackCandidates.length > 0) {
			const chosenFallback = fallbackCandidates[0];
			this.resetSessionIfExpired(chosenFallback);
			this.log.info(
				`Auto-fallback triggered to account ${chosenFallback.name} (priority: ${chosenFallback.priority}, auto-fallback enabled)`,
			);

			// Return fallback account first, then others sorted by priority
			const others = accounts
				.filter((a) => a.id !== chosenFallback.id && isAccountAvailable(a, now))
				.sort((a, b) => a.priority - b.priority);
			return [chosenFallback, ...others];
		}

		// Find account with active session (most recent session_start within window)
		let activeAccount: Account | null = null;
		let mostRecentSessionStart = 0;

		for (const account of accounts) {
			if (
				account.session_start &&
				now - account.session_start < this.sessionDurationMs &&
				account.session_start > mostRecentSessionStart
			) {
				activeAccount = account;
				mostRecentSessionStart = account.session_start;
			}
		}

		// If we have an active account and it's available, use it exclusively
		if (activeAccount && isAccountAvailable(activeAccount, now)) {
			// Reset session if expired (shouldn't happen but just in case)
			this.resetSessionIfExpired(activeAccount);
			this.log.info(
				`Continuing session for account ${activeAccount.name} (${activeAccount.session_request_count} requests in session)`,
			);
			// Return active account first, then others as fallback (sorted by priority)
			const others = accounts
				.filter((a) => a.id !== activeAccount.id && isAccountAvailable(a, now))
				.sort((a, b) => a.priority - b.priority);
			return [activeAccount, ...others];
		}

		// No active session or active account is rate limited
		// Filter available accounts and sort by priority (lower number = higher priority)
		const available = accounts
			.filter((a) => isAccountAvailable(a, now))
			.sort((a, b) => a.priority - b.priority);

		if (available.length === 0) return [];

		// Pick the highest priority account (first in sorted list) and start a new session with it
		const chosenAccount = available[0];
		this.resetSessionIfExpired(chosenAccount);

		// Return chosen account first, then others as fallback (already sorted by priority)
		const others = available.filter((a) => a.id !== chosenAccount.id);
		return [chosenAccount, ...others];
	}

	/**
	 * Check for higher priority accounts that have auto-fallback enabled and have become available
	 * due to rate limit reset
	 */
	private checkForAutoFallbackAccounts(
		accounts: Account[],
		now: number,
	): Account[] {
		// Find accounts with auto-fallback enabled that:
		// 1. Have an API reset time that has passed (usage window has reset)
		// 2. Are not currently paused
		// 3. Are not currently in a rate limited state (rate_limited_until is in the past or null)
		const resetAccounts = accounts.filter((account) => {
			if (!account.auto_fallback_enabled) return false;
			if (account.paused) return false;

			// Check if the API usage window has reset
			const windowReset =
				account.rate_limit_reset && account.rate_limit_reset <= now;

			// Check if the account is not currently rate limited by our system
			const notRateLimited =
				!account.rate_limited_until || account.rate_limited_until <= now;

			return windowReset && notRateLimited;
		});

		if (resetAccounts.length === 0) return [];

		// Sort by priority (lower number = higher priority)
		return resetAccounts.sort((a, b) => a.priority - b.priority);
	}
}
