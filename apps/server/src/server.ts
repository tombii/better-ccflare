import { dirname } from "node:path";
import { Config } from "@claudeflare/config";
import type { LoadBalancingStrategy } from "@claudeflare/core";
import {
	CACHE,
	DEFAULT_STRATEGY,
	HTTP_STATUS,
	NETWORK,
	registerDisposable,
	setPricingLogger,
	shutdown,
} from "@claudeflare/core";
import { container, SERVICE_KEYS } from "@claudeflare/core-di";
// Import React dashboard assets
import dashboardManifest from "@claudeflare/dashboard-web/dist/manifest.json";
import { AsyncDbWriter, DatabaseFactory } from "@claudeflare/database";
import { APIRouter } from "@claudeflare/http-api";
import { SessionStrategy } from "@claudeflare/load-balancer";
import { Logger } from "@claudeflare/logger";
import { getProvider } from "@claudeflare/providers";
import {
	getUsageWorker,
	handleProxy,
	type ProxyContext,
	terminateUsageWorker,
} from "@claudeflare/proxy";
import { serve } from "bun";

// Helper function to resolve dashboard assets with fallback
function resolveDashboardAsset(assetPath: string): string | null {
	try {
		// Try resolving as a package first
		return Bun.resolveSync(
			`@claudeflare/dashboard-web/dist${assetPath}`,
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
	const resolvedPath = resolveDashboardAsset(assetPath);
	if (!resolvedPath) {
		return new Response("Not Found", { status: HTTP_STATUS.NOT_FOUND });
	}

	const file = Bun.file(resolvedPath);
	if (!file.exists()) {
		return new Response("Not Found", { status: HTTP_STATUS.NOT_FOUND });
	}

	const headers: Record<string, string> = {
		"Content-Type": contentType || file.type || "application/octet-stream",
	};

	if (cacheControl) {
		headers["Cache-Control"] = cacheControl;
	}

	return new Response(file, { headers });
}

// Initialize DI container
container.registerInstance(SERVICE_KEYS.Config, new Config());
container.registerInstance(SERVICE_KEYS.Logger, new Logger("Server"));

// Initialize components
const config = container.resolve<Config>(SERVICE_KEYS.Config);
const runtime = config.getRuntime();
DatabaseFactory.initialize(undefined, runtime);
const dbOps = DatabaseFactory.getInstance();
const db = dbOps.getDatabase();
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
const log = container.resolve<Logger>(SERVICE_KEYS.Logger);

log.info("Starting Claudeflare server...");
log.info(`Port: ${runtime.port}`);
log.info(`Session duration: ${runtime.sessionDurationMs}ms`);

// Load balancing strategy initialization
let strategy: LoadBalancingStrategy;

// Refresh token stampede prevention
const refreshInFlight = new Map<string, Promise<string>>();

// Get provider from registry (for now just Anthropic)
const provider = getProvider("anthropic");
if (!provider) {
	throw new Error("Anthropic provider not found in registry");
}

function initStrategy(): LoadBalancingStrategy {
	const strategyName = config.getStrategy();
	log.info(`Initializing load balancing strategy: ${strategyName}`);

	// Only session-based strategy is supported
	const sessionStrategy = new SessionStrategy(runtime.sessionDurationMs);
	sessionStrategy.initialize(dbOps);
	return sessionStrategy;
}

strategy = initStrategy();

// Create proxy context (without worker initially)
const proxyContext: ProxyContext = {
	strategy,
	dbOps,
	runtime,
	provider,
	refreshInFlight,
	asyncWriter,
	usageWorker: null as unknown as Worker, // Will be set below
};

// Initialize usage worker
proxyContext.usageWorker = getUsageWorker();

// Watch for strategy changes
config.on("change", ({ key }) => {
	if (key === "lb_strategy") {
		log.info(`Strategy changed to ${config.getStrategy()}`);
		strategy = initStrategy();
		// Update proxy context strategy
		proxyContext.strategy = strategy;
	}
});

// Main server
const server = serve({
	port: runtime.port,
	idleTimeout: NETWORK.IDLE_TIMEOUT_MAX, // Max allowed by Bun
	async fetch(req) {
		const url = new URL(req.url);

		// Try API routes first
		const apiResponse = await apiRouter.handleRequest(url, req);
		if (apiResponse) {
			return apiResponse;
		}

		// Dashboard routes
		if (url.pathname === "/" || url.pathname === "/dashboard") {
			return serveDashboardFile("/index.html", "text/html");
		}

		// Serve dashboard static assets
		if ((dashboardManifest as Record<string, string>)[url.pathname]) {
			return serveDashboardFile(
				url.pathname,
				undefined,
				CACHE.CACHE_CONTROL_STATIC,
			);
		}

		// Only proxy requests to Anthropic API
		if (!url.pathname.startsWith("/v1/")) {
			return new Response("Not Found", { status: HTTP_STATUS.NOT_FOUND });
		}

		// Handle proxy request
		return handleProxy(req, url, proxyContext);
	},
});

console.log(`🚀 Claudeflare server running on http://localhost:${server.port}`);
console.log(`📊 Dashboard: http://localhost:${server.port}/dashboard`);
console.log(`🔍 Health check: http://localhost:${server.port}/health`);
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

// Graceful shutdown handler
async function handleGracefulShutdown(signal: string) {
	console.log(`\n👋 Received ${signal}, shutting down gracefully...`);
	try {
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

// Export for programmatic use
export default function startServer(_options?: {
	port?: number;
	withDashboard?: boolean;
}) {
	// This is a placeholder for when the server needs to be started programmatically
	return {
		port: server.port,
		stop: () => {
			// Server stop logic
			server.stop();
		},
	};
}
