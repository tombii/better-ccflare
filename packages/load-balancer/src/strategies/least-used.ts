import { isAccountAvailable } from "@better-ccflare/core";
import { Logger } from "@better-ccflare/logger";
import type {
	Account,
	LoadBalancingStrategy,
	RequestMeta,
	StrategyStore,
} from "@better-ccflare/types";

/**
 * LeastUsedStrategy — picks the available account with the lowest reported
 * utilization, falling back to priority as a tiebreaker.
 *
 * Trade-off vs SessionStrategy:
 *   - No prompt-cache stickiness: each request is routed independently of
 *     the previous one, so cross-request prompt caches on Anthropic are
 *     less effective.
 *   - Better burst behavior: a sudden spike of N concurrent requests is
 *     spread across all healthy accounts in priority + utilization order
 *     rather than funneled into a single sticky account, reducing the
 *     probability of multiple accounts hitting per-account rate limits in
 *     near-simultaneity ("burst-cool" pool exhaustion).
 *
 * Use SessionStrategy when prompt-cache reuse is the primary cost driver
 * (long agentic loops with stable system prompts). Use LeastUsedStrategy
 * when burst tolerance and broad pool spread matter more than cache hits.
 */
export class LeastUsedStrategy implements LoadBalancingStrategy {
	private store: StrategyStore | null = null;
	private log = new Logger("LeastUsedStrategy");

	initialize(store: StrategyStore): void {
		this.store = store;
	}

	select(accounts: Account[], _meta: RequestMeta): Account[] {
		const now = Date.now();

		const available = accounts.filter((a) => isAccountAvailable(a, now));
		if (available.length === 0) return [];

		// Sort by priority ASC, then utilization ASC. Treat null utilization
		// as 0 so newly-added accounts (no usage data yet) are preferred over
		// fully-utilized ones — consistent with SessionStrategy's tiebreaker.
		const sorted = available.sort((a, b) => {
			if (a.priority !== b.priority) return a.priority - b.priority;
			const utilA =
				this.store?.getAccountUtilization?.(a.id, a.provider) ?? 0;
			const utilB =
				this.store?.getAccountUtilization?.(b.id, b.provider) ?? 0;
			return utilA - utilB;
		});

		this.log.debug(
			`Selected ${sorted.length} account(s) by least-used: ${sorted.map((a) => a.name).join(", ")}`,
		);

		// Return all available accounts in chosen order. The proxy loop will
		// try them sequentially as fallbacks.
		return sorted;
	}
}
