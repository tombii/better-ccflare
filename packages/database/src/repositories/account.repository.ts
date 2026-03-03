import {
	type Account,
	type AccountRow,
	toAccount,
} from "@better-ccflare/types";
import { BaseRepository } from "./base.repository";

export class AccountRepository extends BaseRepository<Account> {
	async findAll(): Promise<Account[]> {
		const rows = await this.query<AccountRow>(`
			SELECT
				id, name, provider, api_key, refresh_token, access_token,
				expires_at, created_at, last_used, request_count, total_requests,
				rate_limited_until, session_start, session_request_count,
				COALESCE(paused, 0) as paused,
				rate_limit_reset, rate_limit_status, rate_limit_remaining,
				COALESCE(priority, 0) as priority,
				COALESCE(auto_fallback_enabled, 0) as auto_fallback_enabled,
				COALESCE(auto_refresh_enabled, 0) as auto_refresh_enabled,
				custom_endpoint,
				model_mappings
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
				rate_limited_until, session_start, session_request_count,
				COALESCE(paused, 0) as paused,
				rate_limit_reset, rate_limit_status, rate_limit_remaining,
				COALESCE(priority, 0) as priority,
				COALESCE(auto_fallback_enabled, 0) as auto_fallback_enabled,
				COALESCE(auto_refresh_enabled, 0) as auto_refresh_enabled,
				custom_endpoint,
				model_mappings
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
		if (refreshToken) {
			await this.run(
				`UPDATE accounts SET access_token = ?, expires_at = ?, refresh_token = ? WHERE id = ?`,
				[accessToken, expiresAt, refreshToken, accountId],
			);
		} else {
			await this.run(
				`UPDATE accounts SET access_token = ?, expires_at = ? WHERE id = ?`,
				[accessToken, expiresAt, accountId],
			);
		}
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

	async setRateLimited(accountId: string, until: number): Promise<void> {
		await this.run(`UPDATE accounts SET rate_limited_until = ? WHERE id = ?`, [
			until,
			accountId,
		]);
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
			 	rate_limit_reset = NULL,
			 	rate_limit_status = NULL,
			 	rate_limit_remaining = NULL
			 WHERE id = ?`,
			[accountId],
		);
	}

	async pause(accountId: string): Promise<void> {
		await this.run(`UPDATE accounts SET paused = 1 WHERE id = ?`, [accountId]);
	}

	async resume(accountId: string): Promise<void> {
		await this.run(`UPDATE accounts SET paused = 0 WHERE id = ?`, [accountId]);
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

	/**
	 * Clear expired rate_limited_until values from all accounts
	 * @param now The current timestamp to compare against
	 * @returns Number of accounts that had their rate_limited_until cleared
	 */
	async clearExpiredRateLimits(now: number): Promise<number> {
		return this.runWithChanges(
			`UPDATE accounts SET rate_limited_until = NULL WHERE rate_limited_until <= ?`,
			[now],
		);
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
