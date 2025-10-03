#!/usr/bin/env bun
import { Config } from "@better-ccflare/config";
import { CLAUDE_MODEL_IDS, NETWORK, shutdown } from "@better-ccflare/core";
import { container, SERVICE_KEYS } from "@better-ccflare/core-di";
import { DatabaseFactory } from "@better-ccflare/database";
import { Logger } from "@better-ccflare/logger";
// Import server
import startServer from "@better-ccflare/server";
import * as tuiCore from "@better-ccflare/tui-core";
import { parseArgs } from "@better-ccflare/tui-core";
import { render } from "ink";
import React from "react";
import updateNotifier from "update-notifier";
import pkg from "../package.json";
import { App } from "./App";

// Global singleton for auto-started server
let runningServer: ReturnType<typeof startServer> | null = null;

async function ensureServer(port: number) {
	if (!runningServer) {
		runningServer = startServer({ port, withDashboard: true });
	}
	return runningServer;
}

async function main() {
	// Check for updates
	updateNotifier({
		pkg,
		updateCheckInterval: 1000 * 60 * 60 * 24, // Check once per day
	}).notify({ isGlobal: true });

	// Initialize DI container and services
	container.registerInstance(SERVICE_KEYS.Config, new Config());
	container.registerInstance(SERVICE_KEYS.Logger, new Logger("TUI"));

	// Initialize database factory
	DatabaseFactory.initialize();
	const dbOps = DatabaseFactory.getInstance();
	container.registerInstance(SERVICE_KEYS.Database, dbOps);

	const args = process.argv.slice(2);
	const parsed = parseArgs(args);

	// Handle help
	if (parsed.help) {
		console.log(`
🎯 ccflare - Load Balancer for Claude

Usage: ccflare [options]

Options:
  --serve              Start API server with dashboard
  --port <number>      Server port (default: 8080, or PORT env var)
  --logs [N]           Stream latest N lines then follow
  --stats              Show statistics (JSON output)
  --add-account <name> Add a new account
    --mode <max|console|zai>  Account mode (default: max)
    --tier <1|5|20>       Account tier (default: 1)
    --priority <number>   Account priority (default: 0)
  --list               List all accounts
  --remove <name>      Remove an account
  --pause <name>       Pause an account
  --resume <name>      Resume an account
  --set-priority <name> <priority>  Set account priority
  --analyze            Analyze database performance
  --reset-stats        Reset usage statistics
  --clear-history      Clear request history
  --get-model          Show current default agent model
  --set-model <model>  Set default agent model (opus-4 or sonnet-4)
  --help, -h           Show this help message

Interactive Mode:
  ccflare          Launch interactive TUI (default)

Examples:
  ccflare                        # Interactive mode
  ccflare --serve                # Start server
  ccflare --add-account work     # Add account
  ccflare --pause work           # Pause account
  ccflare --analyze              # Run performance analysis
  ccflare --stats                # View stats
`);
		process.exit(0);
	}

	// Handle non-interactive commands
	if (parsed.serve) {
		const config = new Config();
		const port =
			parsed.port || config.getRuntime().port || NETWORK.DEFAULT_PORT;
		startServer({ port, withDashboard: true });
		// Keep process alive
		await new Promise(() => {});
		return;
	}

	if (parsed.logs !== undefined) {
		const limit = typeof parsed.logs === "number" ? parsed.logs : 100;

		// First print historical logs if limit was specified
		if (typeof parsed.logs === "number") {
			const history = await tuiCore.getLogHistory(limit);
			for (const log of history) {
				console.log(`[${log.level}] ${log.msg}`);
			}
			console.log("--- Live logs ---");
		}

		// Then stream live logs
		await tuiCore.streamLogs((log) => {
			console.log(`[${log.level}] ${log.msg}`);
		});
		return;
	}

	if (parsed.stats) {
		const stats = await tuiCore.getStats();
		console.log(JSON.stringify(stats, null, 2));
		return;
	}

	if (parsed.addAccount) {
		await tuiCore.addAccount({
			name: parsed.addAccount,
			mode: parsed.mode || "max",
			tier: parsed.tier || 1,
			priority: parsed.priority || 0,
		});
		console.log(`✅ Account "${parsed.addAccount}" added successfully`);
		return;
	}

	if (parsed.list) {
		const accounts = await tuiCore.getAccounts();
		if (accounts.length === 0) {
			console.log("No accounts configured");
		} else {
			console.log("\nAccounts:");
			accounts.forEach((acc) => {
				console.log(
					`  - ${acc.name} (${acc.mode} mode, tier ${acc.tier}, priority ${acc.priority})`,
				);
			});
		}
		return;
	}

	if (parsed.remove) {
		await tuiCore.removeAccount(parsed.remove);
		console.log(`✅ Account "${parsed.remove}" removed successfully`);
		return;
	}

	if (parsed.resetStats) {
		await tuiCore.resetStats();
		console.log("✅ Statistics reset successfully");
		return;
	}

	if (parsed.clearHistory) {
		await tuiCore.clearHistory();
		console.log("✅ Request history cleared successfully");
		return;
	}

	if (parsed.pause) {
		const result = await tuiCore.pauseAccount(parsed.pause);
		console.log(result.message);
		if (!result.success) {
			process.exit(1);
		}
		return;
	}

	if (parsed.resume) {
		const result = await tuiCore.resumeAccount(parsed.resume);
		console.log(result.message);
		if (!result.success) {
			process.exit(1);
		}
		return;
	}

	if (parsed.setPriority) {
		const [name, priorityStr] = parsed.setPriority;
		const priority = parseInt(priorityStr, 10);

		if (Number.isNaN(priority)) {
			console.error(`❌ Invalid priority value: ${priorityStr}`);
			process.exit(1);
		}

		const result = await tuiCore.updateAccountPriority(name, priority);
		console.log(result.message);
		if (!result.success) {
			process.exit(1);
		}
		return;
	}

	if (parsed.analyze) {
		await tuiCore.analyzePerformance();
		return;
	}

	if (parsed.getModel) {
		const config = new Config();
		const model = config.getDefaultAgentModel();
		console.log(`Current default agent model: ${model}`);
		return;
	}

	if (parsed.setModel) {
		const config = new Config();
		// Validate the model
		const modelMap: Record<string, string> = {
			"opus-4": CLAUDE_MODEL_IDS.OPUS_4,
			"sonnet-4": CLAUDE_MODEL_IDS.SONNET_4,
			"opus-4.1": CLAUDE_MODEL_IDS.OPUS_4_1,
			"sonnet-4.5": CLAUDE_MODEL_IDS.SONNET_4_5,
		};

		const fullModel = modelMap[parsed.setModel];
		if (!fullModel) {
			console.error(`❌ Invalid model: ${parsed.setModel}`);
			console.error("Valid models: opus-4, sonnet-4");
			process.exit(1);
		}

		config.setDefaultAgentModel(fullModel);
		console.log(`✅ Default agent model set to: ${fullModel}`);
		return;
	}

	// Default: Launch interactive TUI with auto-started server
	const config = new Config();
	const port = parsed.port || config.getRuntime().port || NETWORK.DEFAULT_PORT;
	await ensureServer(port);
	const { waitUntilExit } = render(React.createElement(App));
	await waitUntilExit();

	// Cleanup server when TUI exits
	if (runningServer) {
		runningServer.stop();
	}

	// Shutdown all resources
	await shutdown();
}

// Run main and handle errors
main().catch(async (error) => {
	console.error("Error:", error.message);
	try {
		await shutdown();
	} catch (shutdownError) {
		console.error("Error during shutdown:", shutdownError);
	}
	process.exit(1);
});

// Handle process termination
process.on("SIGINT", async () => {
	try {
		await shutdown();
	} catch (error) {
		console.error("Error during shutdown:", error);
	}
	process.exit(0);
});

process.on("SIGTERM", async () => {
	try {
		await shutdown();
	} catch (error) {
		console.error("Error during shutdown:", error);
	}
	process.exit(0);
});
