import { validateNumber } from "@better-ccflare/core";
import { Unauthorized } from "@better-ccflare/errors";
import {
	createAccountAddHandler,
	createAccountAutoFallbackHandler,
	createAccountAutoRefreshHandler,
	createAccountCustomEndpointUpdateHandler,
	createAccountModelMappingsUpdateHandler,
	createAccountPauseHandler,
	createAccountPriorityUpdateHandler,
	createAccountReloadHandler,
	createAccountRemoveHandler,
	createAccountRenameHandler,
	createAccountResumeHandler,
	createAccountsListHandler,
	createAccountTierUpdateHandler,
	createAnthropicCompatibleAccountAddHandler,
	createMinimaxAccountAddHandler,
	createOpenAIAccountAddHandler,
	createZaiAccountAddHandler,
} from "./handlers/accounts";
import {
	createAgentPreferenceUpdateHandler,
	createAgentsListHandler,
	createBulkAgentPreferenceUpdateHandler,
	createWorkspacesListHandler,
} from "./handlers/agents";
import { createAgentUpdateHandler } from "./handlers/agents-update";
import { createAnalyticsHandler } from "./handlers/analytics";
import {
	createApiKeyDeleteHandler,
	createApiKeyDisableHandler,
	createApiKeyEnableHandler,
	createApiKeysGenerateHandler,
	createApiKeysListHandler,
	createApiKeysStatsHandler,
} from "./handlers/api-keys";
import { createConfigHandlers } from "./handlers/config";
import { createHealthHandler } from "./handlers/health";
import { createLogsStreamHandler } from "./handlers/logs";
import { createLogsHistoryHandler } from "./handlers/logs-history";
import {
	createCleanupHandler,
	createCompactHandler,
} from "./handlers/maintenance";
import {
	createOAuthCallbackHandler,
	createOAuthInitHandler,
} from "./handlers/oauth";
import {
	createRequestPayloadHandler,
	createRequestsDetailHandler,
	createRequestsSummaryHandler,
} from "./handlers/requests";
import { createRequestsStreamHandler } from "./handlers/requests-stream";
import { createStatsHandler, createStatsResetHandler } from "./handlers/stats";
import { createSystemInfoHandler } from "./handlers/system";
import { AuthService } from "./services/auth-service";
import type { APIContext } from "./types";
import { errorResponse } from "./utils/http-error";

/**
 * API Router that handles all API endpoints
 */
export class APIRouter {
	private context: APIContext;
	private handlers: Map<
		string,
		(req: Request, url: URL) => Response | Promise<Response>
	>;
	private authService: AuthService;

	constructor(context: APIContext) {
		this.context = context;
		this.handlers = new Map();
		this.authService = new AuthService(context.dbOps);
		this.registerHandlers();
	}

	private registerHandlers(): void {
		const { db, config, dbOps } = this.context;

		// Create handlers
		const healthHandler = createHealthHandler(db, config);
		const statsHandler = createStatsHandler(dbOps);
		const statsResetHandler = createStatsResetHandler(dbOps);
		const accountsHandler = createAccountsListHandler(db);
		const accountAddHandler = createAccountAddHandler(dbOps, config);
		const zaiAccountAddHandler = createZaiAccountAddHandler(dbOps);
		const minimaxAccountAddHandler = createMinimaxAccountAddHandler(dbOps);
		const anthropicCompatibleAccountAddHandler = createAnthropicCompatibleAccountAddHandler(dbOps);
		const openaiAccountAddHandler = createOpenAIAccountAddHandler(dbOps);
		const _accountRemoveHandler = createAccountRemoveHandler(dbOps);
		const _accountTierHandler = createAccountTierUpdateHandler(dbOps);
		const requestsSummaryHandler = createRequestsSummaryHandler(db);
		const requestsDetailHandler = createRequestsDetailHandler(dbOps);
		const configHandlers = createConfigHandlers(config, this.context.runtime);
		const logsStreamHandler = createLogsStreamHandler();
		const logsHistoryHandler = createLogsHistoryHandler();
		const analyticsHandler = createAnalyticsHandler(this.context);
		const oauthInitHandler = createOAuthInitHandler(dbOps);
		const oauthCallbackHandler = createOAuthCallbackHandler(dbOps);
		const agentsHandler = createAgentsListHandler(dbOps);
		const workspacesHandler = createWorkspacesListHandler();
		const requestsStreamHandler = createRequestsStreamHandler();
		const cleanupHandler = createCleanupHandler(dbOps, config);
		const compactHandler = createCompactHandler(dbOps);
		const systemInfoHandler = createSystemInfoHandler();

		// API Key handlers
		const apiKeysListHandler = createApiKeysListHandler(dbOps);
		const apiKeysGenerateHandler = createApiKeysGenerateHandler(dbOps);
		const apiKeysStatsHandler = createApiKeysStatsHandler(dbOps);

		// Register routes
		this.handlers.set("GET:/health", () => healthHandler());
		this.handlers.set("GET:/api/stats", () => statsHandler());
		this.handlers.set("POST:/api/stats/reset", () => statsResetHandler());
		this.handlers.set("GET:/api/accounts", () => accountsHandler());
		this.handlers.set("POST:/api/accounts", (req) => accountAddHandler(req));
		this.handlers.set("POST:/api/accounts/zai", (req) =>
			zaiAccountAddHandler(req),
		);
		this.handlers.set("POST:/api/accounts/minimax", (req) =>
			minimaxAccountAddHandler(req),
		);
		this.handlers.set("POST:/api/accounts/anthropic-compatible", (req) =>
			anthropicCompatibleAccountAddHandler(req),
		);
		this.handlers.set("POST:/api/accounts/openai-compatible", (req) =>
			openaiAccountAddHandler(req),
		);
		this.handlers.set("POST:/api/oauth/init", (req) => oauthInitHandler(req));
		this.handlers.set("POST:/api/oauth/callback", (req) =>
			oauthCallbackHandler(req),
		);
		this.handlers.set("GET:/api/requests", (_req, url) => {
			const limitParam = url.searchParams.get("limit");
			const limit =
				validateNumber(limitParam || "50", "limit", {
					min: 1,
					max: 1000,
					integer: true,
				}) || 50;
			return requestsSummaryHandler(limit);
		});
		this.handlers.set("GET:/api/requests/detail", (_req, url) => {
			const limitParam = url.searchParams.get("limit");
			const limit =
				validateNumber(limitParam || "100", "limit", {
					min: 1,
					max: 1000,
					integer: true,
				}) || 100;
			return requestsDetailHandler(limit);
		});
		this.handlers.set("GET:/api/requests/stream", (req) =>
			requestsStreamHandler(req),
		);
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
		this.handlers.set("GET:/api/config/model", () =>
			configHandlers.getDefaultAgentModel(),
		);
		this.handlers.set("POST:/api/config/model", (req) =>
			configHandlers.setDefaultAgentModel(req),
		);
		this.handlers.set("GET:/api/config/retention", () =>
			configHandlers.getRetention(),
		);
		this.handlers.set("POST:/api/config/retention", (req) =>
			configHandlers.setRetention(req),
		);
		this.handlers.set("POST:/api/maintenance/cleanup", () => cleanupHandler());
		this.handlers.set("POST:/api/maintenance/compact", () => compactHandler());
		this.handlers.set("GET:/api/system/info", () => systemInfoHandler());
		this.handlers.set("GET:/api/logs/stream", (req) => logsStreamHandler(req));
		this.handlers.set("GET:/api/logs/history", () => logsHistoryHandler());
		this.handlers.set("GET:/api/analytics", (_req, url) => {
			return analyticsHandler(url.searchParams);
		});
		this.handlers.set("GET:/api/agents", () => agentsHandler());
		this.handlers.set("POST:/api/agents/bulk-preference", (req) => {
			const bulkHandler = createBulkAgentPreferenceUpdateHandler(
				this.context.dbOps,
			);
			return bulkHandler(req);
		});
		this.handlers.set("GET:/api/workspaces", () => workspacesHandler());

		// API Key routes
		this.handlers.set("GET:/api/api-keys", () => apiKeysListHandler());
		this.handlers.set("POST:/api/api-keys", (req) =>
			apiKeysGenerateHandler(req),
		);
		this.handlers.set("GET:/api/api-keys/stats", () => apiKeysStatsHandler());
	}

	/**
	 * Wrap a handler with error handling
	 */
	private wrapHandler(
		handler: (req: Request, url: URL) => Response | Promise<Response>,
	): (req: Request, url: URL) => Promise<Response> {
		return async (req: Request, url: URL) => {
			try {
				return await handler(req, url);
			} catch (error) {
				return errorResponse(error);
			}
		};
	}

	/**
	 * Handle an incoming request
	 */
	async handleRequest(url: URL, req: Request): Promise<Response | null> {
		const path = url.pathname;
		const method = req.method;
		const key = `${method}:${path}`;

		// Authenticate the request
		const authResult = await this.authService.authenticateRequest(
			req,
			path,
			method,
		);
		if (!authResult.isAuthenticated) {
			return errorResponse(
				Unauthorized(authResult.error || "Authentication failed"),
			);
		}

		// Check for exact match
		const handler = this.handlers.get(key);
		if (handler) {
			return await this.wrapHandler(handler)(req, url);
		}

		// Check for dynamic request payload endpoint
		if (path.startsWith("/api/requests/payload/") && method === "GET") {
			const parts = path.split("/");
			const requestId = parts[4];
			if (requestId) {
				const payloadHandler = createRequestPayloadHandler(this.context.dbOps);
				return await this.wrapHandler(() => payloadHandler(requestId))(
					req,
					url,
				);
			}
		}

		// Check for dynamic account endpoints
		if (path.startsWith("/api/accounts/")) {
			const parts = path.split("/");
			const accountId = parts[3];

			// Account tier update
			if (path.endsWith("/tier") && method === "POST") {
				const tierHandler = createAccountTierUpdateHandler(this.context.dbOps);
				return await this.wrapHandler((req) => tierHandler(req, accountId))(
					req,
					url,
				);
			}

			// Account pause
			if (path.endsWith("/pause") && method === "POST") {
				const pauseHandler = createAccountPauseHandler(this.context.dbOps);
				return await this.wrapHandler((req) => pauseHandler(req, accountId))(
					req,
					url,
				);
			}

			// Account resume
			if (path.endsWith("/resume") && method === "POST") {
				const resumeHandler = createAccountResumeHandler(this.context.dbOps);
				return await this.wrapHandler((req) => resumeHandler(req, accountId))(
					req,
					url,
				);
			}

			// Account reload
			if (path.endsWith("/reload") && method === "POST") {
				const reloadHandler = createAccountReloadHandler(this.context.dbOps);
				return await this.wrapHandler((req) => reloadHandler(req, accountId))(
					req,
					url,
				);
			}

			// Account rename
			if (path.endsWith("/rename") && method === "POST") {
				const renameHandler = createAccountRenameHandler(this.context.dbOps);
				return await this.wrapHandler((req) => renameHandler(req, accountId))(
					req,
					url,
				);
			}

			// Account priority update
			if (path.endsWith("/priority") && method === "POST") {
				const priorityHandler = createAccountPriorityUpdateHandler(
					this.context.dbOps,
				);
				return await this.wrapHandler((req) => priorityHandler(req, accountId))(
					req,
					url,
				);
			}
			// Account auto-fallback toggle
			if (path.endsWith("/auto-fallback") && method === "POST") {
				const autoFallbackHandler = createAccountAutoFallbackHandler(
					this.context.dbOps,
				);
				return await this.wrapHandler((req) =>
					autoFallbackHandler(req, accountId),
				)(req, url);
			}

			// Account auto-refresh toggle
			if (path.endsWith("/auto-refresh") && method === "POST") {
				const autoRefreshHandler = createAccountAutoRefreshHandler(
					this.context.dbOps,
				);
				return await this.wrapHandler((req) =>
					autoRefreshHandler(req, accountId),
				)(req, url);
			}

			// Account custom endpoint update
			if (path.endsWith("/custom-endpoint") && method === "POST") {
				const customEndpointHandler = createAccountCustomEndpointUpdateHandler(
					this.context.dbOps,
				);
				return await this.wrapHandler((req) =>
					customEndpointHandler(req, accountId),
				)(req, url);
			}

			// Account model mappings update
			if (path.endsWith("/model-mappings") && method === "POST") {
				const modelMappingsHandler = createAccountModelMappingsUpdateHandler(
					this.context.dbOps,
				);
				return await this.wrapHandler((req) =>
					modelMappingsHandler(req, accountId),
				)(req, url);
			}

			// Account removal
			if (parts.length === 4 && method === "DELETE") {
				const removeHandler = createAccountRemoveHandler(this.context.dbOps);
				return await this.wrapHandler((req) => removeHandler(req, accountId))(
					req,
					url,
				);
			}
		}

		// Check for dynamic agent endpoints
		if (path.startsWith("/api/agents/")) {
			const parts = path.split("/");
			const agentId = parts[3];

			// Agent preference update
			if (path.endsWith("/preference") && method === "POST") {
				const preferenceHandler = createAgentPreferenceUpdateHandler(
					this.context.dbOps,
				);
				return await this.wrapHandler((req) => preferenceHandler(req, agentId))(
					req,
					url,
				);
			}

			// Agent update (PATCH /api/agents/:id)
			if (parts.length === 4 && method === "PATCH") {
				const updateHandler = createAgentUpdateHandler(this.context.dbOps);
				return await this.wrapHandler((req) => updateHandler(req, agentId))(
					req,
					url,
				);
			}
		}

		// Check for dynamic API key endpoints
		if (path.startsWith("/api/api-keys/")) {
			const parts = path.split("/");
			const keyName = decodeURIComponent(parts[3]); // Decode URL-encoded names

			// API key disable
			if (path.endsWith("/disable") && method === "POST") {
				const disableHandler = createApiKeyDisableHandler(this.context.dbOps);
				return await this.wrapHandler((req) => disableHandler(req, keyName))(
					req,
					url,
				);
			}

			// API key enable
			if (path.endsWith("/enable") && method === "POST") {
				const enableHandler = createApiKeyEnableHandler(this.context.dbOps);
				return await this.wrapHandler((req) => enableHandler(req, keyName))(
					req,
					url,
				);
			}

			// API key delete
			if (parts.length === 4 && method === "DELETE") {
				const deleteHandler = createApiKeyDeleteHandler(this.context.dbOps);
				return await this.wrapHandler((req) => deleteHandler(req, keyName))(
					req,
					url,
				);
			}
		}

		// No matching route
		return null;
	}
}
