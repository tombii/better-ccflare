#!/usr/bin/env bun

import { parseArgs } from "node:util";
import crypto from "node:crypto";
import { DatabaseOperations } from "@claudeflare/database";
import { Config } from "@claudeflare/config";

// Initialize database and config
const dbOps = new DatabaseOperations();
const config = new Config();
const runtime = config.getRuntime();

async function generatePKCE() {
	const verifier = crypto.randomBytes(32).toString("base64url");
	const challenge = crypto
		.createHash("sha256")
		.update(verifier)
		.digest("base64url");
	return { verifier, challenge };
}

async function authorize(mode: "max" | "console") {
	const pkce = await generatePKCE();

	const url = new URL(
		`https://${mode === "console" ? "console.anthropic.com" : "claude.ai"}/oauth/authorize`,
	);
	url.searchParams.set("code", "true");
	url.searchParams.set("client_id", runtime.clientId);
	url.searchParams.set("response_type", "code");
	url.searchParams.set(
		"redirect_uri",
		"https://console.anthropic.com/oauth/code/callback",
	);
	url.searchParams.set(
		"scope",
		"org:create_api_key user:profile user:inference",
	);
	url.searchParams.set("code_challenge", pkce.challenge);
	url.searchParams.set("code_challenge_method", "S256");
	url.searchParams.set("state", pkce.verifier);

	return {
		url: url.toString(),
		verifier: pkce.verifier,
	};
}

async function exchangeCode(code: string, verifier: string) {
	const splits = code.split("#");
	const response = await fetch("https://console.anthropic.com/v1/oauth/token", {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
		},
		body: JSON.stringify({
			code: splits[0],
			state: splits[1],
			grant_type: "authorization_code",
			client_id: runtime.clientId,
			redirect_uri: "https://console.anthropic.com/oauth/code/callback",
			code_verifier: verifier,
		}),
	});

	if (!response.ok) {
		throw new Error(`Exchange failed: ${response.statusText}`);
	}

	const json = (await response.json()) as {
		refresh_token: string;
		access_token: string;
		expires_in: number;
	};
	return {
		refresh: json.refresh_token,
		access: json.access_token,
		expires: Date.now() + json.expires_in * 1000,
	};
}

// Attempt to open a URL in the default browser (best-effort, cross-platform)
async function openBrowser(url: string) {
	try {
		const platform = process.platform;
		if (platform === "darwin") {
			await Bun.spawn(["open", url]);
		} else if (platform === "win32") {
			await Bun.spawn(["cmd", "/c", "start", "", url]);
		} else if (platform === "linux") {
			await Bun.spawn(["xdg-open", url]);
		} else {
			return false; // Unsupported platform
		}
		return true;
	} catch {
		return false;
	}
}

async function addAccount(
	name: string,
	mode?: "max" | "console",
	tier?: number,
) {
	// Check if account name already exists
	const accounts = dbOps.getAllAccounts();
	const existing = accounts.find((a) => a.name === name);
	if (existing) {
		console.error(`❌ Account with name "${name}" already exists`);
		process.exit(1);
	}

	// If mode not provided, ask user
	if (!mode) {
		console.log("\n🤔 Which type of account would you like to add?");
		console.log("  1. API Account (console.anthropic.com)");
		console.log("  2. Claude Max Account (claude.ai)");
		const choice = prompt("\nSelect (1 or 2): ");

		if (choice === "1") {
			mode = "console";
		} else if (choice === "2") {
			mode = "max";
		} else {
			console.error("❌ Invalid choice");
			process.exit(1);
		}
	}

	// If max account and tier not provided, ask user
	if (mode === "max" && !tier) {
		console.log("\n🎯 Which tier is this Max account?");
		console.log("  1. Pro Account (1x capacity)");
		console.log("  5. Max 5x Account (5x capacity)");
		console.log("  20. Max 20x Account (20x capacity)");
		const tierChoice = prompt("\nSelect tier (1, 5, or 20): ");

		tier = parseInt(tierChoice || "1");
		if (![1, 5, 20].includes(tier)) {
			console.error("❌ Invalid tier. Must be 1, 5, or 20");
			process.exit(1);
		}
	} else if (!tier) {
		tier = 1; // Default tier for console accounts
	}

	const { url, verifier } = await authorize(mode);

	console.log(`\n🔗 Authorization URL: ${url}`);

	const opened = await openBrowser(url);
	if (opened) {
		console.log(
			"🌐 Your default browser has been opened. Complete the authorization then come back here.",
		);
	} else {
		console.log(
			"⚠️  Could not automatically open the browser. Please copy the URL above and open it manually.",
		);
	}

	console.log("\n📋 After authorization, you'll get a code. Paste it here:");

	const code = prompt("Authorization code: ");
	if (!code) {
		console.error("❌ No code provided");
		process.exit(1);
	}

	try {
		const tokens = await exchangeCode(code, verifier);
		const id = crypto.randomUUID();

		const db = dbOps.getDatabase();
		db.run(
			`INSERT INTO accounts (id, name, provider, refresh_token, access_token, expires_at, created_at, account_tier) 
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
			[
				id,
				name,
				"anthropic",
				tokens.refresh,
				tokens.access,
				tokens.expires,
				Date.now(),
				tier,
			],
		);

		let tierMsg = "";
		if (mode === "max" && tier > 1) {
			tierMsg = ` as Max ${tier}x Account`;
		}
		console.log(`✅ Account "${name}" added successfully${tierMsg}!`);
	} catch (error) {
		console.error("❌ Failed to exchange code:", error);
		process.exit(1);
	}
}

function listAccounts() {
	const accounts = dbOps.getAllAccounts();

	if (accounts.length === 0) {
		console.log("No accounts found. Add one with: bun cli add <name>");
		return;
	}

	console.log("\n📊 Claude Accounts:");
	console.log("─".repeat(100));

	for (const account of accounts) {
		const lastUsed = account.last_used
			? new Date(account.last_used).toLocaleString()
			: "Never";
		const tokenStatus =
			account.expires_at && account.expires_at > Date.now()
				? "✅ Valid"
				: "⏳ Expired";
		const rateLimitStatus =
			account.rate_limited_until && account.rate_limited_until > Date.now()
				? `🚫 Rate limited until ${new Date(account.rate_limited_until).toLocaleString()}`
				: "✅ Not rate limited";
		const sessionInfo = account.session_start
			? `Started ${new Date(account.session_start).toLocaleString()}, ${account.session_request_count || 0} requests`
			: "No active session";

		let tierDisplay = "";
		if (account.provider === "anthropic" && account.account_tier) {
			if (account.account_tier === 1) tierDisplay = " (Pro Account)";
			else if (account.account_tier === 5) tierDisplay = " (Max 5x Account)";
			else if (account.account_tier === 20) tierDisplay = " (Max 20x Account)";
		}

		console.log(`\n🔑 ${account.name}${tierDisplay}`);
		console.log(`   ID: ${account.id}`);
		console.log(`   Provider: ${account.provider || "anthropic"}`);
		console.log(`   Created: ${new Date(account.created_at).toLocaleString()}`);
		console.log(`   Last Used: ${lastUsed}`);
		console.log(
			`   Requests: ${account.request_count} (Total: ${account.total_requests || account.request_count})`,
		);
		console.log(`   Token: ${tokenStatus}`);
		console.log(`   Rate Limit: ${rateLimitStatus}`);
		console.log(`   Session: ${sessionInfo}`);
	}
	console.log(`\n${"─".repeat(100)}`);
}

function removeAccount(name: string) {
	const db = dbOps.getDatabase();
	const result = db.run(`DELETE FROM accounts WHERE name = ?`, [name]);

	if (result.changes === 0) {
		console.error(`❌ Account "${name}" not found`);
		process.exit(1);
	}

	console.log(`✅ Account "${name}" removed successfully`);
}

function resetStats() {
	const db = dbOps.getDatabase();
	db.run(
		`UPDATE accounts SET request_count = 0, last_used = NULL, session_start = NULL, session_request_count = 0`,
	);
	console.log("✅ Statistics reset for all accounts");
}

function clearHistory() {
	const db = dbOps.getDatabase();
	const result = db
		.query<{ count: number }, []>("SELECT COUNT(*) as count FROM requests")
		.get();
	const count = result?.count || 0;

	if (count === 0) {
		console.log("ℹ️  No request history to clear");
		return;
	}

	// Clear the requests table
	db.run(`DELETE FROM requests`);

	console.log(`✅ Cleared ${count} request(s) from history`);
}

function showHelp() {
	console.log(`
Claude Load Balancer CLI

Usage:
  claudeflare <command> [options]

Commands:
  add <name> [--mode max|console] [--tier 1|5|20]  Add a new Claude account
  list                                               List all accounts and their stats
  remove <name>                                      Remove an account
  reset-stats                                        Reset usage statistics for all accounts
  clear-history                                      Clear all request history
  help                                               Show this help message

Examples:
  claudeflare add personal                           Add account (interactive mode)
  claudeflare add work --mode max                    Add Max account (will ask for tier)
  claudeflare add pro --mode console                 Add API account
  claudeflare add premium --mode max --tier 5        Add Max 5x account
  claudeflare add enterprise --mode max --tier 20    Add Max 20x account
  claudeflare list                                    Show all accounts
  claudeflare remove personal                         Remove the personal account
`);
}

// Parse command line arguments
const { values, positionals } = parseArgs({
	args: Bun.argv,
	options: {
		mode: {
			type: "string",
		},
		tier: {
			type: "string",
		},
	},
	strict: false,
	allowPositionals: true,
});

const command = positionals[2]; // Skip bun and script path

switch (command) {
	case "add": {
		const accountName = positionals[3];
		if (!accountName) {
			console.error("❌ Please provide an account name");
			console.log("Usage: claudeflare add <name> [--mode max|console]");
			process.exit(1);
		}
		// Parse optional mode and tier
		let mode: "max" | "console" | undefined;
		let tier: number | undefined;

		if (values.mode) {
			mode = values.mode as "max" | "console";
			if (mode !== "max" && mode !== "console") {
				console.error("❌ Invalid mode. Use 'max' or 'console'");
				process.exit(1);
			}
		}

		if (values.tier) {
			tier = parseInt(values.tier as string);
			if (![1, 5, 20].includes(tier)) {
				console.error("❌ Invalid tier. Use 1, 5, or 20");
				process.exit(1);
			}
		}

		await addAccount(accountName, mode, tier);
		break;
	}

	case "list":
		listAccounts();
		break;

	case "remove": {
		const removeAccountName = positionals[3];
		if (!removeAccountName) {
			console.error("❌ Please provide an account name");
			console.log("Usage: claudeflare remove <name>");
			process.exit(1);
		}
		removeAccount(removeAccountName);
		break;
	}

	case "reset-stats":
		resetStats();
		break;

	case "clear-history":
		clearHistory();
		break;

	default:
		showHelp();
}

// Close database connection when done
dbOps.close();
