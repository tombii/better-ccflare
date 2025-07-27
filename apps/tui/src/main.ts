#!/usr/bin/env bun
import React from "react";
import { render } from "ink";
import { parseArgs } from "@claudeflare/tui-core";
import * as tuiCore from "@claudeflare/tui-core";
import { App } from "./App";

async function main() {
	const args = process.argv.slice(2);
	const parsed = parseArgs(args);

	// Handle help
	if (parsed.help) {
		console.log(`
🎯 Claudeflare - Load Balancer for Claude

Usage: claudeflare [options]

Options:
  --serve              Start API server with dashboard
  --logs [N]           Stream latest N lines then follow
  --stats              Show statistics (JSON output)
  --add-account <name> Add a new account
    --mode <max|console>  Account mode (default: max)
    --tier <1|5|20>       Account tier (default: 1)
  --list               List all accounts
  --remove <name>      Remove an account
  --reset-stats        Reset usage statistics
  --clear-history      Clear request history
  --help, -h           Show this help message

Interactive Mode:
  claudeflare          Launch interactive TUI (default)

Examples:
  claudeflare                        # Interactive mode
  claudeflare --serve                # Start server
  claudeflare --add-account work     # Add account
  claudeflare --stats                # View stats
`);
		process.exit(0);
	}

	// Handle non-interactive commands
	if (parsed.serve) {
		await tuiCore.serve({ port: parsed.port });
		return;
	}

	if (parsed.logs !== undefined) {
		const _limit = typeof parsed.logs === "number" ? parsed.logs : 100;
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
				console.log(`  - ${acc.name} (${acc.mode} mode, tier ${acc.tier})`);
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

	// Default: Launch interactive TUI
	const { waitUntilExit } = render(React.createElement(App));
	await waitUntilExit();
}

// Run main and handle errors
main().catch((error) => {
	console.error("Error:", error.message);
	process.exit(1);
});
