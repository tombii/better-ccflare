import { parseArgs } from "node:util";
import { Config } from "@claudeflare/config";
import { DatabaseOperations } from "@claudeflare/database";
import {
	addAccount,
	getAccountsList,
	pauseAccount,
	removeAccountWithConfirmation,
	resumeAccount,
} from "./commands/account";
import { getHelpText } from "./commands/help";
import { clearRequestHistory, resetAllStats } from "./commands/stats";

/**
 * Main CLI runner
 */
export async function runCli(argv: string[]): Promise<void> {
	// Initialize database and config
	const dbOps = new DatabaseOperations();
	const config = new Config();

	try {
		// Parse command line arguments
		const { positionals, values } = parseArgs({
			args: argv.slice(2),
			strict: false,
			options: {
				mode: { type: "string" },
				tier: { type: "string" },
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
						"Usage: claudeflare-cli add <name> [--mode <max|console>] [--tier <1|5|20>]",
					);
					process.exit(1);
				}

				// Parse options
				const mode = values.mode as "max" | "console" | undefined;
				const tierValue = values.tier
					? parseInt(values.tier as string)
					: undefined;
				const tier =
					tierValue === 1 || tierValue === 5 || tierValue === 20
						? tierValue
						: undefined;

				await addAccount(dbOps, config, { name, mode, tier });
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
							"Tier".padEnd(6) +
							"Requests".padEnd(12) +
							"Token".padEnd(10) +
							"Status".padEnd(20) +
							"Session",
					);
					console.log("─".repeat(100));

					// Rows
					for (const account of accounts) {
						console.log(
							account.name.padEnd(20) +
								account.provider.padEnd(10) +
								account.tierDisplay.padEnd(6) +
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
					console.log("Usage: claudeflare-cli remove <name> [--force]");
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
					console.log("Usage: claudeflare-cli pause <name>");
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
					console.log("Usage: claudeflare-cli resume <name>");
					process.exit(1);
				}

				const result = resumeAccount(dbOps, name);
				console.log(result.message);
				if (!result.success) {
					process.exit(1);
				}
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
		// Always close the database
		dbOps.close();
	}
}
