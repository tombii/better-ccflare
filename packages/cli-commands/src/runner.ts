import { parseArgs } from "node:util";
import { Config } from "@better-ccflare/config";
import { shutdown } from "@better-ccflare/core";
import { container, SERVICE_KEYS } from "@better-ccflare/core-di";
import { DatabaseFactory } from "@better-ccflare/database";
import {
	addAccount,
	getAccountsList,
	pauseAccount,
	removeAccountWithConfirmation,
	resumeAccount,
	setAccountPriority,
} from "./commands/account";
import { analyzePerformance } from "./commands/analyze";
import { getHelpText } from "./commands/help";
import { clearRequestHistory, resetAllStats } from "./commands/stats";

/**
 * Main CLI runner
 */
export async function runCli(argv: string[]): Promise<void> {
	// Initialize DI container and services
	container.registerInstance(SERVICE_KEYS.Config, new Config());
	const config = container.resolve<Config>(SERVICE_KEYS.Config);
	DatabaseFactory.initialize();
	const dbOps = DatabaseFactory.getInstance();
	container.registerInstance(SERVICE_KEYS.Database, dbOps);

	try {
		// Parse command line arguments
		const { positionals, values } = parseArgs({
			args: argv.slice(2),
			strict: false,
			options: {
				mode: { type: "string" },
				priority: { type: "string" },
				modelMappings: { type: "string" },
				force: { type: "boolean" },
			},
		});

		const command = positionals[0];

		switch (command) {
			case "add": {
				const name = positionals[1];
				if (!name) {
					console.error("Error: Account name is required");
					console.log(
						"Usage: ccflare-cli add <name> [--mode <claude-oauth|console|zai|openai-compatible>] [--priority <number>] [--modelMappings <JSON>]",
					);
					process.exit(1);
				}

				// Parse options
				const mode = values.mode as "claude-oauth" | "console" | undefined;
				const priorityValue = values.priority
					? parseInt(values.priority as string)
					: undefined;
				const priority =
					typeof priorityValue === "number" && !Number.isNaN(priorityValue)
						? priorityValue
						: undefined;
				const modelMappingsValue = values.modelMappings as string | undefined;
				let modelMappings: Record<string, string> | undefined;
				if (modelMappingsValue) {
					try {
						modelMappings = JSON.parse(modelMappingsValue);
					} catch (error) {
						console.error(
							`Error parsing model mappings: ${error instanceof Error ? error.message : String(error)}`,
						);
						process.exit(1);
					}
				}

				await addAccount(dbOps, config, {
					name,
					mode,
					priority,
					modelMappings,
				});
				break;
			}

			case "list": {
				const accounts = getAccountsList(dbOps);

				if (accounts.length === 0) {
					console.log("No accounts found");
				} else {
					console.log(`\nAccounts (${accounts.length}):`);
					console.log("─".repeat(100));

					// Header
					console.log(
						"Name".padEnd(20) +
							"Type".padEnd(10) +
							"Priority".padEnd(9) +
							"Requests".padEnd(12) +
							"Token".padEnd(10) +
							"Status".padEnd(20) +
							"Session",
					);
					console.log("─".repeat(94));

					// Rows
					for (const account of accounts) {
						console.log(
							account.name.padEnd(20) +
								account.provider.padEnd(10) +
								account.priority.toString().padEnd(9) +
								`${account.requestCount}/${account.totalRequests}`.padEnd(12) +
								account.tokenStatus.padEnd(10) +
								account.rateLimitStatus.padEnd(20) +
								account.sessionInfo,
						);
					}
				}
				break;
			}

			case "remove": {
				const name = positionals[1];
				if (!name) {
					console.error("Error: Account name is required");
					console.log("Usage: ccflare-cli remove <name> [--force]");
					process.exit(1);
				}

				const result = await removeAccountWithConfirmation(
					dbOps,
					name,
					values.force === true,
				);
				console.log(result.message);
				if (!result.success) {
					process.exit(1);
				}
				break;
			}

			case "reset-stats": {
				const db = dbOps.getDatabase();
				resetAllStats(db);
				console.log("Account statistics reset successfully");
				break;
			}

			case "clear-history": {
				const db = dbOps.getDatabase();
				const result = clearRequestHistory(db);
				console.log(`Cleared ${result.count} request records`);
				break;
			}

			case "pause": {
				const name = positionals[1];
				if (!name) {
					console.error("Error: Account name is required");
					console.log("Usage: ccflare-cli pause <name>");
					process.exit(1);
				}

				const result = pauseAccount(dbOps, name);
				console.log(result.message);
				if (!result.success) {
					process.exit(1);
				}
				break;
			}

			case "resume": {
				const name = positionals[1];
				if (!name) {
					console.error("Error: Account name is required");
					console.log("Usage: ccflare-cli resume <name>");
					process.exit(1);
				}

				const result = resumeAccount(dbOps, name);
				console.log(result.message);
				if (!result.success) {
					process.exit(1);
				}
				break;
			}

			case "set-priority": {
				const name = positionals[1];
				const priorityValue = positionals[2];

				if (!name) {
					console.error("Error: Account name is required");
					console.log("Usage: ccflare-cli set-priority <name> <priority>");
					process.exit(1);
				}

				if (priorityValue === undefined) {
					console.error("Error: Priority value is required");
					console.log("Usage: ccflare-cli set-priority <name> <priority>");
					process.exit(1);
				}

				const priority = parseInt(priorityValue);
				if (Number.isNaN(priority)) {
					console.error("Error: Priority must be a number");
					process.exit(1);
				}

				const result = setAccountPriority(dbOps, name, priority);
				console.log(result.message);
				if (!result.success) {
					process.exit(1);
				}
				break;
			}

			case "analyze": {
				const db = dbOps.getDatabase();
				analyzePerformance(db);
				break;
			}

			default: {
				console.log(getHelpText());
				if (command && command !== "help") {
					console.error(`\nError: Unknown command '${command}'`);
					process.exit(1);
				}
				break;
			}
		}
	} catch (error) {
		console.error(`Error: ${error instanceof Error ? error.message : error}`);
		process.exit(1);
	} finally {
		// Always shutdown resources
		await shutdown();
	}
}
