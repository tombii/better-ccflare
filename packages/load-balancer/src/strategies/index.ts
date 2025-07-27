import type {
	Account,
	LoadBalancingStrategy,
	RequestMeta,
	StrategyStore,
} from "@claudeflare/core";
import { isAccountAvailable } from "@claudeflare/core";

export class RoundRobinStrategy implements LoadBalancingStrategy {
	private cursor = 0;

	select(accounts: Account[], _meta: RequestMeta): Account[] {
		const now = Date.now();
		const available = accounts.filter((a) => isAccountAvailable(a, now));

		if (available.length === 0) return [];

		// Ensure cursor is within bounds
		this.cursor = this.cursor % available.length;

		// Create ordered array starting from cursor position
		const ordered = [
			...available.slice(this.cursor),
			...available.slice(0, this.cursor),
		];

		// Move cursor for next request
		this.cursor = (this.cursor + 1) % available.length;

		return ordered;
	}
}

export class LeastRequestsStrategy implements LoadBalancingStrategy {
	select(accounts: Account[], _meta: RequestMeta): Account[] {
		const now = Date.now();
		const available = accounts.filter((a) => isAccountAvailable(a, now));

		if (available.length === 0) return [];

		// Sort by request count (ascending)
		return available.sort((a, b) => a.request_count - b.request_count);
	}
}

export class SessionStrategy implements LoadBalancingStrategy {
	private sessionDurationMs: number;
	private store: StrategyStore | null = null;

	constructor(sessionDurationMs: number = 5 * 60 * 60 * 1000) {
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
				this.store.resetAccountSession(account.id, now);

				// Update the account object to reflect changes
				account.session_start = now;
				account.session_request_count = 0;
			}
		}
	}

	select(accounts: Account[], _meta: RequestMeta): Account[] {
		const now = Date.now();

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
			// Return active account first, then others as fallback
			const others = accounts.filter(
				(a) => a.id !== activeAccount.id && isAccountAvailable(a, now),
			);
			return [activeAccount, ...others];
		}

		// No active session or active account is rate limited
		// Filter available accounts
		const available = accounts.filter((a) => isAccountAvailable(a, now));

		if (available.length === 0) return [];

		// Pick the first available account and start a new session with it
		const chosenAccount = available[0];
		this.resetSessionIfExpired(chosenAccount);

		// Return chosen account first, then others as fallback
		const others = available.filter((a) => a.id !== chosenAccount.id);
		return [chosenAccount, ...others];
	}
}

export class WeightedStrategy implements LoadBalancingStrategy {
	select(accounts: Account[], _meta: RequestMeta): Account[] {
		const now = Date.now();

		// Filter out rate-limited accounts
		const available = accounts.filter((a) => isAccountAvailable(a, now));

		if (available.length === 0) return [];

		// Calculate weighted request count (requests divided by tier)
		const accountsWithWeight = available.map((account) => ({
			account,
			weightedCount: account.request_count / (account.account_tier || 1),
		}));

		// Sort by weighted request count (ascending)
		accountsWithWeight.sort((a, b) => a.weightedCount - b.weightedCount);

		return accountsWithWeight.map((item) => item.account);
	}
}

export class WeightedRoundRobinStrategy implements LoadBalancingStrategy {
	private currentIndex = 0;

	select(accounts: Account[], _meta: RequestMeta): Account[] {
		const now = Date.now();

		// Filter out rate-limited accounts
		const available = accounts.filter((a) => isAccountAvailable(a, now));

		if (available.length === 0) return [];

		// Build weighted list (accounts appear multiple times based on tier)
		const weightedList: Account[] = [];
		for (const account of available) {
			const tier = account.account_tier || 1;
			for (let i = 0; i < tier; i++) {
				weightedList.push(account);
			}
		}

		if (weightedList.length === 0) return [];

		// Ensure index is within bounds
		this.currentIndex = this.currentIndex % weightedList.length;

		// Create ordered array starting from current index
		const ordered = [
			...weightedList.slice(this.currentIndex),
			...weightedList.slice(0, this.currentIndex),
		];

		// Move to next position
		this.currentIndex = (this.currentIndex + 1) % weightedList.length;

		// Remove duplicates while preserving order
		const seen = new Set<string>();
		const result: Account[] = [];
		for (const account of ordered) {
			if (!seen.has(account.id)) {
				seen.add(account.id);
				result.push(account);
			}
		}

		return result;
	}
}
