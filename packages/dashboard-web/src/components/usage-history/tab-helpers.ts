/**
 * Pure, structural helpers for the Usage History tab. Kept decoupled from the
 * full AccountResponse type so they stay trivially testable.
 *
 * Background: usage snapshots are only written for NON-paused accounts (the
 * feature reuses the existing usage poll, which skips paused accounts). So the
 * default selection and empty-state messaging both need to be paused-aware.
 */
export interface AccountLike {
	id: string;
	name: string;
	paused?: boolean | number | null;
}

/** First non-paused account's id; else the first account's id; else undefined. */
export function pickDefaultAccount(
	accounts?: AccountLike[],
): string | undefined {
	if (!accounts || accounts.length === 0) return undefined;
	const active = accounts.find((a) => !a.paused);
	return (active ?? accounts[0]).id;
}

/** New array with non-paused accounts first (stable within each group). */
export function sortAccountsActiveFirst<T extends AccountLike>(
	accounts: T[],
): T[] {
	// Copy first: Array.prototype.sort mutates in place, and callers pass live
	// query data. V8/Bun sort is stable, so equal-group order is preserved.
	return [...accounts].sort((a, b) => Number(!!a.paused) - Number(!!b.paused));
}

/**
 * Milliseconds spanned by a range string. Mirrors the endpoint's range set
 * (getRangeConfig: 1h/6h/24h/7d/30d) and its 24h fallback for anything else,
 * so the chart's forward horizon matches the selected range.
 */
export function rangeToMs(range: string): number {
	const H = 60 * 60 * 1000;
	switch (range) {
		case "1h":
			return H;
		case "6h":
			return 6 * H;
		case "24h":
			return 24 * H;
		case "7d":
			return 7 * 24 * H;
		case "30d":
			return 30 * 24 * H;
		default:
			return 24 * H;
	}
}

/** Empty-state message for the chart, based on the selected account. */
export function usageEmptyStateMessage(account?: AccountLike): string {
	if (!account) return "Select an account to view its usage history.";
	if (account.paused)
		return "Account is paused — usage isn't polled while paused. Resume it to start collecting history.";
	return "Collecting usage data… (first points appear within ~1 minute).";
}
