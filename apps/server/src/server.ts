import { existsSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { Config, type RuntimeConfig } from "@better-ccflare/config";
import {
	CACHE,
	DEFAULT_STRATEGY,
	getVersion,
	HTTP_STATUS,
	initializeNanoGPTPricingIfAccountsExist,
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
import { APIRouter, AuthService } from "@better-ccflare/http-api";
import { SessionStrategy } from "@better-ccflare/load-balancer";
import { Logger } from "@better-ccflare/logger";
import { getProvider, usageCache } from "@better-ccflare/providers";
import {
	canUseInferenceProfileDynamic,
	parseBedrockConfig,
	translateModelName,
} from "@better-ccflare/providers/bedrock";
import {
	AutoRefreshScheduler,
	getUsageWorker,
	getValidAccessToken,
	handleProxy,
	type ProxyContext,
	registerRefreshClearer,
	startGlobalTokenHealthChecks,
	stopGlobalTokenHealthChecks,
	terminateUsageWorker,
} from "@better-ccflare/proxy";
import { validatePathOrThrow } from "@better-ccflare/security";
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
	// Security headers for dashboard files
	const securityHeaders: Record<string, string> = {
		"X-Content-Type-Options": "nosniff",
		"X-Frame-Options": "DENY",
		"X-XSS-Protection": "1; mode=block",
		"Referrer-Policy": "strict-origin-when-cross-origin",
	};

	// Add Content Security Policy for HTML files
	const isHtml = assetPath.endsWith(".html") || contentType === "text/html";
	if (isHtml) {
		// Strict CSP for React apps: only bundled scripts and styles from same origin
		securityHeaders["Content-Security-Policy"] = [
			"default-src 'self'",
			"script-src 'self'", // Only bundled scripts from same origin (no inline)
			"style-src 'self' 'unsafe-inline'", // CSS-in-JS and Tailwind require inline styles
			"img-src 'self' data:",
			"font-src 'self' data:",
			"connect-src 'self'", // API calls to same origin only
			"frame-ancestors 'none'",
			"base-uri 'self'",
			"form-action 'self'",
		].join("; ");
	}

	// First, try to serve from embedded assets (production)
	if (embeddedDashboard?.[assetPath]) {
		const asset = embeddedDashboard[assetPath];
		const buffer = Buffer.from(asset.content, "base64");
		return new Response(buffer, {
			headers: {
				"Content-Type": contentType || asset.contentType,
				"Cache-Control": cacheControl || CACHE.CACHE_CONTROL_NO_CACHE,
				...securityHeaders,
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
			...securityHeaders,
		},
	});
}

// Module-level server instance
let serverInstance: ReturnType<typeof serve> | null = null;
let stopRetentionJob: (() => void) | null = null;
let stopOAuthCleanupJob: (() => void) | null = null;
let stopRateLimitCleanupJob: (() => void) | null = null;
let autoRefreshScheduler: AutoRefreshScheduler | null = null;
// Track usage polling retry timeouts for cleanup
const usagePollingRetryTimeouts = new Map<string, NodeJS.Timeout>();

// SSL/TLS configuration
let tlsEnabled = false;

// Startup maintenance (one-shot): cleanup only (compaction available via API endpoint)
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
	// Return a no-op stopper for compatibility
	return () => {};
}

/**
 * Pre-warm Bedrock model and inference profile caches for faster first request
 */
async function prewarmBedrockCache(account: Account, region: string) {
	const logger = new Logger("BedrockCachePrewarm");

	try {
		// Pre-warm model cache
		await translateModelName("claude-opus-4-6", account);

		// Pre-warm inference profile cache
		await canUseInferenceProfileDynamic(
			"claude-opus-4-6",
			"geographic",
			account,
		);

		logger.info(`Successfully pre-warmed Bedrock caches for region ${region}`);
	} catch (error) {
		logger.error(
			`Failed to pre-warm Bedrock caches for region ${region}: ${(error as Error).message}`,
		);
	}
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
	const MAX_RETRY_ATTEMPTS = 10;
	let retryCount = 0;

	// Initial polling with token refresh
	const pollWithRefresh = async () => {
		try {
			// Create a token provider function that gets a fresh token each time
			const tokenProvider = async () => {
				// Get the current paused state from the database to avoid stale state issues
				// This is important because the account might be paused/resumed via API during runtime
				const currentAccount = proxyContext.dbOps.getAccount(account.id);
				const wasTemporarilyResumed = currentAccount?.paused === true;

				// Update in-memory account with fresh token data from DB
				// This prevents using stale tokens after re-authentication
				if (currentAccount) {
					account.access_token = currentAccount.access_token;
					account.refresh_token = currentAccount.refresh_token;
					account.expires_at = currentAccount.expires_at;
				}

				// If account is currently paused, temporarily resume it for token refresh
				if (wasTemporarilyResumed) {
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
					// Restore paused state ONLY if we temporarily resumed it above
					if (wasTemporarilyResumed) {
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

			// Reset retry count on success
			retryCount = 0;
			// Clear any tracked timeout since we succeeded
			const existingTimeout = usagePollingRetryTimeouts.get(account.id);
			if (existingTimeout) {
				clearTimeout(existingTimeout);
				usagePollingRetryTimeouts.delete(account.id);
			}
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

			// Clear any existing retry timeout before scheduling a new one
			const existingTimeout = usagePollingRetryTimeouts.get(account.id);
			if (existingTimeout) {
				clearTimeout(existingTimeout);
				usagePollingRetryTimeouts.delete(account.id);
			}

			// Check if we've exceeded max retry attempts
			retryCount++;
			if (retryCount >= MAX_RETRY_ATTEMPTS) {
				logger.error(
					`Max retry attempts (${MAX_RETRY_ATTEMPTS}) reached for account ${account.name}. Please check the account configuration and try restarting the server after resolving issues.`,
				);
				return;
			}

			// Don't restore paused state on error - let the user control pause/resume via API
			// Retry with exponential backoff (5 min, 10 min, 20 min, ...)
			const baseDelayMs = 5 * 60 * 1000; // 5 minutes
			const delayMs = Math.min(
				baseDelayMs * 2 ** (retryCount - 1),
				60 * 60 * 1000, // Cap at 1 hour
			);
			logger.info(
				`Scheduling retry ${retryCount}/${MAX_RETRY_ATTEMPTS} for account ${account.name} in ${Math.round(delayMs / 1000 / 60)} minutes`,
			);

			const timeoutId = setTimeout(() => {
				logger.info(
					`Retrying usage polling for account ${account.name} (attempt ${retryCount}/${MAX_RETRY_ATTEMPTS})`,
				);
				usagePollingRetryTimeouts.delete(account.id);
				pollWithRefresh();
			}, delayMs);

			// Track the timeout for cleanup
			usagePollingRetryTimeouts.set(account.id, timeoutId);
		}
	};

	// Start the polling
	pollWithRefresh();
}

// Export for programmatic use
export default function startServer(options?: {
	port?: number;
	withDashboard?: boolean;
	sslKeyPath?: string;
	sslCertPath?: string;
}) {
	// Return existing server if already running
	if (serverInstance) {
		const existingPort = serverInstance.port;
		if (typeof existingPort !== "number") {
			throw new Error("Server instance has no valid port");
		}
		return {
			port: existingPort,
			stop: () => {
				if (serverInstance) {
					serverInstance.stop();
					serverInstance = null;
				}
			},
		};
	}

	const {
		port = NETWORK.DEFAULT_PORT,
		withDashboard = true,
		sslKeyPath,
		sslCertPath,
	} = options || {};

	// Enable TLS if both certificate paths are provided
	tlsEnabled = !!(sslKeyPath && sslCertPath);

	// Validate SSL certificate files if TLS is enabled
	let validatedSslKeyPath: string | undefined;
	let validatedSslCertPath: string | undefined;

	if (tlsEnabled && sslKeyPath && sslCertPath) {
		// Validate paths for security (prevent path traversal)
		try {
			validatedSslKeyPath = validatePathOrThrow(sslKeyPath, {
				description: "SSL key file",
			});
			validatedSslCertPath = validatePathOrThrow(sslCertPath, {
				description: "SSL certificate file",
			});
		} catch (error) {
			// Don't expose path details in error messages - log to server only
			console.error("SSL file path validation failed", {
				error: error instanceof Error ? error.message : String(error),
			});
			throw new Error(
				"SSL file path validation failed. Check server logs for details.",
			);
		}

		if (!existsSync(validatedSslKeyPath)) {
			// Don't expose paths in error messages
			console.error("SSL key file not found", {
				path: validatedSslKeyPath,
			});
			throw new Error("SSL key file not found. Check server logs for details.");
		}
		if (!existsSync(validatedSslCertPath)) {
			// Don't expose paths in error messages
			console.error("SSL certificate file not found", {
				path: validatedSslCertPath,
			});
			throw new Error(
				"SSL certificate file not found. Check server logs for details.",
			);
		}
	}

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

	// Run integrity check if database was initialized in fast mode
	dbOps.runIntegrityCheck();

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

	const apiRouter = new APIRouter({
		db,
		config,
		dbOps,
		runtime: {
			port,
			tlsEnabled,
		},
	});

	// Initialize AuthService for proxy authentication
	const authService = new AuthService(dbOps);

	// Run startup maintenance once (cleanup only) - fire and forget
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

	// Register this server's refresh clearing capability
	const serverId = `server-${runtime.port}`;
	registerRefreshClearer(serverId, (accountId: string) => {
		// Clear refresh cache for this account in this server's context
		proxyContext.refreshInFlight.delete(accountId);
		log.info(`Cleared refresh cache for account ${accountId} on ${serverId}`);
	});

	// Initialize auto-refresh scheduler (now that proxyContext is available)
	autoRefreshScheduler = new AutoRefreshScheduler(db, proxyContext);
	autoRefreshScheduler.start();

	// Initialize token health monitoring service
	startGlobalTokenHealthChecks(() => dbOps.getAllAccounts());

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
	// Build server configuration with optional TLS and hostname binding
	const hostname = process.env.BETTER_CCFLARE_HOST || "0.0.0.0"; // Allow binding configuration
	try {
		const serverConfig = {
			port: runtime.port,
			hostname,
			idleTimeout: NETWORK.IDLE_TIMEOUT_MAX, // Max allowed by Bun
			...(tlsEnabled && validatedSslKeyPath && validatedSslCertPath
				? {
						tls: {
							key: readFileSync(validatedSslKeyPath),
							cert: readFileSync(validatedSslCertPath),
						},
					}
				: {}),
			async fetch(req: Request) {
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
				// Authenticate the proxy request with error handling to prevent bypass
				try {
					const authResult = await authService.authenticateRequest(
						req,
						url.pathname,
						req.method,
					);
					if (!authResult.isAuthenticated) {
						return new Response(
							JSON.stringify({
								type: "error",
								error: {
									type: "authentication_error",
									message: authResult.error || "Authentication failed",
								},
							}),
							{
								status: 401,
								headers: { "Content-Type": "application/json" },
							},
						);
					}

					// Authorization check - verify API key has permission for this endpoint
					if (authResult.apiKey) {
						const authzResult = await authService.authorizeEndpoint(
							authResult.apiKey,
							url.pathname,
							req.method,
						);

						if (!authzResult.authorized) {
							return new Response(
								JSON.stringify({
									type: "error",
									error: {
										type: "authorization_error",
										message: authzResult.reason || "Access denied",
									},
								}),
								{
									status: 403,
									headers: { "Content-Type": "application/json" },
								},
							);
						}
					}

					try {
						return await handleProxy(
							req,
							url,
							proxyContext,
							authResult.apiKeyId,
							authResult.apiKeyName,
						);
					} catch (proxyError) {
						const statusCode =
							typeof proxyError === "object" &&
							proxyError !== null &&
							"statusCode" in proxyError &&
							typeof (proxyError as { statusCode: unknown }).statusCode ===
								"number"
								? (proxyError as { statusCode: number }).statusCode
								: HTTP_STATUS.INTERNAL_SERVER_ERROR;

						log.error("Proxy request failed:", proxyError);

						const isServiceUnavailable =
							statusCode === HTTP_STATUS.SERVICE_UNAVAILABLE;

						return new Response(
							JSON.stringify({
								type: "error",
								error: {
									type: isServiceUnavailable
										? "service_unavailable_error"
										: "proxy_error",
									message: isServiceUnavailable
										? "Service temporarily unavailable. Please try again later."
										: "Proxy request failed",
								},
							}),
							{
								status: statusCode,
								headers: { "Content-Type": "application/json" },
							},
						);
					}
				} catch (authError) {
					// Log authentication errors for security monitoring
					log.error("Authentication service error:", authError);
					return new Response(
						JSON.stringify({
							type: "error",
							error: {
								type: "authentication_error",
								message: "Authentication service error",
							},
						}),
						{
							status: 401,
							headers: { "Content-Type": "application/json" },
						},
					);
				}
			},
		};

		serverInstance = serve(serverConfig);
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
		const protocol = tlsEnabled ? "https" : "http";
		const displayHost = hostname === "0.0.0.0" ? "localhost" : hostname;
		const dashboardStatus =
			withDashboard && dashboardManifest
				? `${protocol}://${displayHost}:${serverInstance.port}`
				: withDashboard && !dashboardManifest
					? "unavailable (assets not found)"
					: "disabled";
		console.log(`
🎯 better-ccflare Server v${version}
🌐 Port: ${serverInstance.port}
🌍 Host: ${hostname}
${tlsEnabled ? "🔒 TLS: enabled" : ""}
📊 Dashboard: ${dashboardStatus}
🔗 API Base: ${protocol}://${displayHost}:${serverInstance.port}/api

Available endpoints:
- POST   ${protocol}://localhost:${serverInstance.port}/v1/*            → Proxy to Claude API
- GET    ${protocol}://localhost:${serverInstance.port}/api/accounts    → List accounts
- POST   ${protocol}://localhost:${serverInstance.port}/api/accounts    → Add account
- DELETE ${protocol}://localhost:${serverInstance.port}/api/accounts/:id → Remove account
- GET    ${protocol}://localhost:${serverInstance.port}/api/stats       → View statistics
- POST   ${protocol}://localhost:${serverInstance.port}/api/stats/reset → Reset statistics
- GET    ${protocol}://localhost:${serverInstance.port}/api/config      → View configuration
- PATCH  ${protocol}://localhost:${serverInstance.port}/api/config      → Update configuration

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

	// Start usage polling for NanoGPT accounts (PayG with optional subscription tracking)
	const nanogptAccounts = accounts.filter((a) => a.provider === "nanogpt");
	if (nanogptAccounts.length > 0) {
		log.info(
			`Found ${nanogptAccounts.length} NanoGPT accounts, starting usage polling...`,
		);
		for (const account of nanogptAccounts) {
			log.debug(`Processing NanoGPT account: ${account.name}`, {
				accountId: account.id,
				hasApiKey: !!account.api_key,
				paused: account.paused,
				customEndpoint: account.custom_endpoint,
			});

			if (account.api_key) {
				// NanoGPT uses API key authentication, no token refresh needed
				// Create a simple token provider that returns the API key
				const apiKeyProvider = async () => account.api_key || "";

				// Start usage polling with the API key
				usageCache.startPolling(
					account.id,
					apiKeyProvider,
					account.provider,
					90000, // Poll every 90 seconds (same as Anthropic)
					account.custom_endpoint,
				);
				log.info(`Started usage polling for NanoGPT account ${account.name}`);
			} else {
				log.warn(
					`NanoGPT account ${account.name} has no API key, skipping usage polling`,
				);
			}
		}
	} else {
		log.info(`No NanoGPT accounts found, usage polling will not start`);
	}

	// Start usage polling for Zai accounts
	const zaiAccounts = accounts.filter((a) => a.provider === "zai");
	if (zaiAccounts.length > 0) {
		log.info(
			`Found ${zaiAccounts.length} Zai accounts, starting usage polling...`,
		);
		for (const account of zaiAccounts) {
			log.debug(`Processing Zai account: ${account.name}`, {
				accountId: account.id,
				hasApiKey: !!account.api_key,
				paused: account.paused,
			});

			if (account.api_key) {
				// Zai uses API key authentication, no token refresh needed
				// Create a simple token provider that returns the API key
				const apiKeyProvider = async () => account.api_key || "";

				// Start usage polling with the API key
				usageCache.startPolling(
					account.id,
					apiKeyProvider,
					account.provider,
					90000, // Poll every 90 seconds (same as Anthropic)
				);
				log.info(`Started usage polling for Zai account ${account.name}`);
			} else {
				log.warn(
					`Zai account ${account.name} has no API key, skipping usage polling`,
				);
			}
		}
	} else {
		log.info(`No Zai accounts found, usage polling will not start`);
	}

	// Pre-warm Bedrock model and inference profile caches
	const bedrockAccounts = accounts.filter((a) => a.provider === "bedrock");
	if (bedrockAccounts.length > 0) {
		log.info(
			`Found ${bedrockAccounts.length} Bedrock accounts, pre-warming caches...`,
		);

		// Group accounts by region to avoid duplicate cache loads
		const regionMap = new Map<string, Account[]>();
		for (const account of bedrockAccounts) {
			const config = parseBedrockConfig(account.custom_endpoint);
			if (config) {
				const accounts = regionMap.get(config.region) || [];
				accounts.push(account);
				regionMap.set(config.region, accounts);
			}
		}

		// Pre-warm caches per region (don't block startup)
		for (const [region, regionAccounts] of regionMap) {
			prewarmBedrockCache(regionAccounts[0], region).catch((err) => {
				log.warn(
					`Failed to pre-warm Bedrock cache for region ${region}: ${err.message}`,
				);
			});
		}
	} else {
		log.info(`No Bedrock accounts found, cache pre-warming will not start`);
	}

	// Initialize NanoGPT pricing refresh if there are NanoGPT accounts (non-blocking)
	void initializeNanoGPTPricingIfAccountsExist(dbOps, pricingLogger);

	const serverPort = serverInstance.port;
	if (typeof serverPort !== "number") {
		throw new Error("Server instance has no valid port");
	}

	return {
		port: serverPort,
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

		// Stop token health monitoring
		stopGlobalTokenHealthChecks();

		// Clear all pending usage polling retry timeouts
		if (usagePollingRetryTimeouts.size > 0) {
			console.log(
				`Clearing ${usagePollingRetryTimeouts.size} pending usage polling retry timeout(s)...`,
			);
			for (const [
				_accountId,
				timeoutId,
			] of usagePollingRetryTimeouts.entries()) {
				clearTimeout(timeoutId);
			}
			usagePollingRetryTimeouts.clear();
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

// Export helper to get the current protocol
export function getProtocol(): string {
	return tlsEnabled ? "https" : "http";
}

// Run server if this is the main entry point
if (import.meta.main) {
	// Parse command line arguments
	const args = process.argv.slice(2);
	let port: number | undefined;
	let sslKeyPath: string | undefined;
	let sslCertPath: string | undefined;

	for (let i = 0; i < args.length; i++) {
		if (args[i] === "--port" && args[i + 1]) {
			port = Number.parseInt(args[i + 1], 10);
			i++; // Skip next arg
		} else if (args[i] === "--ssl-key" && args[i + 1]) {
			sslKeyPath = args[i + 1];
			i++; // Skip next arg
		} else if (args[i] === "--ssl-cert" && args[i + 1]) {
			sslCertPath = args[i + 1];
			i++; // Skip next arg
		}
	}

	// Use environment variables if no command line arguments
	if (!port && process.env.PORT) {
		port = Number.parseInt(process.env.PORT, 10);
	}
	if (!sslKeyPath && process.env.SSL_KEY_PATH) {
		sslKeyPath = process.env.SSL_KEY_PATH;
	}
	if (!sslCertPath && process.env.SSL_CERT_PATH) {
		sslCertPath = process.env.SSL_CERT_PATH;
	}

	// Set env vars if CLI flags were used (ensures consistency across modules)
	if (sslKeyPath) {
		process.env.SSL_KEY_PATH = sslKeyPath;
	}
	if (sslCertPath) {
		process.env.SSL_CERT_PATH = sslCertPath;
	}

	// Start the server asynchronously
	void startServer({ port, sslKeyPath, sslCertPath });
}
