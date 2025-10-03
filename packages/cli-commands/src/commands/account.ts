import type { Config } from "@better-ccflare/config";
import type { DatabaseOperations } from "@better-ccflare/database";
import { createOAuthFlow } from "@better-ccflare/oauth-flow";
import type { AccountListItem } from "@better-ccflare/types";
import {
	type PromptAdapter,
	promptAccountRemovalConfirmation,
	stdPromptAdapter,
} from "../prompts/index";
import { openBrowser } from "../utils/browser";

// Re-export types with adapter extension for CLI-specific options
export interface AddAccountOptions {
	name: string;
	mode?: "max" | "console" | "zai";
	tier?: 1 | 5 | 20;
	priority?: number;
	customEndpoint?: string;
	adapter?: PromptAdapter;
}

// Re-export AccountListItem from types for backward compatibility
export type { AccountListItem } from "@better-ccflare/types";

// Add mode property to AccountListItem for CLI display
export interface AccountListItemWithMode extends AccountListItem {
	mode: "max" | "console" | "zai";
}

/**
 * Add a new account using OAuth flow
 */
export async function addAccount(
	dbOps: DatabaseOperations,
	config: Config,
	options: AddAccountOptions,
): Promise<void> {
	const {
		name,
		mode: providedMode,
		tier: providedTier,
		priority: providedPriority,
		customEndpoint,
		adapter = stdPromptAdapter,
	} = options;

	// Create OAuth flow instance
	const oauthFlow = await createOAuthFlow(dbOps, config);

	// Prompt for mode if not provided
	const mode =
		providedMode ||
		(await adapter.select("What type of account would you like to add?", [
			{ label: "Claude Max account", value: "max" },
			{ label: "Claude Console account", value: "console" },
			{ label: "z.ai account (API key)", value: "zai" },
		]));

	if (mode === "zai") {
		// Handle z.ai accounts with API keys
		const apiKey = await adapter.input("\nEnter your z.ai API key: ");

		// Get tier for z.ai accounts
		const tier =
			providedTier ||
			(await adapter.select(
				"Select the tier for this account (used for weighted load balancing):",
				[
					{ label: "1x tier (default)", value: 1 },
					{ label: "5x tier (higher priority)", value: 5 },
					{ label: "20x tier (highest priority)", value: 20 },
				],
			));

		// Create z.ai account directly in database
		const accountId = crypto.randomUUID();
		const now = Date.now();

		dbOps.getDatabase().run(
			`INSERT INTO accounts (
				id, name, provider, api_key, refresh_token, access_token,
				expires_at, created_at, account_tier, request_count, total_requests, priority, custom_endpoint
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			[
				accountId,
				name,
				"zai",
				apiKey,
				apiKey, // Store API key as refresh_token for consistency
				apiKey, // Store API key as access_token
				now + 365 * 24 * 60 * 60 * 1000, // 1 year expiry
				now,
				tier,
				0,
				0,
				providedPriority || 0,
				customEndpoint || null,
			],
		);

		console.log(`\nAccount '${name}' added successfully!`);
		console.log("Type: z.ai (API key)");
		console.log(`Tier: ${tier}x`);
	} else {
		// Handle OAuth accounts (Anthropic)
		const flowResult = await oauthFlow.begin({
			name,
			mode: mode as "max" | "console",
		});
		const { authUrl, sessionId } = flowResult;

		// Open browser and prompt for code
		console.log(`\nOpening browser to authenticate...`);
		console.log(`URL: ${authUrl}`);
		const browserOpened = await openBrowser(authUrl);
		if (!browserOpened) {
			console.log(
				`\nFailed to open browser automatically. Please manually open the URL above.`,
			);
		}

		// Get authorization code
		const code = await adapter.input("\nEnter the authorization code: ");

		// Get tier for Max accounts
		const tier =
			mode === "max"
				? providedTier ||
					(await adapter.select(
						"Select the tier for this account (used for weighted load balancing):",
						[
							{ label: "1x tier (default free account)", value: 1 },
							{ label: "5x tier (paid account)", value: 5 },
							{ label: "20x tier (enterprise account)", value: 20 },
						],
					))
				: 1;

		// Complete OAuth flow
		console.log("\nExchanging code for tokens...");
		const _account = await oauthFlow.complete(
			{ sessionId, code, tier, name, priority: providedPriority || 0 },
			flowResult,
		);

		console.log(`\nAccount '${name}' added successfully!`);
		console.log(`Type: ${mode === "max" ? "Claude Max" : "Claude Console"}`);
		console.log(`Tier: ${tier}x`);
	}
}

/**
 * Get list of all accounts with formatted information
 */
export function getAccountsList(dbOps: DatabaseOperations): AccountListItem[] {
	const accounts = dbOps.getAllAccounts();
	const now = Date.now();

	return accounts.map((account) => {
		const tierDisplay = `${account.account_tier}x`;
		const tokenStatus =
			account.expires_at && account.expires_at > now ? "valid" : "expired";

		let rateLimitStatus = "OK";
		if (account.paused) {
			rateLimitStatus = "Paused";
		} else if (account.rate_limited_until && account.rate_limited_until > now) {
			const minutesLeft = Math.ceil((account.rate_limited_until - now) / 60000);
			rateLimitStatus = `Rate limited (${minutesLeft}m)`;
		}

		let sessionInfo = "-";
		if (account.session_start) {
			const sessionAge = Math.floor((now - account.session_start) / 60000);
			sessionInfo = `${account.session_request_count} reqs, ${sessionAge}m ago`;
		}

		return {
			id: account.id,
			name: account.name,
			provider: account.provider,
			tierDisplay,
			created: new Date(account.created_at),
			lastUsed: account.last_used ? new Date(account.last_used) : null,
			requestCount: account.request_count,
			totalRequests: account.total_requests,
			paused: account.paused,
			tokenStatus,
			rateLimitStatus,
			sessionInfo,
			tier: account.account_tier || 1,
			mode:
				account.provider === "zai"
					? "zai"
					: account.account_tier > 1
						? "max"
						: "console",
			priority: account.priority || 0,
			autoFallbackEnabled: account.auto_fallback_enabled,
			autoRefreshEnabled: account.auto_refresh_enabled,
		};
	});
}

/**
 * Remove an account by name
 */
export function removeAccount(
	dbOps: DatabaseOperations,
	name: string,
): { success: boolean; message: string } {
	const db = dbOps.getDatabase();
	const result = db.run("DELETE FROM accounts WHERE name = ?", [name]);

	if (result.changes === 0) {
		return {
			success: false,
			message: `Account '${name}' not found`,
		};
	}

	return {
		success: true,
		message: `Account '${name}' removed successfully`,
	};
}

/**
 * Remove an account by name with confirmation prompt (for CLI)
 */
export async function removeAccountWithConfirmation(
	dbOps: DatabaseOperations,
	name: string,
	force?: boolean,
): Promise<{ success: boolean; message: string }> {
	// Check if account exists first
	const accounts = dbOps.getAllAccounts();
	const exists = accounts.some((a) => a.name === name);

	if (!exists) {
		return {
			success: false,
			message: `Account '${name}' not found`,
		};
	}

	// Skip confirmation if force flag is set
	if (!force) {
		const confirmed = await promptAccountRemovalConfirmation(name);
		if (!confirmed) {
			return {
				success: false,
				message: "Account removal cancelled",
			};
		}
	}

	return removeAccount(dbOps, name);
}

/**
 * Toggle account pause state (shared logic for pause/resume)
 */
function toggleAccountPause(
	dbOps: DatabaseOperations,
	name: string,
	shouldPause: boolean,
): { success: boolean; message: string } {
	const db = dbOps.getDatabase();

	// Get account ID by name
	const account = db
		.query<{ id: string; paused: 0 | 1 }, [string]>(
			"SELECT id, COALESCE(paused, 0) as paused FROM accounts WHERE name = ?",
		)
		.get(name);

	if (!account) {
		return {
			success: false,
			message: `Account '${name}' not found`,
		};
	}

	const isPaused = account.paused === 1;
	const _action = shouldPause ? "pause" : "resume";
	const actionPast = shouldPause ? "paused" : "resumed";

	if (isPaused === shouldPause) {
		return {
			success: false,
			message: `Account '${name}' is already ${actionPast}`,
		};
	}

	if (shouldPause) {
		dbOps.pauseAccount(account.id);
	} else {
		dbOps.resumeAccount(account.id);
	}

	return {
		success: true,
		message: `Account '${name}' ${actionPast} successfully`,
	};
}

/**
 * Pause an account by name
 */
export function pauseAccount(
	dbOps: DatabaseOperations,
	name: string,
): { success: boolean; message: string } {
	return toggleAccountPause(dbOps, name, true);
}

/**
 * Resume a paused account by name
 */
export function resumeAccount(
	dbOps: DatabaseOperations,
	name: string,
): { success: boolean; message: string } {
	return toggleAccountPause(dbOps, name, false);
}

/**
 * Set the priority of an account by name
 */
export function setAccountPriority(
	dbOps: DatabaseOperations,
	name: string,
	priority: number,
): { success: boolean; message: string } {
	const db = dbOps.getDatabase();

	// Get account ID by name
	const account = db
		.query<{ id: string }, [string]>("SELECT id FROM accounts WHERE name = ?")
		.get(name);

	if (!account) {
		return {
			success: false,
			message: `Account '${name}' not found`,
		};
	}

	// Update the account priority
	db.run("UPDATE accounts SET priority = ? WHERE id = ?", [
		priority,
		account.id,
	]);

	return {
		success: true,
		message: `Account '${name}' priority set to ${priority}`,
	};
}
