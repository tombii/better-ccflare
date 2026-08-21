/**
 * Which accounts are currently deep in auto-refresh probe backoff, and should
 * therefore lose their place in the queue.
 *
 * The auto-refresh scheduler probes each account periodically to keep its
 * session window alive. When a probe fails in a way the scheduler deliberately
 * does not count as a failure — a 529 overload, or a request that never
 * produced a response — the account climbs an escalating ladder of waits
 * (1m, 5m, 10m, 30m, 1h, 6h, 12h) before the next probe.
 *
 * The first few rungs mean very little: a single blip, a moment of provider
 * turbulence. But once an account has earned an hour or more, the provider has
 * been refusing it for a sustained stretch, and that is real evidence about how
 * live traffic to that account will fare. So from the 1-hour rung up, the
 * scheduler registers the account here and the load balancer sorts it behind
 * accounts with no such history.
 *
 * It is a penalty, not an exclusion. A registered account still serves requests
 * when it is the best remaining option — the alternative is an install where
 * every account is having a bad hour and nothing is left to route to.
 *
 * In memory only, and deliberately so: the state it holds is "how has the last
 * few hours gone", which a restart is entitled to forget. The scheduler clears
 * an account the moment one of its probes succeeds.
 */

/** The rung at which the queue penalty starts applying. */
export const PROBE_BACKOFF_PENALTY_THRESHOLD_MS = 60 * 60 * 1000; // 1 hour

/** Account id → the timestamp its current backoff runs until. */
const backoffUntil = new Map<string, number>();

/**
 * Register an account as backed off until `until`. Called only for the rungs at
 * or above PROBE_BACKOFF_PENALTY_THRESHOLD_MS; the short rungs are noise and
 * must not move anything in the queue.
 */
export function setProbeBackoff(accountId: string, until: number): void {
	backoffUntil.set(accountId, until);
}

/** Forget an account's backoff — its probe succeeded, or it is gone. */
export function clearProbeBackoff(accountId: string): void {
	backoffUntil.delete(accountId);
}

/** Forget every backoff. For scheduler shutdown and for tests. */
export function clearAllProbeBackoff(): void {
	backoffUntil.clear();
}

/**
 * Whether this account is currently serving a long probe backoff. Expiry is
 * read rather than swept: an entry whose deadline has passed counts as clear,
 * so a stale entry can never keep penalising an account forever.
 */
export function isProbeBackedOff(
	accountId: string,
	now: number = Date.now(),
): boolean {
	const until = backoffUntil.get(accountId);
	return until !== undefined && until > now;
}

/** The deadline currently registered for an account, if any. */
export function probeBackoffUntil(accountId: string): number | null {
	return backoffUntil.get(accountId) ?? null;
}

/**
 * Queue rank: 0 for an account with no long backoff, 1 for one serving it.
 * Sorting on this before priority is what turns the backoff into a penalty
 * rather than a ban.
 */
export function probeBackoffRank(
	accountId: string,
	now: number = Date.now(),
): number {
	return isProbeBackedOff(accountId, now) ? 1 : 0;
}

/**
 * Compare two accounts for queue order: anything not in a long probe backoff
 * comes first, and within each group the configured priority decides. Returns 0
 * when both sit in the same group at the same priority, so callers can fall
 * through to their own tiebreakers (utilisation, score, session age).
 */
export function compareAccountPreference(
	a: { id: string; priority: number },
	b: { id: string; priority: number },
	now: number = Date.now(),
): number {
	const rank = probeBackoffRank(a.id, now) - probeBackoffRank(b.id, now);
	if (rank !== 0) return rank;
	return a.priority - b.priority;
}

/**
 * Whether `candidate` should be allowed to take work away from `incumbent` on
 * priority grounds. A penalised account never preempts one that is fine, even
 * when its configured priority is numerically higher — that is the whole point
 * of the penalty. Between two accounts in the same group, the usual
 * strictly-higher-priority rule applies.
 */
export function preemptsOnPreference(
	candidate: { id: string; priority: number },
	incumbent: { id: string; priority: number },
	now: number = Date.now(),
): boolean {
	return compareAccountPreference(candidate, incumbent, now) < 0;
}
