import { BaseRepository } from "./base.repository";

export interface OAuthSession {
	accountName: string;
	verifier: string;
	mode: "console" | "claude-oauth";
	customEndpoint?: string;
}

export class OAuthRepository extends BaseRepository<OAuthSession> {
	createSession(
		sessionId: string,
		accountName: string,
		verifier: string,
		mode: "console" | "claude-oauth",
		customEndpoint?: string,
		ttlMinutes = 10,
	): void {
		const now = Date.now();
		const expiresAt = now + ttlMinutes * 60 * 1000;

		this.run(
			`
			INSERT INTO oauth_sessions (id, account_name, verifier, mode, custom_endpoint, created_at, expires_at)
			VALUES (?, ?, ?, ?, ?, ?, ?)
		`,
			[
				sessionId,
				accountName,
				verifier,
				mode,
				customEndpoint || null,
				now,
				expiresAt,
			],
		);
	}

	getSession(sessionId: string): OAuthSession | null {
		const row = this.get<{
			account_name: string;
			verifier: string;
			mode: "console" | "claude-oauth";
			custom_endpoint: string | null;
			expires_at: number;
		}>(
			`
			SELECT account_name, verifier, mode, custom_endpoint, expires_at
			FROM oauth_sessions
			WHERE id = ? AND expires_at > ?
		`,
			[sessionId, Date.now()],
		);

		if (!row) return null;

		return {
			accountName: row.account_name,
			verifier: row.verifier,
			mode: row.mode,
			customEndpoint: row.custom_endpoint || undefined,
		};
	}

	deleteSession(sessionId: string): void {
		this.run(`DELETE FROM oauth_sessions WHERE id = ?`, [sessionId]);
	}

	cleanupExpiredSessions(): number {
		return this.runWithChanges(
			`DELETE FROM oauth_sessions WHERE expires_at <= ?`,
			[Date.now()],
		);
	}
}
