import { dirname } from "node:path";
import { Config, type RuntimeConfig } from "@better-ccflare/config";
import {
	CACHE,
	DEFAULT_STRATEGY,
	getVersion,
	HTTP_STATUS,
	NETWORK,
	registerCleanup,
	registerDisposable,
	setPricingLogger,
	shutdown,
	TIME_CONSTANTS,
} from "@better-ccflare/core";
import { container, SERVICE_KEYS } from "@better-ccflare/core-di";
import type { DatabaseOperations } from "@better-ccflare/database";
import { AsyncDbWriter, DatabaseFactory } from "@better-ccflare/database";
import { APIRouter } from "@better-ccflare/http-api";
import { SessionStrategy } from "@better-ccflare/load-balancer";
import { Logger } from "@better-ccflare/logger";
import { getProvider, usageCache } from "@better-ccflare/providers";
import {
	AutoRefreshScheduler,
	getUsageWorker,
	getValidAccessToken,
	handleProxy,
	type ProxyContext,
	terminateUsageWorker,
} from "@better-ccflare/proxy";
import type { Account } from "@better-ccflare/types";
import { serve } from "bun";

// Import embedded dashboard assets (will be bundled in compiled binary)
let embeddedDashboard: Record<
	string,
	{ content: string; contentType: string }
> | null = null;
let dashboardManifest: Record<string, string> | null = null;

// Try to load embedded dashboard (will exist in production build)
try {
	const embedded = await import("@better-ccflare/dashboard-web/dist/embedded");
	embeddedDashboard = embedded.embeddedDashboard;
	dashboardManifest = embedded.dashboardManifest;
} catch {
	// Fallback: try loading from file system (development)
	try {
		const manifestModule = await import(
			"@better-ccflare/dashboard-web/dist/manifest.json"
		);
		dashboardManifest = manifestModule.default as Record<string, string>;
	} catch {
		console.warn("⚠️  Dashboard assets not found - dashboard will be disabled");
	}
}

// Helper function to resolve dashboard assets with fallback
function resolveDashboardAsset(assetPath: string): string | null {
	try {
		// Try resolving as a package first
		return Bun.resolveSync(
			`@better-ccflare/dashboard-web/dist${assetPath}`,
			dirname(import.meta.path),
		);
	} catch {
		// Fallback to relative path within the repo (development / mono-repo usage)
		try {
			return Bun.resolveSync(
				`../../../packages/dashboard-web/dist${assetPath}`,
				dirname(import.meta.path),
			);
		} catch {
			return null;
		}
	}
}

// Helper function to serve dashboard files with proper headers
function serveDashboardFile(
	assetPath: string,
	contentType?: string,
	cacheControl?: string,
): Response {
	// First, try to serve from embedded assets (production)
	if (embeddedDashboard?.[assetPath]) {
		const asset = embeddedDashboard[assetPath];
		const buffer = Buffer.from(asset.content, "base64");
		return new Response(buffer, {
			headers: {
				"Content-Type": contentType || asset.contentType,
				"Cache-Control": cacheControl || CACHE.CACHE_CONTROL_NO_CACHE,
			},
		});
	}

	// Fallback: try file system (development)
	const fullPath = resolveDashboardAsset(assetPath);
	if (!fullPath) {
		return new Response("Not Found", { status: HTTP_STATUS.NOT_FOUND });
	}

	// Auto-detect content type if not provided
	if (!contentType) {
		if (assetPath.endsWith(".js")) contentType = "application/javascript";
		else if (assetPath.endsWith(".css")) contentType = "text/css";
		else if (assetPath.endsWith(".html")) contentType = "text/html";
		else if (assetPath.endsWith(".json")) contentType = "application/json";
		else if (assetPath.endsWith(".svg")) contentType = "image/svg+xml";
		else contentType = "text/plain";
	}

	return new Response(Bun.file(fullPath), {
		headers: {
			"Content-Type": contentType,
			"Cache-Control": cacheControl || CACHE.CACHE_CONTROL_NO_CACHE,
		},
	});
}

// Module-level server instance
let serverInstance: ReturnType<typeof serve> | null = null;
let stopRetentionJob: (() => void) | null = null;
let stopOAuthCleanupJob: (() => void) | null = null;
let stopRateLimitCleanupJob: (() => void) | null = null;
let autoRefreshScheduler: AutoRefreshScheduler | null = null;

// Startup maintenance (one-shot): cleanup + compact
async function runStartupMaintenance(
	config: Config,
	dbOps: DatabaseOperations,
) {
	const log = new Logger("StartupMaintenance");
	try {
		const payloadDays = config.getDataRetentionDays();
		const requestDays = config.getRequestRetentionDays();
		const { removedRequests, removedPayloads } = dbOps.cleanupOldRequests(
			payloadDays * 24 * 60 * 60 * 1000,
			requestDays * 24 * 60 * 60 * 1000,
		);
		log.info(
			`Startup cleanup removed ${removedRequests} requests and ${removedPayloads} payloads (payload=${payloadDays}d, requests=${requestDays}d)`,
		);
	} catch (err) {
		log.error(`Startup cleanup error: ${err}`);
	}
	try {
		// Clean up expired OAuth sessions
		const removedSessions = dbOps.cleanupExpiredOAuthSessions();
		if (removedSessions > 0) {
			log.info(
				`Startup cleanup removed ${removedSessions} expired OAuth sessions`,
			);
		}
	} catch (err) {
		log.error(`OAuth session cleanup error: ${err}`);
	}
	try {
		// Clear expired rate_limited_until values
		const now = Date.now();
		const clearedCount = dbOps.clearExpiredRateLimits(now);
		if (clearedCount > 0) {
			log.info(`Cleared ${clearedCount} expired rate_limited_until entries`);
		} else {
			log.info("No expired rate_limited_until entries found to clear");
		}
	} catch (err) {
		log.error(`Rate limit cleanup error: ${err}`);
	}
	try {
		// Prune old agent workspaces (not seen in 7 days)
		const { agentRegistry } = await import("@better-ccflare/agents");
		await agentRegistry.pruneOldWorkspaces();
		log.info("Pruned old agent workspaces");
	} catch (err) {
		log.error(`Agent workspace pruning error: ${err}`);
	}
	try {
		dbOps.compact();
		log.info("Database compacted at startup");
	} catch (err) {
		log.error(`Database compaction error: ${err}`);
	}
	// Return a no-op stopper for compatibility
	return () => {};
}

/**
 * Start usage polling for an account with automatic token refresh
 * Temporarily resumes paused accounts for token refresh, then restores original state
 */
function startUsagePollingWithRefresh(
	account: Account,
	proxyContext: ProxyContext,
) {
	const logger = new Logger("UsagePolling");

	// Store original paused state to restore it later
	const wasOriginallyPaused = account.paused;

	// Initial polling with token refresh
	const pollWithRefresh = async () => {
		try {
			// Create a token provider function that gets a fresh token each time
			const tokenProvider = async () => {
				// If account was paused, temporarily resume it for token refresh
				if (wasOriginallyPaused && account.paused) {
					logger.debug(
						`Temporarily resuming account ${account.name} for token refresh`,
					);
					proxyContext.dbOps.resumeAccount(account.id);
					account.paused = false;
				}

				try {
					// Get a valid access token (refreshes if necessary)
					const accessToken = await getValidAccessToken(account, proxyContext);
					return accessToken;
				} finally {
					// Restore original paused state if we temporarily resumed it
					if (wasOriginallyPaused && !account.paused) {
						logger.debug(`Restoring paused state for account ${account.name}`);
						proxyContext.dbOps.pauseAccount(account.id);
						account.paused = true;
					}
				}
			};

			// Start usage polling with the token provider
			usageCache.startPolling(
				account.id,
				tokenProvider,
				account.provider,
				30000,
			); // Poll every 30s
		} catch (error) {
			logger.error(
				`Error starting usage polling for account ${account.name}:`,
				{
					error: error instanceof Error ? error.message : String(error),
					stack: error instanceof Error ? error.stack : undefined,
					accountId: account.id,
					provider: account.provider,
					timestamp: new Date().toISOString(),
					hasAccessToken: !!account.access_token,
					hasRefreshToken: !!account.refresh_token,
					expiresAt: account.expires_at
						? new Date(account.expires_at).toISOString()
						: null,
				},
			);

			// Log additional context for common error types
			if (error instanceof Error) {
				if (
					error.message.includes("401") ||
					error.message.includes("Unauthorized")
				) {
					logger.error(
						`Authentication failed for account ${account.name} - check API credentials`,
						{
							accountId: account.id,
							error: error.message,
						},
					);
				} else if (
					error.message.includes("network") ||
					error.message.includes("fetch")
				) {
					logger.error(
						`Network error for account ${account.name} - check connectivity`,
						{
							accountId: account.id,
							error: error.message,
						},
					);
				} else if (error.message.includes("rate limit")) {
					logger.error(
						`Rate limited for account ${account.name} - backing off`,
						{
							accountId: account.id,
							error: error.message,
						},
					);
				}
			}
			// Restore original paused state in case of error
			if (wasOriginallyPaused && !account.paused) {
				logger.info(
					`Restoring paused state for account ${account.name} after error`,
				);
				proxyContext.dbOps.pauseAccount(account.id);
				account.paused = true;
			}
			// Retry in 5 minutes if there was an error
			setTimeout(
				() => {
					logger.info(`Retrying usage polling for account ${account.name}`);
					pollWithRefresh();
				},
				5 * 60 * 1000,
			);
		}
	};

	// Start the polling
	pollWithRefresh();
}

// Export for programmatic use
export default function startServer(options?: {
	port?: number;
	withDashboard?: boolean;
}) {
	// Return existing server if already running
	if (serverInstance) {
		return {
			port: serverInstance.port,
			stop: () => {
				if (serverInstance) {
					serverInstance.stop();
					serverInstance = null;
				}
			},
		};
	}

	const { port = NETWORK.DEFAULT_PORT, withDashboard = true } = options || {};

	// Initialize DI container
	container.registerInstance(SERVICE_KEYS.Config, new Config());
	container.registerInstance(SERVICE_KEYS.Logger, new Logger("Server"));

	// Initialize components
	const config = container.resolve<Config>(SERVICE_KEYS.Config);
	const runtime = config.getRuntime();
	// Override port if provided
	if (port !== runtime.port) {
		runtime.port = port;
	}
	DatabaseFactory.initialize(undefined, runtime);
	const dbOps = DatabaseFactory.getInstance();
	const db = dbOps.getDatabase();
	const log = container.resolve<Logger>(SERVICE_KEYS.Logger);
	container.registerInstance(SERVICE_KEYS.Database, dbOps);

	// Initialize async DB writer
	const asyncWriter = new AsyncDbWriter();
	container.registerInstance(SERVICE_KEYS.AsyncWriter, asyncWriter);
	registerDisposable(asyncWriter);

	// Initialize pricing logger
	const pricingLogger = new Logger("Pricing");
	container.registerInstance(SERVICE_KEYS.PricingLogger, pricingLogger);
	setPricingLogger(pricingLogger);

	const apiRouter = new APIRouter({ db, config, dbOps });

	// Run startup maintenance once (cleanup + compact) - fire and forget
	runStartupMaintenance(config, dbOps).catch((err) => {
		log.error("Startup maintenance failed:", err);
	});
	stopRetentionJob = () => {}; // No-op stopper

	// Set up periodic OAuth session cleanup (every hour)
	const unregisterOAuthCleanup = registerCleanup({
		id: "oauth-session-cleanup",
		callback: () => {
			try {
				const removedSessions = dbOps.cleanupExpiredOAuthSessions();
				if (removedSessions > 0) {
					log.debug(`Cleaned up ${removedSessions} expired OAuth sessions`);
				}
			} catch (err) {
				log.error(`OAuth session cleanup error: ${err}`);
			}
		},
		minutes: 60,
		description: "OAuth session cleanup",
	});

	stopOAuthCleanupJob = unregisterOAuthCleanup;

	// Set up periodic rate limit cleanup (every hour)
	const unregisterRateLimitCleanup = registerCleanup({
		id: "rate-limit-cleanup",
		callback: () => {
			try {
				const now = Date.now();
				const clearedCount = dbOps.clearExpiredRateLimits(now);
				if (clearedCount > 0) {
					log.debug(
						`Cleared ${clearedCount} expired rate_limited_until entries`,
					);
				}
			} catch (err) {
				log.error(`Rate limit cleanup error: ${err}`);
			}
		},
		minutes: 60,
		description: "Rate limit cleanup",
	});

	stopRateLimitCleanupJob = unregisterRateLimitCleanup;

	// Initialize load balancing strategy (will be created after runtime config)

	// Get the provider
	const provider = getProvider("anthropic");
	if (!provider) {
		throw new Error("Anthropic provider not available");
	}

	// Create runtime config
	const runtimeConfig: RuntimeConfig = {
		clientId: config.get(
			"client_id",
			"9d1c250a-e61b-44d9-88ed-5944d1962f5e",
		) as string,
		retry: {
			attempts: config.get("retry_attempts", 3) as number,
			delayMs: config.get("retry_delay_ms", 1000) as number,
			backoff: config.get("retry_backoff", 2) as number,
		},
		sessionDurationMs: config.get(
			"session_duration_ms",
			TIME_CONSTANTS.SESSION_DURATION_DEFAULT,
		) as number,
		port,
	};

	// Now create the strategy with runtime config
	const strategy = new SessionStrategy(runtimeConfig.sessionDurationMs);
	strategy.initialize(dbOps);

	// Proxy context
	const proxyContext: ProxyContext = {
		strategy,
		dbOps,
		runtime: runtimeConfig,
		provider,
		refreshInFlight: new Map(),
		asyncWriter,
		usageWorker: getUsageWorker(),
	};

	// Initialize auto-refresh scheduler (now that proxyContext is available)
	autoRefreshScheduler = new AutoRefreshScheduler(db, proxyContext);
	autoRefreshScheduler.start();

	// Hot reload strategy configuration
	config.on("change", (changeType, fieldName) => {
		if (fieldName === "strategy") {
			log.info(`Strategy configuration changed: ${changeType}`);
			const newStrategyName = config.getStrategy();
			// For now, only SessionStrategy is supported
			if (newStrategyName === "session") {
				const strategy = new SessionStrategy(runtimeConfig.sessionDurationMs);
				strategy.initialize(dbOps);
				proxyContext.strategy = strategy;
			}
		}
	});

	// Main server
	try {
		serverInstance = serve({
			port: runtime.port,
			idleTimeout: NETWORK.IDLE_TIMEOUT_MAX, // Max allowed by Bun
			async fetch(req) {
				const url = new URL(req.url);

				// Try API routes first
				const apiResponse = await apiRouter.handleRequest(url, req);
				if (apiResponse) {
					return apiResponse;
				}

				// Dashboard routes (only if enabled and assets are available)
				if (withDashboard && dashboardManifest) {
					// Serve dashboard static assets
					if (dashboardManifest[url.pathname]) {
						return serveDashboardFile(
							url.pathname,
							undefined,
							CACHE.CACHE_CONTROL_STATIC,
						);
					}

					// For all non-API routes, serve the dashboard index.html (client-side routing)
					// This allows React Router to handle all dashboard routes without maintaining a list
					if (
						!url.pathname.startsWith("/api/") &&
						!url.pathname.startsWith("/v1/")
					) {
						return serveDashboardFile("/index.html", "text/html");
					}
				}

				// All other paths go to proxy
				return handleProxy(req, url, proxyContext);
			},
		});
	} catch (error) {
		if (
			typeof error === "object" &&
			error !== null &&
			"code" in error &&
			error.code === "EADDRINUSE"
		) {
			console.error(
				`❌ Port ${runtime.port} is already in use. Please use a different port.`,
			);
			console.error(
				`   You can specify a different port with: --port <number>`,
			);
			void shutdown(); // Don't await to avoid async issues in catch
			process.exit(1);
		}
		throw error;
	}

	// Log server startup (async)
	getVersion().then((version) => {
		if (!serverInstance) return;
		const dashboardStatus =
			withDashboard && dashboardManifest
				? `http://localhost:${serverInstance.port}`
				: withDashboard && !dashboardManifest
					? "unavailable (assets not found)"
					: "disabled";
		console.log(`
🎯 better-ccflare Server v${version}
🌐 Port: ${serverInstance.port}
📊 Dashboard: ${dashboardStatus}
🔗 API Base: http://localhost:${serverInstance.port}/api

Available endpoints:
- POST   http://localhost:${serverInstance.port}/v1/*            → Proxy to Claude API
- GET    http://localhost:${serverInstance.port}/api/accounts    → List accounts
- POST   http://localhost:${serverInstance.port}/api/accounts    → Add account
- DELETE http://localhost:${serverInstance.port}/api/accounts/:id → Remove account
- GET    http://localhost:${serverInstance.port}/api/stats       → View statistics
- POST   http://localhost:${serverInstance.port}/api/stats/reset → Reset statistics
- GET    http://localhost:${serverInstance.port}/api/config      → View configuration
- PATCH  http://localhost:${serverInstance.port}/api/config      → Update configuration

⚡ Ready to proxy requests...
`);
	});

	// Log configuration
	console.log(
		`⚙️  Current strategy: ${config.getStrategy()} (default: ${DEFAULT_STRATEGY})`,
	);

	// Log initial account status
	const accounts = dbOps.getAllAccounts();
	const activeAccounts = accounts.filter(
		(a) => !a.paused && (!a.expires_at || a.expires_at > Date.now()),
	);
	log.info(
		`Loaded ${accounts.length} accounts (${activeAccounts.length} active)`,
	);
	if (activeAccounts.length === 0) {
		log.warn(
			"No active accounts available - requests will be forwarded without authentication",
		);
	}

	// Start usage polling for Anthropic accounts with token refresh (regardless of paused status)
	const anthropicAccounts = accounts.filter((a) => a.provider === "anthropic");
	if (anthropicAccounts.length > 0) {
		log.info(
			`Found ${anthropicAccounts.length} Anthropic accounts, starting usage polling...`,
		);
		for (const account of anthropicAccounts) {
			log.debug(`Processing account: ${account.name}`, {
				accountId: account.id,
				hasAccessToken: !!account.access_token,
				hasRefreshToken: !!account.refresh_token,
				paused: account.paused,
				expiresAt: account.expires_at
					? new Date(account.expires_at).toISOString()
					: null,
			});

			if (account.access_token || account.refresh_token) {
				// Start usage polling with token refresh capability
				// Usage data fetching should work independently of account paused status
				startUsagePollingWithRefresh(account, proxyContext);
				log.info(`Started usage polling for account ${account.name}`);
			} else {
				log.warn(
					`Account ${account.name} has no access token or refresh token, skipping usage polling`,
				);
			}
		}
	} else {
		log.info(`No Anthropic accounts found, usage polling will not start`);
	}

	return {
		port: serverInstance.port,
		stop: () => {
			if (serverInstance) {
				serverInstance.stop();
				serverInstance = null;
			}
		},
	};
}

// Graceful shutdown handler
async function handleGracefulShutdown(signal: string) {
	console.log(`\n👋 Received ${signal}, shutting down gracefully...`);
	try {
		if (stopRetentionJob) {
			stopRetentionJob();
			stopRetentionJob = null;
		}
		if (stopOAuthCleanupJob) {
			stopOAuthCleanupJob();
			stopOAuthCleanupJob = null;
		}
		if (stopRateLimitCleanupJob) {
			stopRateLimitCleanupJob();
			stopRateLimitCleanupJob = null;
		}
		if (autoRefreshScheduler) {
			autoRefreshScheduler.stop();
			autoRefreshScheduler = null;
		}
		usageCache.clear(); // Stop all usage polling
		terminateUsageWorker();
		await shutdown();
		console.log("✅ Shutdown complete");
		process.exit(0);
	} catch (error) {
		console.error("❌ Error during shutdown:", error);
		process.exit(1);
	}
}

// Register signal handlers
process.on("SIGINT", () => handleGracefulShutdown("SIGINT"));
process.on("SIGTERM", () => handleGracefulShutdown("SIGTERM"));

// Run server if this is the main entry point
if (import.meta.main) {
	// Parse command line arguments
	const args = process.argv.slice(2);
	let port: number | undefined;

	for (let i = 0; i < args.length; i++) {
		if (args[i] === "--port" && args[i + 1]) {
			port = Number.parseInt(args[i + 1]);
			i++; // Skip next arg
		}
	}

	// Use PORT env var if no command line argument
	if (!port && process.env.PORT) {
		port = Number.parseInt(process.env.PORT);
	}

	startServer({ port });
}
