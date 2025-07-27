import { serve } from "bun";
import { DatabaseOperations } from "@claudeflare/database";
import { Config } from "@claudeflare/config";
import { Logger } from "@claudeflare/logger";
import { getDashboardHTML } from "@claudeflare/dashboard";
import {
	RoundRobinStrategy,
	LeastRequestsStrategy,
	SessionStrategy,
	WeightedStrategy,
	WeightedRoundRobinStrategy,
} from "@claudeflare/load-balancer";
import type { LoadBalancingStrategy } from "@claudeflare/core";
import { DEFAULT_STRATEGY } from "@claudeflare/core";
import {
	handleProxy,
	type ProxyContext,
	AnthropicProvider,
} from "@claudeflare/proxy";
import { ApiRoutes } from "./api-routes";

// Initialize components
const dbOps = new DatabaseOperations();
const db = dbOps.getDatabase();
const config = new Config();
const runtime = config.getRuntime();
dbOps.setRuntimeConfig(runtime);
const apiRoutes = new ApiRoutes(db, config, dbOps);
const log = new Logger("Server");

// Load balancing strategy initialization
let strategy: LoadBalancingStrategy;

// Refresh token stampede prevention
const refreshInFlight = new Map<string, Promise<string>>();

// Initialize provider (for now just Anthropic)
const provider = new AnthropicProvider();

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
console.log(
	`⚙️  Current strategy: ${config.getStrategy()} (default: ${DEFAULT_STRATEGY})`,
);

// Graceful shutdown
process.on("SIGINT", () => {
	console.log("\n👋 Shutting down gracefully...");
	dbOps.close();
	process.exit(0);
});
