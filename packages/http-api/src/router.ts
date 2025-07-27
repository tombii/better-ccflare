import type { APIContext } from "./types.js";
import { createHealthHandler } from "./handlers/health.js";
import { createStatsHandler } from "./handlers/stats.js";
import {
	createAccountsListHandler,
	createAccountTierUpdateHandler,
} from "./handlers/accounts.js";
import { createRequestsHandler } from "./handlers/requests.js";
import { createConfigHandlers } from "./handlers/config.js";

/**
 * API Router that handles all API endpoints
 */
export class APIRouter {
	private context: APIContext;
	private handlers: Map<
		string,
		(req: Request, url: URL) => Response | Promise<Response>
	>;

	constructor(context: APIContext) {
		this.context = context;
		this.handlers = new Map();
		this.registerHandlers();
	}

	private registerHandlers(): void {
		const { db, config, dbOps } = this.context;

		// Create handlers
		const healthHandler = createHealthHandler(db, config);
		const statsHandler = createStatsHandler(db);
		const accountsHandler = createAccountsListHandler(db);
		const _accountTierHandler = createAccountTierUpdateHandler(dbOps);
		const requestsHandler = createRequestsHandler(db);
		const configHandlers = createConfigHandlers(config);

		// Register routes
		this.handlers.set("GET:/health", () => healthHandler());
		this.handlers.set("GET:/api/stats", () => statsHandler());
		this.handlers.set("GET:/api/accounts", () => accountsHandler());
		this.handlers.set("GET:/api/requests", (_req, url) => {
			const limit = parseInt(url.searchParams.get("limit") || "50");
			return requestsHandler(limit);
		});
		this.handlers.set("GET:/api/config", () => configHandlers.getConfig());
		this.handlers.set("GET:/api/config/strategy", () =>
			configHandlers.getStrategy(),
		);
		this.handlers.set("POST:/api/config/strategy", (req) =>
			configHandlers.setStrategy(req),
		);
		this.handlers.set("GET:/api/strategies", () =>
			configHandlers.getStrategies(),
		);
	}

	/**
	 * Handle an incoming request
	 */
	async handleRequest(url: URL, req: Request): Promise<Response | null> {
		const path = url.pathname;
		const method = req.method;
		const key = `${method}:${path}`;

		// Check for exact match
		const handler = this.handlers.get(key);
		if (handler) {
			return await handler(req, url);
		}

		// Check for account tier update endpoint (dynamic path)
		if (
			path.startsWith("/api/accounts/") &&
			path.endsWith("/tier") &&
			method === "POST"
		) {
			const accountId = path.split("/")[3];
			const tierHandler = createAccountTierUpdateHandler(this.context.dbOps);
			return await tierHandler(req, accountId);
		}

		// No matching route
		return null;
	}
}
