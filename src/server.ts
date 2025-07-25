import { serve } from "bun";
import { DatabaseOperations } from "./database";
import { Config } from "./config";
import { ApiRoutes } from "./api-routes";
import { getDashboardHTML } from "./dashboard";
import { Logger } from "./logger";
import {
	RoundRobinStrategy,
	LeastRequestsStrategy,
	SessionStrategy,
	WeightedStrategy,
	WeightedRoundRobinStrategy,
} from "./strategies/index";
import type { LoadBalancingStrategy } from "./strategy";
import { handleProxy, type ProxyContext } from "./proxy";

// Initialize components
const dbOps = new DatabaseOperations();
const db = dbOps.getDatabase();
const config = new Config(db);
const runtime = config.getRuntime();
dbOps.setRuntimeConfig(runtime);
const apiRoutes = new ApiRoutes(db, config, dbOps);
const log = new Logger("Server");

// Load balancing strategy initialization
let strategy: LoadBalancingStrategy;

// Refresh token stampede prevention
const refreshInFlight = new Map<string, Promise<string>>();

function initStrategy(): LoadBalancingStrategy {
	const strategyName = config.getStrategy();
	log.info(`Initializing load balancing strategy: ${strategyName}`);

	switch (strategyName) {
		case "round-robin":
			return new RoundRobinStrategy();
		case "weighted-round-robin":
			return new WeightedRoundRobinStrategy();
		case "session": {
			const sessionStrategy = new SessionStrategy(runtime.sessionDurationMs);
			sessionStrategy.setDatabase(db);
			return sessionStrategy;
		}
		case "weighted":
			return new WeightedStrategy();
		default:
			return new LeastRequestsStrategy();
	}
}

strategy = initStrategy();

// Watch for strategy changes
let lastStrategy = config.getStrategy();
setInterval(() => {
	const currentStrategy = config.getStrategy();
	if (currentStrategy !== lastStrategy) {
		log.info(`Strategy changed from ${lastStrategy} to ${currentStrategy}`);
		strategy = initStrategy();
		lastStrategy = currentStrategy;
		// Update proxy context strategy
		proxyContext.strategy = strategy;
	}
}, 1000); // Check every second

// Create proxy context
const proxyContext: ProxyContext = {
	strategy,
	dbOps,
	runtime,
	refreshInFlight,
};

// Main server
const server = serve({
	port: runtime.port,
	async fetch(req) {
		const url = new URL(req.url);

		// Try API routes first
		const apiResponse = await apiRoutes.handleRequest(url, req);
		if (apiResponse) {
			return apiResponse;
		}

		// Dashboard
		if (url.pathname === "/" || url.pathname === "/dashboard") {
			return new Response(getDashboardHTML(), {
				headers: { "Content-Type": "text/html" },
			});
		}

		// Only proxy requests to Anthropic API
		if (!url.pathname.startsWith("/v1/")) {
			return new Response("Not Found", { status: 404 });
		}

		// Handle proxy request
		return handleProxy(req, url, proxyContext);
	},
});

console.log(
	`🚀 Claude proxy server running on http://localhost:${server.port}`,
);
console.log(`📊 Dashboard: http://localhost:${server.port}/dashboard`);
console.log(`🔍 Health check: http://localhost:${server.port}/health`);
console.log(`⚙️  Current strategy: ${config.getStrategy()}`);

// Graceful shutdown
process.on("SIGINT", () => {
	console.log("\n👋 Shutting down gracefully...");
	dbOps.close();
	process.exit(0);
});
