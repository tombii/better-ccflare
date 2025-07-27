import { Config } from "@claudeflare/config";
import type { LoadBalancingStrategy } from "@claudeflare/core";
import { DEFAULT_STRATEGY, StrategyName } from "@claudeflare/core";
// Import React dashboard assets
import dashboardManifest from "@claudeflare/dashboard-web/dist/manifest.json";
import { DatabaseOperations } from "@claudeflare/database";
import { APIRouter } from "@claudeflare/http-api";
import {
	LeastRequestsStrategy,
	RoundRobinStrategy,
	SessionStrategy,
	WeightedRoundRobinStrategy,
	WeightedStrategy,
} from "@claudeflare/load-balancer";
import { Logger } from "@claudeflare/logger";
import { getProvider } from "@claudeflare/providers";
import { handleProxy, type ProxyContext } from "@claudeflare/proxy";
import { serve } from "bun";

// Initialize components
const dbOps = new DatabaseOperations();
const db = dbOps.getDatabase();
const config = new Config();
const runtime = config.getRuntime();
dbOps.setRuntimeConfig(runtime);
const apiRouter = new APIRouter({ db, config, dbOps });
const log = new Logger("Server");

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

	switch (strategyName) {
		case StrategyName.RoundRobin:
			return new RoundRobinStrategy();
		case StrategyName.WeightedRoundRobin:
			return new WeightedRoundRobinStrategy();
		case StrategyName.Session: {
			const sessionStrategy = new SessionStrategy(runtime.sessionDurationMs);
			sessionStrategy.initialize(dbOps);
			return sessionStrategy;
		}
		case StrategyName.Weighted:
			return new WeightedStrategy();
		default:
			return new LeastRequestsStrategy();
	}
}

strategy = initStrategy();

// Create proxy context
const proxyContext: ProxyContext = {
	strategy,
	dbOps,
	runtime,
	provider,
	refreshInFlight,
};

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
	async fetch(req) {
		const url = new URL(req.url);

		// Try API routes first
		const apiResponse = await apiRouter.handleRequest(url, req);
		if (apiResponse) {
			return apiResponse;
		}

		// Dashboard routes
		if (url.pathname === "/" || url.pathname === "/dashboard") {
			// Read the HTML file directly
			const dashboardPath = import.meta.resolveSync(
				"@claudeflare/dashboard-web/dist/index.html",
			);
			const file = Bun.file(dashboardPath);
			return new Response(file, {
				headers: { "Content-Type": "text/html" },
			});
		}

		// Serve dashboard static assets
		if ((dashboardManifest as Record<string, string>)[url.pathname]) {
			try {
				const assetPath = import.meta.resolveSync(
					`@claudeflare/dashboard-web/dist${url.pathname}`,
				);
				const file = Bun.file(assetPath);
				const mimeType = file.type || "application/octet-stream";
				return new Response(file, {
					headers: {
						"Content-Type": mimeType,
						"Cache-Control": "public, max-age=31536000",
					},
				});
			} catch {
				// Asset not found
			}
		}

		// Only proxy requests to Anthropic API
		if (!url.pathname.startsWith("/v1/")) {
			return new Response("Not Found", { status: 404 });
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

// Graceful shutdown
process.on("SIGINT", () => {
	console.log("\n👋 Shutting down gracefully...");
	dbOps.close();
	process.exit(0);
});

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
