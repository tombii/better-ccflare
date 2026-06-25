import { isAccountAvailable, TIME_CONSTANTS } from "@better-ccflare/core";
import { Logger } from "@better-ccflare/logger";
import type {
	Account,
	LoadBalancingStrategy,
	RequestMeta,
	StrategyStore,
} from "@better-ccflare/types";
import { isPeekAvailable, wouldAutoUnpause } from "./peek-availability";

/**
 * Window during which a freshly-picked account is deprioritized so that
 * concurrent NEW client-sessions rotate through the pool instead of all
 * landing on the same lowest-utilization candidate. Copied from
 * LeastUsedStrategy — see that file for the rationale.
 */
const RECENT_PICK_WINDOW_MS = 500;

/**
 * Score added to an account's effective utilization when it was picked
 * within RECENT_PICK_WINDOW_MS. 100 = "treat as fully utilized" for
 * tiebreak purposes — large enough to override realistic upstream
 * utilization deltas (typically 0–95).
 */
const RECENT_PICK_PENALTY = 100;

/**
 * SessionAffinityStrategy — a hybrid of SessionStrategy and LeastUsedStrategy.
 *
 * Routing is keyed on the *client* session id (request body
 * `metadata.user_id`, threaded through as {@link RequestMeta.clientSessionId}):
 *
 *   - The first request of a new client-session is routed to the least-loaded
 *     available account (same least-used scoring as LeastUsedStrategy, with the
 *     recency penalty so concurrently-starting sessions spread across the pool).
 *   - That client→account mapping is then made STICKY for `affinityTtlMs`, so
 *     every subsequent request from the same client keeps hitting the same
 *     upstream → prompt-cache affinity is preserved across the agentic loop.
 *
 * The result: many concurrent client-sessions are spread across all healthy
 * accounts (one account is no longer maxed before the next is touched, the
 * sequential-exhaustion failure mode of SessionStrategy), while each individual
 * session still keeps its cache locality (which per-request LeastUsedStrategy
 * throws away).
 *
 * Trade-off:
 *   - vs SessionStrategy: SessionStrategy tracks ONE account-level session and
 *     funnels ALL traffic to it until it rate-limits/expires, then rotates —
 *     maxing one account before the next. SessionAffinity instead pins each
 *     client to its own account, so N concurrent clients use up to N accounts.
 *   - vs LeastUsedStrategy: LeastUsed spreads every individual request and so
 *     loses prompt-cache reuse. SessionAffinity keeps a client glued to one
 *     account, trading some instantaneous load-evenness for cache hits.
 *
 * When the pinned account is temporarily unavailable (rate-limited), the
 * mapping is intentionally NOT deleted: we fail the client over to the
 * least-used available account for the duration, but snap it back to its
 * original account once that recovers (mirrors the SessionStrategy issue #115
 * reasoning — the prompt-cache window outlives the rate-limit window).
 */
export class SessionAffinityStrategy implements LoadBalancingStrategy {
	private affinityTtlMs: number;
	private store: StrategyStore | null = null;
	private log = new Logger("SessionAffinityStrategy");
	/** clientId → which account it is stuck to (and when it was last touched). */
	private affinity = new Map<
		string,
		{ accountId: string; assignedAt: number }
	>();
	/** accountId → last time it was freshly assigned to a NEW client-session. */
	private lastPickedAt = new Map<string, number>();

	constructor(
		affinityTtlMs: number = TIME_CONSTANTS.ANTHROPIC_SESSION_DURATION_DEFAULT,
	) {
		this.affinityTtlMs = affinityTtlMs;
	}

	initialize(store: StrategyStore): void {
		this.store = store;
	}

	/**
	 * Rank accounts by least-used: priority ASC, then upstream utilization plus
	 * a recency penalty for accounts assigned in the last RECENT_PICK_WINDOW_MS.
	 * Identical scoring to LeastUsedStrategy.select() so the two strategies pick
	 * the same primary for a fresh session given the same state.
	 */
	private rankByLeastUsed(accounts: Account[], now: number): Account[] {
		const scored = accounts.map((a) => {
			const util = this.store?.getAccountUtilization?.(a.id, a.provider) ?? 0;
			const lastPick = this.lastPickedAt.get(a.id) ?? 0;
			const recencyPenalty =
				now - lastPick < RECENT_PICK_WINDOW_MS ? RECENT_PICK_PENALTY : 0;
			return { account: a, score: util + recencyPenalty };
		});

		return scored
			.sort((a, b) => {
				if (a.account.priority !== b.account.priority) {
					return a.account.priority - b.account.priority;
				}
				return a.score - b.score;
			})
			.map((s) => s.account);
	}

	peek(accounts: Account[]): string | null {
		const now = Date.now();
		// Use isPeekAvailable so accounts that select() would auto-unpause on its
		// next call surface as candidates here, matching LeastUsedStrategy.peek().
		const available = accounts.filter((a) => isPeekAvailable(a, now));
		if (available.length === 0) return null;
		return this.rankByLeastUsed(available, now)[0]?.id ?? null;
	}

	select(accounts: Account[], meta: RequestMeta): Account[] {
		const now = Date.now();

		// Auto-unpause eligible accounts whose upstream usage window has reset.
		// Mirrors LeastUsedStrategy.autoUnpauseElapsedAccounts so users with
		// auto_fallback_enabled accounts get the same self-recovery behaviour
		// regardless of which strategy they pick.
		this.autoUnpauseElapsedAccounts(accounts, now);

		const available = accounts.filter((a) => isAccountAvailable(a, now));
		if (available.length === 0) return [];

		// GC expired affinity entries so the map doesn't grow unboundedly and so
		// long-idle clients are re-balanced onto the currently least-loaded
		// account rather than re-pinned to a possibly-stale one.
		for (const [clientId, entry] of this.affinity) {
			if (now - entry.assignedAt >= this.affinityTtlMs) {
				this.affinity.delete(clientId);
			}
		}

		const clientId = meta.clientSessionId ?? null;

		// Existing, non-expired client-session: try to honour its sticky mapping.
		if (clientId !== null) {
			const mapping = this.affinity.get(clientId);
			if (mapping) {
				const mapped = available.find((a) => a.id === mapping.accountId);
				if (mapped) {
					// STICKY hit: keep the client on its account (prompt-cache reuse).
					// Refresh assignedAt so an active session keeps its mapping alive.
					mapping.assignedAt = now;
					const others = this.rankByLeastUsed(
						available.filter((a) => a.id !== mapped.id),
						now,
					);
					this.log.debug(
						`Sticky client ${clientId} → ${mapped.name} (${others.length} fallback(s))`,
					);
					return [mapped, ...others];
				}

				// Mapped account is currently unavailable (e.g. rate-limited). Do NOT
				// delete the mapping — temporarily fail over to the least-used account
				// and snap back to the original once it recovers (mirrors issue #115).
				this.log.info(
					`Client ${clientId} pinned account ${mapping.accountId} is unavailable — temporary failover to least-used`,
				);
				return this.rankByLeastUsed(available, now);
			}
		}

		// New (or expired) client-session, or a request with no client id: assign
		// the least-loaded available account and stick the client to it.
		const ranked = this.rankByLeastUsed(available, now);
		const chosen = ranked[0];

		// Mark chosen as recently picked so concurrently-starting NEW sessions
		// within RECENT_PICK_WINDOW_MS prefer a different account (spread).
		// Opportunistic GC of entries older than 10× the window.
		this.lastPickedAt.set(chosen.id, now);
		const gcThreshold = now - RECENT_PICK_WINDOW_MS * 10;
		for (const [id, ts] of this.lastPickedAt) {
			if (ts < gcThreshold) this.lastPickedAt.delete(id);
		}

		if (clientId !== null) {
			this.affinity.set(clientId, { accountId: chosen.id, assignedAt: now });
			this.log.debug(
				`Assigned client ${clientId} → ${chosen.name} (least-used)`,
			);
		}

		return ranked;
	}

	/**
	 * Auto-unpause any account that {@link wouldAutoUnpause} reports as eligible
	 * (auto_fallback_enabled + safe pause_reason + window elapsed). Mutates the
	 * in-memory account.paused flag to false on resume so the subsequent
	 * isAccountAvailable check reflects the new state.
	 *
	 * Stays in sync with SessionStrategy.select() and
	 * LeastUsedStrategy.autoUnpauseElapsedAccounts() via the shared predicate —
	 * keep changes there mirrored here.
	 */
	private autoUnpauseElapsedAccounts(accounts: Account[], now: number): void {
		if (!this.store?.resumeAccount) return;

		for (const account of accounts) {
			if (!wouldAutoUnpause(account, now)) continue;

			this.log.info(
				`Auto-unpausing ${account.name} (pause_reason=${account.pause_reason ?? "null"}) — usage window has reset`,
			);
			this.store.resumeAccount(account.id);
			account.paused = false;
		}
	}
}
