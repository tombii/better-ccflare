import type { Database } from "bun:sqlite";
import type { Config } from "@claudeflare/config";
import type { DatabaseOperations } from "@claudeflare/database";
import {
	isValidStrategy,
	type StrategyName,
	STRATEGIES,
} from "@claudeflare/core";

export class ApiRoutes {
	private db: Database;
	private config: Config;
	private dbOps: DatabaseOperations;

	constructor(db: Database, config: Config, dbOps: DatabaseOperations) {
		this.db = db;
		this.config = config;
		this.dbOps = dbOps;
	}

	async handleRequest(url: URL, req: Request): Promise<Response | null> {
		const path = url.pathname;

		// Health check
		if (path === "/health") {
			return this.handleHealth();
		}

		// Stats API
		if (path === "/api/stats") {
			return this.handleStats();
		}

		// Accounts API
		if (path === "/api/accounts") {
			return this.handleAccounts();
		}

		// Requests API
		if (path === "/api/requests") {
			return this.handleRequests(url);
		}

		// Config API
		if (path === "/api/config") {
			return this.handleGetConfig();
		}

		// Strategies list API
		if (path === "/api/strategies") {
			return new Response(JSON.stringify(STRATEGIES), {
				headers: { "Content-Type": "application/json" },
			});
		}

		// Strategy API
		if (path === "/api/config/strategy" && req.method === "POST") {
			return await this.handleSetStrategy(req);
		}

		if (path === "/api/config/strategy" && req.method === "GET") {
			return this.handleGetStrategy();
		}

		// Account tier API
		if (
			path.startsWith("/api/accounts/") &&
			path.endsWith("/tier") &&
			req.method === "POST"
		) {
			const accountId = path.split("/")[3];
			return await this.handleUpdateAccountTier(req, accountId);
		}

		return null;
	}

	private handleHealth(): Response {
		const accountCount = this.db
			.query("SELECT COUNT(*) as count FROM accounts")
			.get() as { count: number } | undefined;

		return new Response(
			JSON.stringify({
				status: "ok",
				accounts: accountCount?.count || 0,
				timestamp: new Date().toISOString(),
				strategy: this.config.getStrategy(),
			}),
			{
				headers: { "Content-Type": "application/json" },
			},
		);
	}

	private handleStats(): Response {
		const stats = this.db
			.query(
				`
        SELECT 
          COUNT(*) as totalRequests,
          SUM(CASE WHEN success = 1 THEN 1 ELSE 0 END) as successfulRequests,
          AVG(response_time_ms) as avgResponseTime
        FROM requests
      `,
			)
			// biome-ignore lint/suspicious/noExplicitAny: Database query results can vary in shape
			.get() as any;

		const accountCount = this.db
			.query("SELECT COUNT(*) as count FROM accounts")
			.get() as { count: number } | undefined;

		const successRate =
			stats?.totalRequests > 0
				? Math.round((stats.successfulRequests / stats.totalRequests) * 100)
				: 0;

		return new Response(
			JSON.stringify({
				totalRequests: stats?.totalRequests || 0,
				successRate,
				activeAccounts: accountCount?.count || 0,
				avgResponseTime: Math.round(stats?.avgResponseTime || 0),
			}),
			{
				headers: { "Content-Type": "application/json" },
			},
		);
	}

	private handleAccounts(): Response {
		const now = Date.now();
		const sessionDuration = 5 * 60 * 60 * 1000; // 5 hours

		const accounts = this.db
			.query(
				`
        SELECT 
          id,
          name, 
          request_count, 
          last_used,
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
            ELSE NULL
          END as session_info
        FROM accounts
        ORDER BY request_count DESC
      `,
			)
			.all(now, now, now, sessionDuration);

		return new Response(JSON.stringify(accounts), {
			headers: { "Content-Type": "application/json" },
		});
	}

	private handleRequests(url: URL): Response {
		const limit = parseInt(url.searchParams.get("limit") || "50");
		const requests = this.db
			.query(
				`
        SELECT r.*, a.name as account_name
        FROM requests r
        LEFT JOIN accounts a ON r.account_used = a.id
        ORDER BY r.timestamp DESC
        LIMIT ?1
      `,
			)
			.all(limit);

		return new Response(JSON.stringify(requests), {
			headers: { "Content-Type": "application/json" },
		});
	}

	private handleGetConfig(): Response {
		const settings = this.config.getAllSettings();
		return new Response(JSON.stringify(settings), {
			headers: { "Content-Type": "application/json" },
		});
	}

	private handleGetStrategy(): Response {
		const strategy = this.config.getStrategy();
		return new Response(JSON.stringify({ strategy }), {
			headers: { "Content-Type": "application/json" },
		});
	}

	private async handleSetStrategy(req: Request): Promise<Response> {
		try {
			const body = (await req.json()) as { strategy: string };
			const { strategy } = body;

			if (!strategy || !isValidStrategy(strategy)) {
				return new Response(JSON.stringify({ error: "Invalid strategy" }), {
					status: 400,
					headers: { "Content-Type": "application/json" },
				});
			}

			this.config.setStrategy(strategy as StrategyName);

			return new Response(JSON.stringify({ success: true, strategy }), {
				headers: { "Content-Type": "application/json" },
			});
		} catch (_error) {
			return new Response(
				JSON.stringify({ error: "Failed to update strategy" }),
				{
					status: 500,
					headers: { "Content-Type": "application/json" },
				},
			);
		}
	}

	private async handleUpdateAccountTier(
		req: Request,
		accountId: string,
	): Promise<Response> {
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

			this.dbOps.updateAccountTier(accountId, tier);

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
	}
}
