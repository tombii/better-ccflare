import type { Config } from "@better-ccflare/config";
import type { ModelMapping } from "@better-ccflare/core";
import {
	validateAndSanitizeModelMappings,
	validateApiKey,
	validateEndpointUrl,
	validatePriority,
} from "@better-ccflare/core";
import type { DatabaseOperations } from "@better-ccflare/database";
import { createOAuthFlow } from "@better-ccflare/oauth-flow";
import { getOAuthProvider } from "@better-ccflare/providers";
import type { AccountListItem, AccountTier } from "@better-ccflare/types";
import {
	type PromptAdapter,
	promptAccountRemovalConfirmation,
	stdPromptAdapter,
} from "../prompts/index";
import { openBrowser } from "../utils/browser";

// Re-export types with adapter extension for CLI-specific options
export interface AddAccountOptions {
	name: string;
	mode?: "max" | "console" | "zai" | "openai-compatible";
	tier?: 1 | 5 | 20;
	priority?: number;
	customEndpoint?: string;
	modelMappings?: { [key: string]: string };
	adapter?: PromptAdapter;
}

// Re-export AccountListItem from types for backward compatibility
export type { AccountListItem } from "@better-ccflare/types";

// Add mode property to AccountListItem for CLI display
export interface AccountListItemWithMode extends AccountListItem {
	mode: "max" | "console" | "zai" | "openai-compatible";
}

/**
 * Create a z.ai account in the database
 */
async function createZaiAccount(
	dbOps: DatabaseOperations,
	name: string,
	apiKey: string,
	tier: number,
	priority: number,
): Promise<void> {
	const accountId = crypto.randomUUID();
	const now = Date.now();

	// Validate inputs
	const validatedApiKey = validateApiKey(apiKey, "z.ai API key");
	const validatedPriority = validatePriority(priority, "priority");

	dbOps.getDatabase().run(
		`INSERT INTO accounts (
			id, name, provider, api_key, refresh_token, access_token,
			expires_at, created_at, account_tier, request_count, total_requests, priority, custom_endpoint
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		[
			accountId,
			name,
			"zai",
			validatedApiKey,
			validatedApiKey, // Store API key as refresh_token for consistency
			validatedApiKey, // Store API key as access_token
			now + 365 * 24 * 60 * 60 * 1000, // 1 year expiry
			now,
			tier,
			0,
			0,
			validatedPriority,
			null,
		],
	);

	console.log(`\nAccount '${name}' added successfully!`);
	console.log("Type: z.ai (API key)");
	console.log(`Tier: ${tier}x`);
}

/**
 * Prompt user for model mappings
 */
async function promptModelMappings(
	adapter: PromptAdapter,
	existingMappings?: ModelMapping,
): Promise<ModelMapping | null> {
	const wantsCustomMappings = await adapter.select(
		"\nDo you want to configure custom model mappings?",
		[
			{
				label: "No, use defaults (opus/sonnet→gpt-5, haiku→gpt-5-mini)",
				value: "no",
			},
			{ label: "Yes, configure custom mappings", value: "yes" },
		],
	);

	if (wantsCustomMappings === "no" || existingMappings) {
		return existingMappings || null;
	}

	console.log(
		"\nEnter model mappings (press Enter with empty value to finish):",
	);
	const mappings: ModelMapping = {};

	// Get opus mapping
	const opusModel = await adapter.input("Opus model (default: openai/gpt-5): ");
	if (opusModel.trim()) {
		mappings.opus = opusModel.trim();
	}

	// Get sonnet mapping
	const sonnetModel = await adapter.input(
		"Sonnet model (default: openai/gpt-5): ",
	);
	if (sonnetModel.trim()) {
		mappings.sonnet = sonnetModel.trim();
	}

	// Get haiku mapping
	const haikuModel = await adapter.input(
		"Haiku model (default: openai/gpt-5-mini): ",
	);
	if (haikuModel.trim()) {
		mappings.haiku = haikuModel.trim();
	}

	return Object.keys(mappings).length > 0 ? mappings : null;
}

/**
 * Create an OpenAI-compatible account in the database
 */
async function createOpenAIAccount(
	dbOps: DatabaseOperations,
	name: string,
	apiKey: string,
	endpoint: string,
	priority: number,
	modelMappings: ModelMapping | null,
	providedTier: number | undefined,
): Promise<void> {
	const accountId = crypto.randomUUID();
	const now = Date.now();

	// Validate inputs
	const validatedApiKey = validateApiKey(apiKey, "API key");
	const validatedEndpoint = validateEndpointUrl(endpoint, "endpoint");
	const validatedPriority = validatePriority(priority, "priority");

	// Validate and sanitize model mappings
	const validatedModelMappings =
		validateAndSanitizeModelMappings(modelMappings);

	// Store model mappings in dedicated field if provided
	const modelMappingsJson = validatedModelMappings
		? JSON.stringify(validatedModelMappings)
		: null;

	dbOps.getDatabase().run(
		`INSERT INTO accounts (
			id, name, provider, api_key, refresh_token, access_token,
			expires_at, created_at, account_tier, request_count, total_requests, priority, custom_endpoint, model_mappings
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		[
			accountId,
			name,
			"openai-compatible",
			validatedApiKey,
			validatedApiKey, // Store API key as refresh_token for consistency
			validatedApiKey, // Store API key as access_token
			null, // No expiry for OpenAI-compatible providers (API keys don't expire)
			now,
			providedTier || 1, // Default to tier 1 (doesn't matter for OpenAI-compatible)
			0,
			0,
			validatedPriority,
			validatedEndpoint,
			modelMappingsJson,
		],
	);

	console.log(`\nAccount '${name}' added successfully!`);
	console.log("Type: OpenAI-compatible (API key)");
	console.log(`Endpoint: ${validatedEndpoint}`);
	console.log("Tier: 1 (default for OpenAI-compatible providers)");
	console.log(`Priority: ${validatedPriority}`);

	if (
		validatedModelMappings &&
		Object.keys(validatedModelMappings).length > 0
	) {
		console.log("Model mappings:");
		for (const [key, value] of Object.entries(validatedModelMappings)) {
			console.log(`  ${key} → ${value}`);
		}
	}
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
		modelMappings,
		adapter = stdPromptAdapter,
	} = options;

	// Create OAuth flow instance
	const oauthFlow = await createOAuthFlow(dbOps, config);

	// Prompt for mode if not provided
	const mode =
		providedMode ||
		(await adapter.select("What type of account would you like to add?", [
			{ label: "Claude CLI account", value: "max" },
			{ label: "Claude API account", value: "console" },
			{ label: "z.ai account (API key)", value: "zai" },
			{
				label: "OpenAI-compatible provider (API key)",
				value: "openai-compatible",
			},
		]));

	if (mode === "zai") {
		// Handle z.ai accounts with API keys
		const apiKey = await adapter.input("\nEnter your z.ai API key: ");

		// Get tier for z.ai accounts
		const tier =
			providedTier ||
			(await adapter.select("Select the tier for this account:", [
				{ label: "1x tier (z.ai Lite)", value: 1 },
				{ label: "5x tier (z.ai Pro)", value: 5 },
				{ label: "20x tier (z.ai Max)", value: 20 },
			]));

		await createZaiAccount(dbOps, name, apiKey, tier, providedPriority || 0);
	} else if (mode === "openai-compatible") {
		// Handle OpenAI-compatible accounts with API keys
		const apiKey = await adapter.input("\nEnter your API key: ");

		// Get custom endpoint
		const endpoint =
			customEndpoint ||
			(await adapter.input(
				"\nEnter API endpoint URL (e.g., https://api.openrouter.ai/api/v1): ",
			));

		// Get priority
		const priority =
			providedPriority ??
			(await adapter.input(
				"\nEnter priority (0 = highest, lower number = higher priority, default 0): ",
			));

		// Get model mappings
		const finalModelMappings = await promptModelMappings(
			adapter,
			modelMappings,
		);

		await createOpenAIAccount(
			dbOps,
			name,
			apiKey,
			endpoint,
			typeof priority === "string" ? parseInt(priority) || 0 : priority || 0,
			finalModelMappings,
			providedTier,
		);
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

		// Get tier for Claude accounts (both CLI and API)
		const tier =
			providedTier ||
			(await adapter.select("Select the tier for this account:", [
				{ label: "1x tier (Pro)", value: 1 },
				{ label: "5x tier (Max 5x)", value: 5 },
				{ label: "20x tier (Max 20x)", value: 20 },
			]));

		// Complete OAuth flow
		console.log("\nExchanging code for tokens...");
		const _account = await oauthFlow.complete(
			{
				sessionId,
				code,
				tier: tier as AccountTier,
				name,
				priority: providedPriority || 0,
			},
			flowResult,
		);

		console.log(`\nAccount '${name}' added successfully!`);
		console.log(`Type: ${mode === "max" ? "Claude CLI" : "Claude API"}`);
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

/**
 * Re-authenticate an account by name (preserves all metadata)
 * This performs soft re-authentication: only updates OAuth tokens, keeps all other data
 */
export async function reauthenticateAccount(
	dbOps: DatabaseOperations,
	config: Config,
	name: string,
): Promise<{ success: boolean; message: string }> {
	const db = dbOps.getDatabase();

	// Get account by name
	const account = db
		.query<
			{
				id: string;
				provider: string;
				account_tier: number;
				priority: number;
				custom_endpoint: string | null;
				api_key: string | null;
			},
			[string]
		>(
			"SELECT id, provider, account_tier, priority, custom_endpoint, api_key FROM accounts WHERE name = ?",
		)
		.get(name);

	if (!account) {
		return {
			success: false,
			message: `Account '${name}' not found`,
		};
	}

	// Check if account supports OAuth (only anthropic provider)
	if (account.provider !== "anthropic") {
		return {
			success: false,
			message: `Account '${name}' (${account.provider}) does not support OAuth re-authentication. Only Anthropic accounts can be re-authenticated.`,
		};
	}

	// Create OAuth flow instance
	const oauthFlow = await createOAuthFlow(dbOps, config);

	console.log(`\nRe-authenticating account '${name}'...`);
	console.log(
		"This will preserve all your account metadata (usage stats, priority, etc.)",
	);

	// Determine account mode based on token presence (not tier)
	// OAuth accounts have access_token + refresh_token but no api_key
	// Console accounts have api_key but no access_token/refresh_token
	const mode = account.api_key ? "console" : "max";

	// Start OAuth flow with skipAccountCheck for re-authentication
	const flowResult = await oauthFlow.begin({
		name,
		mode,
		skipAccountCheck: true,
	});
	const { authUrl, sessionId } = flowResult;

	// Open browser and prompt for code
	console.log(`\nOpening browser to re-authenticate...`);
	console.log(`URL: ${authUrl}`);
	const browserOpened = await openBrowser(authUrl);
	if (!browserOpened) {
		console.log(
			`\nFailed to open browser automatically. Please manually open the URL above.`,
		);
	}

	// Import prompt adapter for code input
	const { stdPromptAdapter } = await import("../prompts/index");

	// Get authorization code
	const code = await stdPromptAdapter.input("\nEnter the authorization code: ");

	// Get OAuth provider and exchange code for tokens manually
	console.log("\nExchanging code for new tokens...");
	const oauthProvider = getOAuthProvider("anthropic");
	if (!oauthProvider) {
		return {
			success: false,
			message: "Anthropic OAuth provider not found",
		};
	}

	// Validate authorization code format
	if (!code || code.trim().length === 0) {
		return {
			success: false,
			message: "Authorization code is required",
		};
	}

	console.log(`Authorization code received: ${code.substring(0, 20)}...`);
	console.log(`PKCE verifier: ${flowResult.pkce.verifier.substring(0, 10)}...`);

	try {
		const tokens = await oauthProvider.exchangeCode(
			code,
			flowResult.pkce.verifier,
			flowResult.oauthConfig,
		);
		console.log(`Token exchange successful! New tokens received.`);
	} catch (error) {
		console.error(`Token exchange failed: ${error instanceof Error ? error.message : String(error)}`);
		return {
			success: false,
			message: `Failed to exchange authorization code for tokens: ${error instanceof Error ? error.message : String(error)}`,
		};
	}

	// Handle console mode - create API key and store as api_key
	if (mode === "console" || !tokens.refreshToken) {
		// Create API key using same method as OAuth flow
		const response = await fetch(
			"https://api.anthropic.com/api/oauth/claude_cli/create_api_key",
			{
				method: "POST",
				headers: {
					Authorization: `Bearer ${tokens.accessToken}`,
					"Content-Type": "application/x-www-form-urlencoded",
					Accept: "application/json, text/plain, */*",
				},
			},
		);

		if (!response.ok) {
			throw new Error(`Failed to create API key: ${response.statusText}`);
		}

		const json = (await response.json()) as { raw_key: string };
		const apiKey = json.raw_key;

		// Update existing account with new API key (preserving all other metadata)
		db.run(
			`UPDATE accounts SET
				api_key = ?,
				refresh_token = ?,
				access_token = NULL,
				expires_at = NULL
			WHERE id = ?`,
			[apiKey, apiKey, account.id],
		);

		console.log(`\nAccount '${name}' re-authenticated successfully!`);
		console.log("All account metadata (usage stats, priority, settings) has been preserved.");
		console.log("API key has been updated.");

		return {
			success: true,
			message: `Account '${name}' re-authenticated successfully. All metadata preserved.`,
		};
	}

	// Handle max mode - update with OAuth tokens
	// Update existing account with new tokens (preserving all other metadata)
	db.run(
		`UPDATE accounts SET
			refresh_token = ?,
			access_token = ?,
			expires_at = ?
		WHERE id = ?`,
		[
			tokens.refreshToken,
			tokens.accessToken,
			tokens.expiresAt,
			account.id,
		],
	);

	console.log(`\nAccount '${name}' re-authenticated successfully!`);
	console.log("All account metadata (usage stats, priority, settings) has been preserved.");
	console.log("OAuth tokens have been updated.");

	return {
		success: true,
		message: `Account '${name}' re-authenticated successfully. All metadata preserved.`,
	};
}
