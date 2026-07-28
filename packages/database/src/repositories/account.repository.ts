import { Logger } from "@better-ccflare/logger";
import {
	type Account,
	type AccountRow,
	type RateLimitReason,
	toAccount,
} from "@better-ccflare/types";
import { BaseRepository } from "./base.repository";

const log = new Logger("AccountRepository");

/**
 * Result of {@link AccountRepository.markAccountRateLimited}. `applied`
 * distinguishes an actually-persisted write from one the 529 forward guard
 * rejected (or that found no matching row) — callers must not assume the
 * write happened just because the call resolved.
 */
export interface MarkAccountRateLimitedResult {
	consecutiveRateLimits: number;
	applied: boolean;
}

/**
 * Identifiers for an account whose `rate_limited_until` was just cleared
 * by `AccountRepository.clearExpiredRateLimits`. Returned so the caller
 * can notify the circuit breaker (`recordSuccess`) — see the active-clear
 * wiring in `apps/server` and the integration design §3 "active clear"
 * path.
 */
export interface ClearedRateLimit {
	id: string;
	provider: string;
}

export class AccountRepository extends BaseRepository<Account> {
	async findAll(): Promise<Account[]> {
		const rows = await this.query<AccountRow>(`
			SELECT
				id, name, provider, api_key, refresh_token, access_token,
				expires_at, created_at, last_used, request_count, total_requests,
				rate_limited_until, rate_limited_reason, rate_limited_at, session_start, session_request_count,
				COALESCE(paused, 0) as paused,
				COALESCE(requires_reauth, 0) as requires_reauth,
				rate_limit_reset, rate_limit_status, rate_limit_remaining,
				COALESCE(priority, 0) as priority,
				COALESCE(auto_fallback_enabled, 0) as auto_fallback_enabled,
				COALESCE(auto_refresh_enabled, 0) as auto_refresh_enabled,
				COALESCE(auto_pause_on_overage_enabled, 0) as auto_pause_on_overage_enabled,
				COALESCE(peak_hours_pause_enabled, 0) as peak_hours_pause_enabled,
				custom_endpoint,
				model_mappings,
				cross_region_mode,
				model_fallbacks,
				billing_type,
				pause_reason,
				refresh_token_issued_at,
				COALESCE(consecutive_rate_limits, 0) as consecutive_rate_limits
			FROM accounts
			ORDER BY priority DESC
		`);
		return rows.map(toAccount);
	}

	async findById(accountId: string): Promise<Account | null> {
		const row = await this.get<AccountRow>(
			`
			SELECT
				id, name, provider, api_key, refresh_token, access_token,
				expires_at, created_at, last_used, request_count, total_requests,
				rate_limited_until, rate_limited_reason, rate_limited_at, session_start, session_request_count,
				COALESCE(paused, 0) as paused,
				COALESCE(requires_reauth, 0) as requires_reauth,
				rate_limit_reset, rate_limit_status, rate_limit_remaining,
				COALESCE(priority, 0) as priority,
				COALESCE(auto_fallback_enabled, 0) as auto_fallback_enabled,
				COALESCE(auto_refresh_enabled, 0) as auto_refresh_enabled,
				COALESCE(auto_pause_on_overage_enabled, 0) as auto_pause_on_overage_enabled,
				COALESCE(peak_hours_pause_enabled, 0) as peak_hours_pause_enabled,
				custom_endpoint,
				model_mappings,
				cross_region_mode,
				model_fallbacks,
				billing_type,
				pause_reason,
				refresh_token_issued_at,
				COALESCE(consecutive_rate_limits, 0) as consecutive_rate_limits
			FROM accounts
			WHERE id = ?
		`,
			[accountId],
		);

		return row ? toAccount(row) : null;
	}

	async updateTokens(
		accountId: string,
		accessToken: string,
		expiresAt: number,
		refreshToken?: string,
	): Promise<void> {
		const now = Date.now();
		if (refreshToken) {
			await this.run(
				`UPDATE accounts SET access_token = ?, expires_at = ?, refresh_token = ?, refresh_token_issued_at = ?, requires_reauth = 0 WHERE id = ?`,
				[accessToken, expiresAt, refreshToken, now, accountId],
			);
		} else {
			await this.run(
				`UPDATE accounts SET access_token = ?, expires_at = ?, requires_reauth = 0 WHERE id = ?`,
				[accessToken, expiresAt, accountId],
			);
		}
	}

	async setRequiresReauth(accountId: string, value: boolean): Promise<void> {
		await this.run(`UPDATE accounts SET requires_reauth = ? WHERE id = ?`, [
			value ? 1 : 0,
			accountId,
		]);
	}

	async incrementUsage(
		accountId: string,
		sessionDurationMs: number,
	): Promise<void> {
		const now = Date.now();
		await this.run(
			`
			UPDATE accounts
			SET
				last_used = ?,
				request_count = COALESCE(request_count, 0) + 1,
				total_requests = COALESCE(total_requests, 0) + 1,
				session_start = CASE
					WHEN session_start IS NULL OR ? - COALESCE(session_start, 0) >= ? THEN ?
					ELSE session_start
				END,
				session_request_count = CASE
					WHEN session_start IS NULL OR ? - COALESCE(session_start, 0) >= ? THEN 1
					ELSE COALESCE(session_request_count, 0) + 1
				END
			WHERE id = ?
		`,
			[now, now, sessionDurationMs, now, now, sessionDurationMs, accountId],
		);
	}

	async setRateLimited(
		accountId: string,
		until: number,
		reason: RateLimitReason,
	): Promise<void> {
		await this.run(
			`UPDATE accounts SET rate_limited_until = ?, rate_limited_reason = ?, rate_limited_at = ? WHERE id = ?`,
			[until, reason, Date.now(), accountId],
		);
	}

	async markAccountRateLimited(
		accountId: string,
		until: number,
		reason: RateLimitReason,
		incrementStreak = true,
	): Promise<MarkAccountRateLimitedResult> {
		let applied = true;
		if (incrementStreak) {
			await this.run(
				`UPDATE accounts
           SET consecutive_rate_limits = COALESCE(consecutive_rate_limits, 0) + 1,
               rate_limited_until      = ?,
               rate_limited_reason     = ?,
               rate_limited_at         = ?
         WHERE id = ?`,
				[until, reason, Date.now(), accountId],
			);
		} else {
			// 529 overload: cooldown state moves, but the 429 streak counter
			// is left untouched — an overload is not a quota signal.
			//
			// WHERE-guarded against a concurrent writer having set a longer,
			// still-active cooldown between this call's read and write (e.g. a
			// real 429 quota bench applied by another in-flight request for the
			// same account) — only apply this 529's cooldown when the account
			// currently has none, or its existing one already expires at or
			// before this one would. `<=`, not `<`: the in-process forward guard
			// in rate-limit-cooldown.ts only REJECTS on a strictly longer existing
			// cooldown (`account.rate_limited_until > cooldownUntil`) and lets an
			// equal-expiry write proceed — a strict `<` here would reject that
			// same equal-expiry case, leaving memory holding the new 529 reason
			// while the DB silently keeps the old one. This mirrors the in-process
			// guard but covers the cross-request DB race that guard can't see. A
			// plain WHERE predicate (not GREATEST/MAX) so the same SQL runs
			// unchanged on both SQLite and PostgreSQL.
			const changes = await this.runWithChanges(
				`UPDATE accounts
           SET rate_limited_until      = ?,
               rate_limited_reason     = ?,
               rate_limited_at         = ?
         WHERE id = ?
           AND (rate_limited_until IS NULL OR rate_limited_until <= ?)`,
				[until, reason, Date.now(), accountId, until],
			);
			applied = changes > 0;
			if (!applied) {
				// The guarded write was skipped. This has two distinct causes the
				// row count alone can't distinguish: a longer cooldown is already
				// active for this account (set by a concurrent request between
				// this call's read and write), or the row itself no longer exists
				// (account deleted/renamed since the caller last read it) — so this
				// message states neither as fact. The caller (applyRateLimitCooldown
				// in rate-limit-cooldown.ts) receives `applied` below and logs the
				// correct outcome for its own event instead of asserting a cause.
				log.warn(
					`[ccflare] account=${accountId} rate_limited_write_skipped reason=${reason} candidate_until=${new Date(until).toISOString()} — guarded write skipped: existing rate_limited_until is later, or the row is absent`,
				);
			}
		}
		const row = await this.get<{ consecutive_rate_limits: number }>(
			`SELECT consecutive_rate_limits FROM accounts WHERE id = ?`,
			[accountId],
		);
		return {
			consecutiveRateLimits: row?.consecutive_rate_limits ?? 0,
			applied,
		};
	}

	async resetConsecutiveRateLimits(accountId: string): Promise<void> {
		await this.run(
			`UPDATE accounts SET consecutive_rate_limits = 0, rate_limited_at = NULL WHERE id = ?`,
			[accountId],
		);
	}

	async updateRateLimitMeta(
		accountId: string,
		status: string,
		reset: number | null,
		remaining?: number | null,
	): Promise<void> {
		await this.run(
			`UPDATE accounts SET rate_limit_status = ?, rate_limit_reset = ?, rate_limit_remaining = ? WHERE id = ?`,
			[status, reset, remaining ?? null, accountId],
		);
	}

	async clearRateLimitState(accountId: string): Promise<number> {
		return this.runWithChanges(
			`UPDATE accounts
			 SET
			 	rate_limited_until = NULL,
			 	rate_limited_reason = NULL,
			 	rate_limited_at = NULL,
			 	rate_limit_reset = NULL,
			 	rate_limit_status = NULL,
			 	rate_limit_remaining = NULL
			 WHERE id = ?`,
			[accountId],
		);
	}

	async pause(accountId: string, reason = "manual"): Promise<void> {
		await this.run(
			`UPDATE accounts SET paused = 1, pause_reason = ? WHERE id = ?`,
			[reason, accountId],
		);
	}

	async resume(accountId: string): Promise<void> {
		await this.run(
			`UPDATE accounts SET paused = 0, pause_reason = NULL WHERE id = ?`,
			[accountId],
		);
	}

	async resetSession(accountId: string, timestamp: number): Promise<void> {
		await this.run(
			`UPDATE accounts SET session_start = ?, session_request_count = 0 WHERE id = ?`,
			[timestamp, accountId],
		);
	}

	async updateRequestCount(accountId: string, count: number): Promise<void> {
		await this.run(
			`UPDATE accounts SET session_request_count = ? WHERE id = ?`,
			[count, accountId],
		);
	}

	async rename(accountId: string, newName: string): Promise<void> {
		await this.run(`UPDATE accounts SET name = ? WHERE id = ?`, [
			newName,
			accountId,
		]);
	}

	async updatePriority(accountId: string, priority: number): Promise<void> {
		await this.run(`UPDATE accounts SET priority = ? WHERE id = ?`, [
			priority,
			accountId,
		]);
	}

	async setAutoFallbackEnabled(
		accountId: string,
		enabled: boolean,
	): Promise<void> {
		await this.run(
			`UPDATE accounts SET auto_fallback_enabled = ? WHERE id = ?`,
			[enabled ? 1 : 0, accountId],
		);
	}

	async setAutoPauseOnOverageEnabled(
		accountId: string,
		enabled: boolean,
	): Promise<void> {
		await this.run(
			`UPDATE accounts SET auto_pause_on_overage_enabled = ? WHERE id = ?`,
			[enabled ? 1 : 0, accountId],
		);
	}

	async setBillingType(
		accountId: string,
		billingType: string | null,
	): Promise<void> {
		await this.run(`UPDATE accounts SET billing_type = ? WHERE id = ?`, [
			billingType,
			accountId,
		]);
	}

	/**
	 * Clear expired rate_limited_until values from all accounts.
	 *
	 * Returns the `(id, provider)` pairs that had their bench cleared so the
	 * caller can feed the circuit breaker (the active-clear path from the
	 * circuit-breaker integration design §3). The repository stays
	 * framework-agnostic: it does NOT import the breaker module — that is
	 * the proxy/server layer's job.
	 *
	 * @param now The current timestamp to compare against
	 * @returns The accounts whose `rate_limited_until` was cleared
	 */
	async clearExpiredRateLimits(now: number): Promise<ClearedRateLimit[]> {
		// The repository layer doesn't use RETURNING (per the adapter note in
		// bun-sql-adapter.ts:159 — no RETURNING clauses). Select first, then
		// update. The two queries can race against a fresh cooldown-write
		// happening concurrently, but the window is microseconds and the
		// worst case is one row reported as "cleared" without an actual
		// write — recordSuccess is idempotent for an already-closed circuit
		// entry, so the breaker converges correctly.
		const cleared = await this.query<ClearedRateLimit>(
			`SELECT id, provider FROM accounts WHERE rate_limited_until <= ?`,
			[now],
		);
		if (cleared.length === 0) return [];
		await this.runWithChanges(
			`UPDATE accounts SET rate_limited_until = NULL WHERE rate_limited_until <= ?`,
			[now],
		);
		return cleared;
	}

	/**
	 * Check if there are any accounts for a specific provider
	 */
	async hasAccountsForProvider(provider: string): Promise<boolean> {
		const result = await this.get<{ count: number }>(
			`SELECT COUNT(*) as count FROM accounts WHERE provider = ?`,
			[provider],
		);
		return result ? result.count > 0 : false;
	}
}
