import { Database } from "bun:sqlite";
import type { Account } from "./strategy";
import { ensureSchema, runMigrations } from "./migrations";
import type { RuntimeConfig } from "./config";
import { type AccountRow, toAccount } from "./db/types";

export class DatabaseOperations {
	private db: Database;
	private runtime?: RuntimeConfig;

	constructor(dbPath: string = "./claude-accounts.db") {
		this.db = new Database(dbPath, { create: true });
		ensureSchema(this.db);
		runMigrations(this.db);
	}

	setRuntimeConfig(runtime: RuntimeConfig): void {
		this.runtime = runtime;
	}

	getDatabase(): Database {
		return this.db;
	}

	getAllAccounts(): Account[] {
		const rows = this.db
			.query<AccountRow, []>(`
      SELECT 
        id,
        name,
        provider,
        api_key,
        refresh_token,
        access_token,
        expires_at,
        created_at,
        last_used,
        request_count,
        total_requests,
        rate_limited_until,
        session_start,
        session_request_count,
        COALESCE(account_tier, 1) as account_tier
      FROM accounts
    `)
			.all();

		return rows.map(toAccount);
	}

	updateAccountTokens(
		accountId: string,
		accessToken: string,
		expiresAt: number,
	): void {
		this.db.run(
			`UPDATE accounts SET access_token = ?, expires_at = ? WHERE id = ?`,
			[accessToken, expiresAt, accountId],
		);
	}

	updateAccountUsage(accountId: string): void {
		const now = Date.now();
		const sessionDuration =
			this.runtime?.sessionDurationMs || 5 * 60 * 60 * 1000; // fallback to 5 hours

		this.db.run(
			`
      UPDATE accounts 
      SET 
        last_used = ?,
        request_count = request_count + 1,
        total_requests = total_requests + 1,
        session_start = CASE
          WHEN session_start IS NULL OR ? - session_start >= ? THEN ?
          ELSE session_start
        END,
        session_request_count = CASE
          WHEN session_start IS NULL OR ? - session_start >= ? THEN 1
          ELSE session_request_count + 1
        END
      WHERE id = ?
    `,
			[now, now, sessionDuration, now, now, sessionDuration, accountId],
		);
	}

	markAccountRateLimited(accountId: string, until: number): void {
		this.db.run(`UPDATE accounts SET rate_limited_until = ? WHERE id = ?`, [
			until,
			accountId,
		]);
	}

	updateAccountTier(accountId: string, tier: number): void {
		this.db.run(`UPDATE accounts SET account_tier = ? WHERE id = ?`, [
			tier,
			accountId,
		]);
	}

	saveRequest(
		id: string,
		method: string,
		path: string,
		accountUsed: string | null,
		statusCode: number | null,
		success: boolean,
		errorMessage: string | null,
		responseTime: number,
		failoverAttempts: number,
	): void {
		this.db.run(
			`
      INSERT INTO requests (
        id, timestamp, method, path, account_used, 
        status_code, success, error_message, response_time_ms, failover_attempts
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
			[
				id,
				Date.now(),
				method,
				path,
				accountUsed,
				statusCode,
				success ? 1 : 0,
				errorMessage,
				responseTime,
				failoverAttempts,
			],
		);
	}

	close(): void {
		this.db.close();
	}
}
