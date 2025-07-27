import type { Database } from "bun:sqlite";
import type { DatabaseOperations } from "@claudeflare/database";
import type { AccountResponse } from "../types.js";

/**
 * Create an accounts list handler
 */
export function createAccountsListHandler(db: Database) {
	return (): Response => {
		const now = Date.now();
		const sessionDuration = 5 * 60 * 60 * 1000; // 5 hours

		const accounts = db
			.query(
				`
				SELECT 
					id,
					name,
					provider,
					request_count,
					total_requests,
					last_used,
					created_at,
					rate_limited_until,
					session_start,
					session_request_count,
					COALESCE(account_tier, 1) as account_tier,
					CASE 
						WHEN expires_at > ?1 THEN 1 
						ELSE 0 
					END as token_valid,
					CASE 
						WHEN rate_limited_until > ?2 THEN 1
						ELSE 0
					END as rate_limited,
					CASE
						WHEN session_start IS NOT NULL AND ?3 - session_start < ?4 THEN
							'Active: ' || session_request_count || ' reqs'
						ELSE '-'
					END as session_info
				FROM accounts
				ORDER BY request_count DESC
			`,
			)
			.all(now, now, now, sessionDuration) as Array<{
			id: string;
			name: string;
			provider: string | null;
			request_count: number;
			total_requests: number;
			last_used: number | null;
			created_at: number;
			rate_limited_until: number | null;
			session_start: number | null;
			session_request_count: number;
			account_tier: number;
			token_valid: 0 | 1;
			rate_limited: 0 | 1;
			session_info: string | null;
		}>;

		const response: AccountResponse[] = accounts.map((account) => {
			let rateLimitStatus = "OK";
			if (account.rate_limited && account.rate_limited_until > now) {
				const minutesLeft = Math.ceil(
					(account.rate_limited_until - now) / 60000,
				);
				rateLimitStatus = `Rate limited (${minutesLeft}m)`;
			}

			return {
				id: account.id,
				name: account.name,
				provider: account.provider || "anthropic",
				requestCount: account.request_count,
				totalRequests: account.total_requests,
				lastUsed: account.last_used
					? new Date(account.last_used).toISOString()
					: null,
				created: new Date(account.created_at).toISOString(),
				tier: account.account_tier,
				tokenStatus: account.token_valid ? "valid" : "expired",
				rateLimitStatus,
				sessionInfo: account.session_info,
			};
		});

		return new Response(JSON.stringify(response), {
			headers: { "Content-Type": "application/json" },
		});
	};
}

/**
 * Create an account tier update handler
 */
export function createAccountTierUpdateHandler(dbOps: DatabaseOperations) {
	return async (req: Request, accountId: string): Promise<Response> => {
		try {
			const body = (await req.json()) as { tier: number };
			const { tier } = body;

			if (!tier || ![1, 5, 20].includes(tier)) {
				return new Response(
					JSON.stringify({ error: "Invalid tier. Must be 1, 5, or 20" }),
					{
						status: 400,
						headers: { "Content-Type": "application/json" },
					},
				);
			}

			dbOps.updateAccountTier(accountId, tier);

			return new Response(JSON.stringify({ success: true, tier }), {
				headers: { "Content-Type": "application/json" },
			});
		} catch (_error) {
			return new Response(
				JSON.stringify({ error: "Failed to update account tier" }),
				{
					status: 500,
					headers: { "Content-Type": "application/json" },
				},
			);
		}
	};
}
