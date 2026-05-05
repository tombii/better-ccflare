import { isAccountAvailable } from "@better-ccflare/core";
import { Logger } from "@better-ccflare/logger";
import {
	type Account,
	type LoadBalancingStrategy,
	PROVIDER_NAMES,
	type RequestMeta,
	type StrategyStore,
} from "@better-ccflare/types";

/**
 * Window during which a freshly-picked account is deprioritized so
 * concurrent bursts rotate through the pool instead of all picking
 * the same lowest-utilization candidate.
 */
const RECENT_PICK_WINDOW_MS = 500;

/**
 * Score added to an account's effective utilization when it was picked
 * within RECENT_PICK_WINDOW_MS. 100 = "treat as fully utilized" for
 * tiebreak purposes — large enough to override realistic upstream
 * utilization deltas (typically 0–95).
 */
const RECENT_PICK_PENALTY = 100;

/** 1-second buffer for clock-skew protection on rate_limit_reset comparisons. */
const RATE_LIMIT_RESET_BUFFER_MS = 1000;

/**
 * LeastUsedStrategy — picks the available account with the lowest effective
 * utilization, where effective utilization = upstream utilization + a
 * recency penalty for accounts picked in the last RECENT_PICK_WINDOW_MS.
 *
 * Without the recency penalty, N concurrent select() calls all evaluate
 * the same utilization snapshot and all pick the same lowest-util account,
 * funneling the burst into one upstream and triggering chained per-account
 * rate-limits — the exact failure mode this strategy is meant to avoid.
 * The penalty makes burst behavior approximately round-robin (each select
 * sees the previous pick as "recent" and deprioritizes it) while still
 * preferring the genuinely least-utilized account for sparse traffic.
 *
 * Trade-off vs SessionStrategy:
 *   - No prompt-cache stickiness: each request is routed independently of
 *     the previous one, so cross-request prompt caches on the upstream
 *     are less effective.
 *   - Better burst behavior: a sudden spike of N concurrent requests is
 *     spread across all healthy accounts rather than funneled into a
 *     single sticky account, reducing the probability of multiple
 *     accounts hitting per-account rate limits in near-simultaneity
 *     ("burst-cool" pool exhaustion).
 *
 * Use SessionStrategy when prompt-cache reuse is the primary cost driver
 * (long agentic loops with stable system prompts). Use LeastUsedStrategy
 * when burst tolerance and broad pool spread matter more than cache hits.
 */
export class LeastUsedStrategy implements LoadBalancingStrategy {
	private store: StrategyStore | null = null;
	private log = new Logger("LeastUsedStrategy");
	private lastPickedAt = new Map<string, number>();

	initialize(store: StrategyStore): void {
		this.store = store;
	}

	select(accounts: Account[], _meta: RequestMeta): Account[] {
		const now = Date.now();

		// Auto-unpause eligible accounts whose upstream usage window has reset.
		// Mirrors SessionStrategy's checkForAutoFallbackAccounts path so users
		// who configured auto_fallback_enabled accounts get the same self-recovery
		// behaviour regardless of which strategy they pick.
		this.autoUnpauseElapsedAccounts(accounts, now);

		const available = accounts.filter((a) => isAccountAvailable(a, now));
		if (available.length === 0) return [];

		// Score each account: priority is primary, then upstream utilization
		// plus a recency penalty for accounts picked in the recent window.
		// Treat null utilization as 0 so newly-added accounts (no usage data
		// yet) are preferred over fully-utilized ones.
		const scored = available.map((a) => {
			const util =
				this.store?.getAccountUtilization?.(a.id, a.provider) ?? 0;
			const lastPick = this.lastPickedAt.get(a.id) ?? 0;
			const recencyPenalty =
				now - lastPick < RECENT_PICK_WINDOW_MS ? RECENT_PICK_PENALTY : 0;
			return { account: a, score: util + recencyPenalty };
		});

		const sorted = scored
			.sort((a, b) => {
				if (a.account.priority !== b.account.priority) {
					return a.account.priority - b.account.priority;
				}
				return a.score - b.score;
			})
			.map((s) => s.account);

		// Mark the primary as recently picked so the *next* concurrent
		// select() within RECENT_PICK_WINDOW_MS prefers a different account.
		// Opportunistic GC: prune entries older than 10× the window so the
		// map doesn't grow unboundedly when accounts come and go.
		const primary = sorted[0];
		this.lastPickedAt.set(primary.id, now);
		const gcThreshold = now - RECENT_PICK_WINDOW_MS * 10;
		for (const [id, ts] of this.lastPickedAt) {
			if (ts < gcThreshold) this.lastPickedAt.delete(id);
		}

		this.log.debug(
			`Selected ${sorted.length} account(s) by least-used (primary ${primary.name}): ${sorted.map((a) => a.name).join(", ")}`,
		);

		return sorted;
	}

	/**
	 * Auto-unpause any account whose:
	 *   - auto_fallback_enabled flag is set, AND
	 *   - upstream rate_limit_reset window has elapsed, AND
	 *   - pause_reason is one of the reasons we consider safe to auto-unpause
	 *     ('overage' or 'rate_limit_window'; null is also treated as safe to
	 *     match SessionStrategy's behavior on legacy rows).
	 *
	 * Mutates the in-memory account.paused flag to false on resume so the
	 * subsequent isAccountAvailable check reflects the new state. Manual
	 * pauses (pause_reason='manual' or 'failure_threshold') are not touched.
	 */
	private autoUnpauseElapsedAccounts(accounts: Account[], now: number): void {
		if (!this.store?.resumeAccount) return;

		for (const account of accounts) {
			if (!account.paused) continue;
			if (!account.auto_fallback_enabled) continue;

			// Only providers with proactive rate-limit-reset headers are eligible
			// (matches SessionStrategy.checkForAutoFallbackAccounts).
			const supportsWindowReset =
				account.provider === PROVIDER_NAMES.ANTHROPIC ||
				account.provider === PROVIDER_NAMES.CODEX ||
				account.provider === PROVIDER_NAMES.ZAI;
			if (!supportsWindowReset) continue;

			const windowReset =
				account.rate_limit_reset != null &&
				account.rate_limit_reset < now - RATE_LIMIT_RESET_BUFFER_MS;
			if (!windowReset) continue;

			// Only auto-unpause for safe reasons. Match SessionStrategy:
			// null pause_reason is treated as legacy/safe.
			const safeReasons = [null, "overage", "rate_limit_window"];
			const pauseReason = account.pause_reason ?? null;
			if (!safeReasons.includes(pauseReason as string | null)) continue;

			this.log.info(
				`Auto-unpausing ${account.name} (pause_reason=${pauseReason}) — usage window has reset`,
			);
			this.store.resumeAccount(account.id);
			account.paused = false;
		}
	}
}
