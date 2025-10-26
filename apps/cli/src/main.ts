#!/usr/bin/env bun
import {
	addAccount,
	analyzePerformance,
	clearRequestHistory,
	getAccountsList,
	pauseAccount,
	removeAccount,
	resetAllStats,
	resumeAccount,
	setAccountPriority,
} from "@better-ccflare/cli-commands";
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

/**
 * Parse command line arguments
 */
function parseArgs(args: string[]) {
	const parsed: Record<string, any> = {
		version: false,
		help: false,
		serve: false,
		port: null,
		sslKey: null,
		sslCert: null,
		logs: undefined,
		stats: false,
		addAccount: null,
		mode: null,
		tier: null,
		priority: null,
		list: false,
		remove: null,
		pause: null,
		resume: null,
		setPriority: null,
		analyze: false,
		resetStats: false,
		clearHistory: false,
		getModel: false,
		setModel: null,
	};

	for (let i = 0; i < args.length; i++) {
		const arg = args[i];

		switch (arg) {
			case "--version":
			case "-v":
				parsed.version = true;
				break;
			case "--help":
			case "-h":
				parsed.help = true;
				break;
			case "--serve":
				parsed.serve = true;
				break;
			case "--port":
				parsed.port = parseInt(args[++i], 10);
				break;
			case "--ssl-key":
				parsed.sslKey = args[++i];
				break;
			case "--ssl-cert":
				parsed.sslCert = args[++i];
				break;
			case "--logs":
				parsed.logs =
					args[i + 1] && !args[i + 1].startsWith("--")
						? parseInt(args[++i], 10)
						: 100;
				break;
			case "--stats":
				parsed.stats = true;
				break;
			case "--add-account":
				parsed.addAccount = args[++i];
				break;
			case "--mode":
				parsed.mode = args[++i];
				break;
			case "--tier":
				parsed.tier = parseInt(args[++i], 10);
				break;
			case "--priority":
				parsed.priority = parseInt(args[++i], 10);
				break;
			case "--list":
				parsed.list = true;
				break;
			case "--remove":
				parsed.remove = args[++i];
				break;
			case "--pause":
				parsed.pause = args[++i];
				break;
			case "--resume":
				parsed.resume = args[++i];
				break;
			case "--set-priority": {
				const name = args[++i];
				const priority = args[++i];
				parsed.setPriority = [name, priority];
				break;
			}
			case "--analyze":
				parsed.analyze = true;
				break;
			case "--reset-stats":
				parsed.resetStats = true;
				break;
			case "--clear-history":
				parsed.clearHistory = true;
				break;
			case "--get-model":
				parsed.getModel = true;
				break;
			case "--set-model":
				parsed.setModel = args[++i];
				break;
		}
	}

	return parsed;
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
  --ssl-key <path>     Path to SSL private key file (enables HTTPS)
  --ssl-cert <path>    Path to SSL certificate file (enables HTTPS)
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

Examples:
  better-ccflare --serve                # Start server
  better-ccflare --serve --ssl-key /path/to/key.pem --ssl-cert /path/to/cert.pem  # Start server with HTTPS
  better-ccflare --add-account work     # Add account
  better-ccflare --pause work           # Pause account
  better-ccflare --analyze              # Run performance analysis
  better-ccflare --stats                # View stats
`);
		fastExit(0);
		return;
	}

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
				console.error("Valid models: opus-4, sonnet-4, opus-4.1, sonnet-4.5");
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
	container.registerInstance(SERVICE_KEYS.Logger, new Logger("CLI"));

	// Initialize database factory
	DatabaseFactory.initialize();
	const dbOps = DatabaseFactory.getInstance();
	container.registerInstance(SERVICE_KEYS.Database, dbOps);

	// Handle non-interactive commands
	if (parsed.serve) {
		const config = new Config();
		const port =
			parsed.port || config.getRuntime().port || NETWORK.DEFAULT_PORT;
		startServer({
			port,
			withDashboard: true,
			sslKeyPath: parsed.sslKey,
			sslCertPath: parsed.sslCert,
		});
		// Keep process alive
		await new Promise(() => {});
		return;
	}

	if (parsed.logs !== undefined) {
		console.error("❌ --logs command is not yet implemented in CLI mode");
		console.error("Use the web dashboard to view logs instead.");
		await exitGracefully(1);
		return;
	}

	if (parsed.stats) {
		const accounts = getAccountsList(dbOps);
		const stats = {
			totalAccounts: accounts.length,
			activeAccounts: accounts.filter(
				(acc) => !acc.paused && acc.tokenStatus === "valid",
			).length,
			pausedAccounts: accounts.filter((acc) => acc.paused).length,
			expiredAccounts: accounts.filter((acc) => acc.tokenStatus === "expired")
				.length,
			totalRequests: accounts.reduce((sum, acc) => sum + acc.requestCount, 0),
			accounts: accounts.map((acc) => ({
				name: acc.name,
				provider: acc.provider,
				mode: acc.mode,
				tier: acc.tier,
				priority: acc.priority,
				requestCount: acc.requestCount,
				paused: acc.paused,
				tokenStatus: acc.tokenStatus,
				rateLimitStatus: acc.rateLimitStatus,
			})),
		};
		console.log(JSON.stringify(stats, null, 2));
		await exitGracefully(0);
	}

	if (parsed.addAccount) {
		// Check if we're in interactive mode or using CLI flags
		if (parsed.mode || parsed.tier || parsed.priority) {
			// CLI mode - use flags provided
			try {
				const mode = parsed.mode || "max";
				const tier = parsed.tier || 1;
				const priority = parsed.priority || 0;

				// For API key accounts, we need to get the API key from environment or user
				let apiKey = "";
				if (mode === "zai" || mode === "openai-compatible") {
					apiKey = process.env[`BETTER_CCFLARE_API_KEY_${parsed.addAccount.toUpperCase()}`] ||
							   process.env[`API_KEY_${parsed.addAccount.toUpperCase()}`] ||
							   "";

					if (!apiKey) {
						console.error(`❌ API key required for ${mode} accounts`);
						console.error(`Set environment variable: BETTER_CCFLARE_API_KEY_${parsed.addAccount.toUpperCase()}`);
						console.error(`Or: API_KEY_${parsed.addAccount.toUpperCase()}`);
						await exitGracefully(1);
					}
				}

				await addAccount(dbOps, new Config(), {
					name: parsed.addAccount,
					mode,
					tier,
					priority,
					adapter: {
						select: async <T extends string | number>(
							_prompt: string,
							_options: Array<{ label: string; value: T }>,
						) => (_options[0]?.value as T) || ("yes" as T), // Auto-select first option
						input: async (_prompt: string) => apiKey, // Use the provided API key
						confirm: async (_prompt: string) => true,
					},
				});
				console.log(`✅ Account "${parsed.addAccount}" added successfully`);
			} catch (error: unknown) {
				const errorMessage =
					error instanceof Error ? error.message : String(error);
				console.error(`❌ Failed to add account: ${errorMessage}`);
				await exitGracefully(1);
			}
		} else {
			console.error(
				"❌ Interactive account setup is not available in CLI mode",
			);
			console.error("Please provide the required flags:");
			console.error("  --mode <max|console|zai|openai-compatible>");
			console.error("  --tier <1|5|20>");
			console.error("  --priority <number>");
			console.error("\nFor API key accounts, also set:");
			console.error("  export BETTER_CCFLARE_API_KEY_<ACCOUNT_NAME>");
			console.error("\nExample:");
			console.error(
				"  better-ccflare --add-account work --mode max --tier 1 --priority 0",
			);
			console.error(
				"  export BETTER_CCFLARE_API_KEY_WORK=your-api-key-here",
			);
			await exitGracefully(1);
		}
		await exitGracefully(0);
	}

	if (parsed.list) {
		const accounts = getAccountsList(dbOps);
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
		const result = removeAccount(dbOps, parsed.remove);
		console.log(result.message);
		if (!result.success) {
			await exitGracefully(1);
		}
		await exitGracefully(0);
	}

	if (parsed.resetStats) {
		resetAllStats(dbOps.getDatabase());
		console.log("✅ Statistics reset successfully");
		await exitGracefully(0);
	}

	if (parsed.clearHistory) {
		const result = clearRequestHistory(dbOps.getDatabase());
		console.log(
			`✅ Request history cleared successfully (${result.count} records removed)`,
		);
		await exitGracefully(0);
	}

	if (parsed.pause) {
		const result = pauseAccount(dbOps, parsed.pause);
		console.log(result.message);
		if (!result.success) {
			await exitGracefully(1);
		}
		await exitGracefully(0);
	}

	if (parsed.resume) {
		const result = resumeAccount(dbOps, parsed.resume);
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

		const result = setAccountPriority(dbOps, name, priority);
		console.log(result.message);
		if (!result.success) {
			await exitGracefully(1);
		}
		await exitGracefully(0);
	}

	if (parsed.analyze) {
		analyzePerformance(dbOps.getDatabase());
		await exitGracefully(0);
	}

	// Default: Start server if no command specified
	console.log("Starting better-ccflare server...");
	const config = new Config();
	const port = parsed.port || config.getRuntime().port || NETWORK.DEFAULT_PORT;
	console.log(`Server will be available at http://localhost:${port}`);
	console.log(
		`Dashboard will be available at http://localhost:${port}/dashboard`,
	);

	startServer({
		port,
		withDashboard: true,
		sslKeyPath: parsed.sslKey,
		sslCertPath: parsed.sslCert,
	});

	// Keep process alive
	await new Promise(() => {});
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
