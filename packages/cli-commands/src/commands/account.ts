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
import {
	getOAuthProvider,
	type TokenRefreshResult as TokenResult,
} from "@better-ccflare/providers";
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
	mode?:
		| "max"
		| "console"
		| "zai"
		| "minimax"
		| "anthropic-compatible"
		| "openai-compatible";
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
 * Create a Console account with direct API key in the database
 */
async function createConsoleAccountWithApiKey(
	dbOps: DatabaseOperations,
	name: string,
	apiKey: string,
	priority: number,
	customEndpoint?: string,
): Promise<void> {
	const accountId = crypto.randomUUID();
	const now = Date.now();

	// Validate inputs
	const validatedApiKey = validateApiKey(apiKey, "Claude API key");
	const validatedPriority = validatePriority(priority, "priority");

	dbOps.getDatabase().run(
		`INSERT INTO accounts (
			id, name, provider, api_key, refresh_token, access_token,
			expires_at, created_at, request_count, total_requests, priority, custom_endpoint
		) VALUES (?, ?, ?, ?, NULL, NULL, NULL, ?, 0, 0, ?, ?)`,
		[
			accountId,
			name,
			"anthropic",
			validatedApiKey,
			now,
			validatedPriority,
			customEndpoint || null,
		],
	);

	console.log(`\nAccount '${name}' added successfully!`);
	console.log("Type: Claude Console (API key)");
}

/**
 * Create a Minimax account in the database
 */
async function createMinimaxAccount(
	dbOps: DatabaseOperations,
	name: string,
	apiKey: string,
	priority: number,
): Promise<void> {
	const accountId = crypto.randomUUID();
	const now = Date.now();

	// Validate inputs
	const validatedApiKey = validateApiKey(apiKey, "Minimax API key");
	const validatedPriority = validatePriority(priority, "priority");

	dbOps.getDatabase().run(
		`INSERT INTO accounts (
			id, name, provider, api_key, refresh_token, access_token,
			expires_at, created_at, request_count, total_requests, priority, custom_endpoint
		) VALUES (?, ?, ?, ?, NULL, NULL, NULL, ?, 0, 0, ?, ?)`,
		[
			accountId,
			name,
			"minimax",
			validatedApiKey,
			now,
			validatedPriority,
			null, // No custom endpoint for minimax
		],
	);
}

/**
 * Create an Anthropic-compatible account in the database
 */
async function createAnthropicCompatibleAccount(
	dbOps: DatabaseOperations,
	name: string,
	apiKey: string,
	priority: number,
	customEndpoint?: string,
	modelMappings?: { [key: string]: string } | null,
): Promise<void> {
	const accountId = crypto.randomUUID();
	const now = Date.now();

	// Validate inputs
	const validatedApiKey = validateApiKey(
		apiKey,
		"Anthropic-compatible API key",
	);
	const validatedPriority = validatePriority(priority, "priority");

	// Validate and sanitize custom endpoint if provided
	let validatedEndpoint = null;
	if (customEndpoint) {
		validatedEndpoint = validateEndpointUrl(customEndpoint, "custom endpoint");
	}

	// Validate and sanitize model mappings if provided
	let validatedModelMappings = null;
	if (modelMappings && Object.keys(modelMappings).length > 0) {
		const validatedMappings = validateAndSanitizeModelMappings(modelMappings);
		validatedModelMappings = JSON.stringify(validatedMappings);
	}

	dbOps.getDatabase().run(
		`INSERT INTO accounts (
			id, name, provider, api_key, refresh_token, access_token,
			expires_at, created_at, request_count, total_requests, priority, custom_endpoint, model_mappings
		) VALUES (?, ?, ?, ?, NULL, NULL, NULL, ?, 0, 0, ?, ?, ?)`,
		[
			accountId,
			name,
			"anthropic-compatible",
			validatedApiKey,
			now,
			validatedPriority,
			validatedEndpoint,
			validatedModelMappings,
		],
	);
}

/**
 * Create a z.ai account in the database
 */
async function createZaiAccount(
	dbOps: DatabaseOperations,
	name: string,
	apiKey: string,
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
			expires_at, created_at, request_count, total_requests, priority, custom_endpoint
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		[
			accountId,
			name,
			"zai",
			validatedApiKey,
			validatedApiKey, // Store API key as refresh_token for consistency
			validatedApiKey, // Store API key as access_token
			now + 365 * 24 * 60 * 60 * 1000, // 1 year expiry
			now,
			0,
			0,
			validatedPriority,
			null,
		],
	);

	console.log(`\nAccount '${name}' added successfully!`);
	console.log("Type: z.ai (API key)");
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
			expires_at, created_at, request_count, total_requests, priority, custom_endpoint, model_mappings
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		[
			accountId,
			name,
			"openai-compatible",
			validatedApiKey,
			validatedApiKey, // Store API key as refresh_token for consistency
			validatedApiKey, // Store API key as access_token
			null, // No expiry for OpenAI-compatible providers (API keys don't expire)
			now,
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
			{ label: "Minimax account (API key)", value: "minimax" },
			{
				label: "Anthropic-compatible provider (API key)",
				value: "anthropic-compatible",
			},
			{
				label: "OpenAI-compatible provider (API key)",
				value: "openai-compatible",
			},
		]));

	if (mode === "zai") {
		// Handle z.ai accounts with API keys
		const apiKey = await adapter.input("\nEnter your z.ai API key: ");

		await createZaiAccount(dbOps, name, apiKey, providedPriority || 0);
	} else if (mode === "console") {
		// Handle Console accounts - offer choice between OAuth and direct API key
		const consoleMethod = await adapter.select(
			"\nHow would you like to set up your Console account?",
			[
				{
					label: "OAuth (recommended) - Automatically creates API key",
					value: "oauth",
				},
				{
					label: "Direct API key - Enter your existing x-api-key",
					value: "apikey",
				},
			],
		);

		if (consoleMethod === "apikey") {
			// Direct API key approach
			const apiKey = await adapter.input(
				"\nEnter your Claude API key (x-api-key): ",
			);

			// Get custom endpoint
			let endpointForConsole = customEndpoint;
			if (!customEndpoint) {
				const wantsCustomEndpoint = await adapter.select(
					"\nDo you want to use a custom endpoint for this Console account?",
					[
						{ label: "No, use default endpoint", value: "no" },
						{ label: "Yes, use custom endpoint", value: "yes" },
					],
				);

				if (wantsCustomEndpoint === "yes") {
					endpointForConsole = await adapter.input(
						"Enter custom endpoint URL (e.g., https://api.anthropic.com): ",
					);
				}
			}

			// Create console account with direct API key
			await createConsoleAccountWithApiKey(
				dbOps,
				name,
				apiKey,
				providedPriority || 0,
				endpointForConsole,
			);

			console.log(`\nAccount '${name}' added successfully!`);
			console.log("Type: Claude Console (API key)");
			if (endpointForConsole) {
				console.log(`Endpoint: ${endpointForConsole}`);
			}
			return; // Exit early for direct API key approach
		}
		// Fall through to OAuth flow for consoleMethod === "oauth"
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
		);
	} else if (mode === "minimax") {
		// Handle Minimax accounts with API keys
		const apiKey = await adapter.input("\nEnter your Minimax API key: ");

		await createMinimaxAccount(dbOps, name, apiKey, providedPriority || 0);
		console.log(`\nAccount '${name}' added successfully!`);
		console.log("Type: Minimax (API key)");
	} else if (mode === "anthropic-compatible") {
		// Handle Anthropic-compatible accounts with API keys
		const apiKey = await adapter.input(
			"\nEnter your Anthropic-compatible API key: ",
		);

		// Get custom endpoint
		const endpoint =
			customEndpoint ||
			(await adapter.input(
				"\nEnter API endpoint URL (e.g., https://api.anthropic-compatible.com): ",
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

		await createAnthropicCompatibleAccount(
			dbOps,
			name,
			apiKey,
			typeof priority === "string" ? parseInt(priority) || 0 : priority || 0,
			endpoint,
			finalModelMappings,
		);
		console.log(`\nAccount '${name}' added successfully!`);
		console.log("Type: Anthropic-compatible (API key)");
		console.log(`Endpoint: ${endpoint}`);
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

		// Get custom endpoint for Max/Console modes if not provided
		let endpointForOAuth = customEndpoint;
		if ((mode === "max" || mode === "console") && !customEndpoint) {
			const wantsCustomEndpoint = await adapter.select(
				`\nDo you want to use a custom endpoint for this ${mode === "max" ? "CLI" : "Console"} account?`,
				[
					{ label: "No, use default endpoint", value: "no" },
					{ label: "Yes, use custom endpoint", value: "yes" },
				],
			);

			if (wantsCustomEndpoint === "yes") {
				endpointForOAuth = await adapter.input(
					"Enter custom endpoint URL (e.g., https://api.anthropic.com): ",
				);
			}
		}

		// Complete OAuth flow
		console.log("\nExchanging code for tokens...");
		const _account = await oauthFlow.complete(
			{
				sessionId,
				code,
				name,
				priority: providedPriority || 0,
				customEndpoint: endpointForOAuth,
			},
			flowResult,
		);

		console.log(`\nAccount '${name}' added successfully!`);
		console.log(`Type: ${mode === "max" ? "Claude CLI" : "Claude API"}`);
	}
}

/**
 * Get list of all accounts with formatted information
 */
export function getAccountsList(dbOps: DatabaseOperations): AccountListItem[] {
	const accounts = dbOps.getAllAccounts();
	const now = Date.now();

	return accounts.map((account) => {
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
			created: new Date(account.created_at),
			lastUsed: account.last_used ? new Date(account.last_used) : null,
			requestCount: account.request_count,
			totalRequests: account.total_requests,
			paused: account.paused,
			tokenStatus,
			rateLimitStatus,
			sessionInfo,
			mode:
				account.provider === "zai"
					? "zai"
					: account.access_token
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
				priority: number;
				custom_endpoint: string | null;
				api_key: string | null;
			},
			[string]
		>(
			"SELECT id, provider, priority, custom_endpoint, api_key FROM accounts WHERE name = ?",
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
	const { authUrl } = flowResult;

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

	console.log("Exchanging authorization code for tokens...");

	let tokens: TokenResult;

	try {
		tokens = await oauthProvider.exchangeCode(
			code,
			flowResult.pkce.verifier,
			flowResult.oauthConfig,
		);
		console.log("Token exchange successful!");
	} catch (error) {
		console.error("Token exchange failed:", error);
		return {
			success: false,
			message: `Failed to exchange authorization code: ${error instanceof Error ? error.message : String(error)}`,
		};
	}

	// Handle console mode - create API key and store as api_key
	if (mode === "console" || !tokens.refreshToken) {
		console.log("Creating API key for console mode...");

		try {
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
				return {
					success: false,
					message: `Failed to create API key: ${response.statusText}`,
				};
			}

			const json = (await response.json()) as { raw_key: string };
			const apiKey = json.raw_key;

			// Update existing account with new API key (preserving all other metadata)
			// Use transaction for atomic update
			try {
				db.run(
					`UPDATE accounts SET
						api_key = ?,
						refresh_token = ?,
						access_token = NULL,
						expires_at = NULL
					WHERE id = ?`,
					[apiKey, apiKey, account.id],
				);

				console.log("API key created and updated.");
				return await showSuccessMessage(name, "API key", account.id);
			} catch (dbError) {
				return {
					success: false,
					message: `Database error while updating account: ${dbError instanceof Error ? dbError.message : String(dbError)}`,
				};
			}
		} catch (error) {
			return {
				success: false,
				message: `Failed to create API key: ${error instanceof Error ? error.message : String(error)}`,
			};
		}
	}

	// Handle max mode - update with OAuth tokens
	console.log("Updating OAuth tokens...");

	try {
		db.run(
			`UPDATE accounts SET
				refresh_token = ?,
				access_token = ?,
				expires_at = ?
			WHERE id = ?`,
			[tokens.refreshToken, tokens.accessToken, tokens.expiresAt, account.id],
		);

		console.log("OAuth tokens updated.");
		return await showSuccessMessage(name, "OAuth tokens", account.id);
	} catch (dbError) {
		return {
			success: false,
			message: `Database error while updating tokens: ${dbError instanceof Error ? dbError.message : String(dbError)}`,
		};
	}

	/**
	 * Helper function to show consistent success message
	 */
	async function showSuccessMessage(
		name: string,
		updatedType: string,
		accountId: string,
	) {
		console.log(`\nAccount '${name}' re-authenticated successfully!`);
		console.log(
			"All account metadata (usage stats, priority, settings) has been preserved.",
		);
		console.log(`${updatedType} have been updated.`);

		// Trigger token reload for running servers (non-blocking)
		console.log("\nNotifying running servers to reload tokens...");
		notifyServersToReload(accountId).catch(() => {
			// Ignore errors - server notification is best-effort
		});

		return {
			success: true,
			message: `Account '${name}' re-authenticated successfully. All metadata preserved.`,
		};
	}

	/**
	 * Notify running servers to reload tokens for an account
	 */
	async function notifyServersToReload(accountId: string): Promise<void> {
		const defaultPort = 8080;
		const testPort = 8081;

		// Check if API authentication is enabled
		const activeApiKeys = dbOps.getActiveApiKeys();
		const requiresAuth = activeApiKeys.length > 0;

		if (requiresAuth) {
			console.log(
				"⚠️  API authentication is enabled - automatic server reload not supported",
			);
			console.log(
				"   Please restart the server manually to use the new tokens:",
			);
			console.log("   - Stop the running server");
			console.log("   - Start it again with: bun start");
			return;
		}

		// If no API authentication, proceed with unauthenticated requests
		for (const port of [defaultPort, testPort]) {
			try {
				const response = await fetch(
					`http://localhost:${port}/api/accounts/${accountId}/reload`,
					{
						method: "POST",
						headers: { "Content-Type": "application/json" },
					},
				);

				if (response.ok) {
					console.log(`✓ Token reload successful on port ${port}`);
				} else {
					console.log(
						`✗ Server not responding on port ${port} (${response.status})`,
					);
				}
			} catch (_error) {
				console.log(`✗ No server running on port ${port}`);
			}
		}
	}
}
