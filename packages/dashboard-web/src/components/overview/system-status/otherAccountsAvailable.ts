/**
 * Predicate used by RecentErrorsCard to decide whether failover from the
 * account that produced an error has any chance of succeeding.
 *
 * An "available" account is one that is:
 *   - not the account that produced the error,
 *   - not manually paused, and
 *   - not currently rate-limited (rateLimitedUntil null or in the past).
 *
 * Rate-limited accounts must be excluded — otherwise model_fallback_429
 * displays as "warning" implying failover will succeed when in fact every
 * candidate is also exhausted.
 */
export type AccountForFailoverCheck = {
	id: string;
	paused: boolean;
	rateLimitedUntil: number | null;
};

export function otherAccountsAvailable(
	accounts: AccountForFailoverCheck[] | undefined | null,
	errorAccountId: string | null,
): boolean {
	const now = Date.now();
	return (accounts ?? []).some(
		(a) =>
			a.id !== errorAccountId &&
			!a.paused &&
			(a.rateLimitedUntil == null || a.rateLimitedUntil <= now),
	);
}
