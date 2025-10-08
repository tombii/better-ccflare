#!/usr/bin/env bun
import { Config } from "@better-ccflare/config";
import {
	CLAUDE_MODEL_IDS,
	getVersionSync,
	NETWORK,
	shutdown,
} from "@better-ccflare/core";
import { container, SERVICE_KEYS } from "@better-ccflare/core-di";
import { DatabaseFactory } from "@better-ccflare/database";
import { Logger } from "@better-ccflare/logger";
// Import server
import startServer from "@better-ccflare/server";
import * as tuiCore from "@better-ccflare/tui-core";
import { parseArgs } from "@better-ccflare/tui-core";
import { render } from "ink";
import React from "react";
import { App } from "./App";

// Global singleton for auto-started server
let runningServer: ReturnType<typeof startServer> | null = null;

async function ensureServer(port: number) {
	if (!runningServer) {
		runningServer = startServer({ port, withDashboard: true });
	}
	return runningServer;
}

/**
 * Helper function to exit gracefully with proper cleanup
 */
async function exitGracefully(code: 0 | 1 = 0): Promise<never> {
	try {
		await shutdown();
	} catch (error) {
		console.error("Error during shutdown:", error);
	}
	process.exit(code);
}

/**
 * Fast exit function for simple commands that don't need full cleanup
 */
function fastExit(code: 0 | 1 = 0): never {
	process.exit(code);
}

async function main() {
	const args = process.argv.slice(2);
	const parsed = parseArgs(args);

	// Handle version - check before any expensive initializations
	if (parsed.version) {
		// Use sync version to avoid async overhead
		const version = getVersionSync();
		console.log(`better-ccflare v${version}`);
		fastExit(0);
		return;
	}

	// Handle help - check before any expensive initializations
	if (parsed.help) {
		// Use sync version to avoid async overhead
		const version = getVersionSync();
		console.log(`
🎯 better-ccflare v${version} - Load Balancer for Claude

Usage: better-ccflare [options]

Options:
  --version, -v       Show version number
  --serve              Start API server with dashboard
  --port <number>      Server port (default: 8080, or PORT env var)
  --logs [N]           Stream latest N lines then follow
  --stats              Show statistics (JSON output)
  --add-account <name> Add a new account
    --mode <max|console|zai|openai-compatible>  Account mode (default: max)
      max: Claude CLI account (OAuth)
      console: Claude API account (OAuth)
      zai: z.ai account (API key)
      openai-compatible: OpenAI-compatible provider (API key)
    --tier <1|5|20>       Account tier (default: 1)
      Note: Tier is automatically set to 1 for OpenAI-compatible providers
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
  better-ccflare          Launch interactive TUI (default)

Examples:
  better-ccflare                        # Interactive mode
  better-ccflare --serve                # Start server
  better-ccflare --add-account work     # Add account
  better-ccflare --pause work           # Pause account
  better-ccflare --analyze              # Run performance analysis
  better-ccflare --stats                # View stats
`);
		fastExit(0);
		return;
	}

	// Skip update notifier to avoid forking and slow exit issues
	// updateNotifier({
	// 	pkg,
	// 	updateCheckInterval: 1000 * 60 * 60 * 24, // Check once per day
	// }).notify({ isGlobal: true });

	// Handle commands that don't need database or DI initialization
	if (parsed.getModel || parsed.setModel) {
		// Initialize only config for these simple commands
		const config = new Config();

		if (parsed.getModel) {
			const model = config.getDefaultAgentModel();
			console.log(`Current default agent model: ${model}`);
			fastExit(0);
			return;
		}

		if (parsed.setModel) {
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
				fastExit(1);
				return;
			}

			config.setDefaultAgentModel(fullModel);
			console.log(`✅ Default agent model set to: ${fullModel}`);
			fastExit(0);
			return;
		}
	}

	// Initialize DI container and services for commands that need them
	container.registerInstance(SERVICE_KEYS.Config, new Config());
	container.registerInstance(SERVICE_KEYS.Logger, new Logger("TUI"));

	// Initialize database factory
	DatabaseFactory.initialize();
	const dbOps = DatabaseFactory.getInstance();
	container.registerInstance(SERVICE_KEYS.Database, dbOps);

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
		await exitGracefully(0);
	}

	if (parsed.addAccount) {
		await tuiCore.addAccount({
			name: parsed.addAccount,
			mode: parsed.mode || "max",
			tier: parsed.tier || 1,
			priority: parsed.priority || 0,
		});
		console.log(`✅ Account "${parsed.addAccount}" added successfully`);
		await exitGracefully(0);
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
		await exitGracefully(0);
	}

	if (parsed.remove) {
		await tuiCore.removeAccount(parsed.remove);
		console.log(`✅ Account "${parsed.remove}" removed successfully`);
		await exitGracefully(0);
	}

	if (parsed.resetStats) {
		await tuiCore.resetStats();
		console.log("✅ Statistics reset successfully");
		await exitGracefully(0);
	}

	if (parsed.clearHistory) {
		await tuiCore.clearHistory();
		console.log("✅ Request history cleared successfully");
		await exitGracefully(0);
	}

	if (parsed.pause) {
		const result = await tuiCore.pauseAccount(parsed.pause);
		console.log(result.message);
		if (!result.success) {
			await exitGracefully(1);
		}
		await exitGracefully(0);
	}

	if (parsed.resume) {
		const result = await tuiCore.resumeAccount(parsed.resume);
		console.log(result.message);
		if (!result.success) {
			await exitGracefully(1);
		}
		await exitGracefully(0);
	}

	if (parsed.setPriority) {
		const [name, priorityStr] = parsed.setPriority;
		const priority = parseInt(priorityStr, 10);

		if (Number.isNaN(priority)) {
			console.error(`❌ Invalid priority value: ${priorityStr}`);
			await exitGracefully(1);
		}

		const result = await tuiCore.updateAccountPriority(name, priority);
		console.log(result.message);
		if (!result.success) {
			await exitGracefully(1);
		}
		await exitGracefully(0);
	}

	if (parsed.analyze) {
		await tuiCore.analyzePerformance();
		await exitGracefully(0);
	}

	// Default: Launch interactive TUI with auto-started server
	const config = new Config();
	const port = parsed.port || config.getRuntime().port || NETWORK.DEFAULT_PORT;
	await ensureServer(port);
	const { waitUntilExit } = render(React.createElement(App));
	await waitUntilExit();

	// Cleanup server when TUI exits - do this first to stop accepting new connections
	if (runningServer) {
		runningServer.stop();
		runningServer = null;
	}

	// Shutdown all resources
	await shutdown();
}

// Run main and handle errors
main().catch(async (error) => {
	console.error("Error:", error.message);
	await exitGracefully(1);
});

// Handle process termination
process.on("SIGINT", async () => {
	await exitGracefully(0);
});

process.on("SIGTERM", async () => {
	await exitGracefully(0);
});
