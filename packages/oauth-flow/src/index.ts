import type { Config } from "@ccflare/config";
import type { DatabaseOperations } from "@ccflare/database";
import {
	generatePKCE,
	getOAuthProvider,
	type OAuthProviderConfig,
	type OAuthTokens,
	type PKCEChallenge,
} from "@ccflare/providers";
import type { AccountTier } from "@ccflare/types";

export interface BeginOptions {
	name: string;
	mode: "max" | "console";
}

export interface BeginResult {
	sessionId: string;
	authUrl: string;
	pkce: PKCEChallenge;
	oauthConfig: OAuthProviderConfig;
	mode: "max" | "console"; // Track mode to handle differently in complete()
}

export interface CompleteOptions {
	sessionId: string;
	code: string;
	tier?: AccountTier;
	name: string; // Required to properly create the account
}

export interface AccountCreated {
	id: string;
	name: string;
	tier: number;
	provider: "anthropic";
	authType: "oauth" | "api_key"; // Track authentication type
}

export interface OAuthFlowResult {
	success: boolean;
	message: string;
	data?: AccountCreated;
}

export class OAuthFlow {
	constructor(
		private dbOps: DatabaseOperations,
		private config: Config,
	) {}

	/**
	 * Begin OAuth flow - generates PKCE, creates session, returns auth URL
	 */
	async begin(opts: BeginOptions): Promise<BeginResult> {
		const { name, mode } = opts;

		// Check if account already exists
		const existingAccounts = this.dbOps.getAllAccounts();
		if (existingAccounts.some((a) => a.name === name)) {
			throw new Error(`Account with name '${name}' already exists`);
		}

		// Get OAuth provider
		const oauthProvider = getOAuthProvider("anthropic");
		if (!oauthProvider) {
			throw new Error("Anthropic OAuth provider not found");
		}

		// Generate PKCE challenge
		const pkce = await generatePKCE();

		// Get OAuth config with runtime client ID
		const runtime = this.config.getRuntime();
		const oauthConfig = oauthProvider.getOAuthConfig(mode);
		oauthConfig.clientId = runtime.clientId;

		// Generate auth URL
		const authUrl = oauthProvider.generateAuthUrl(oauthConfig, pkce);

		// Create session ID (could be stored in DB for multi-instance setups)
		const sessionId = crypto.randomUUID();

		// Store session data in memory or DB
		// For now, we'll return it to be passed back in complete()
		// In a production system, this would be stored in Redis or DB

		return {
			sessionId,
			authUrl,
			pkce,
			oauthConfig,
			mode, // Include mode in the result
		};
	}

	/**
	 * Complete OAuth flow - exchanges code for tokens and creates account
	 */
	async complete(
		opts: CompleteOptions,
		flowData: BeginResult,
	): Promise<AccountCreated> {
		const { code, tier = 1, name } = opts;

		// Get OAuth provider
		const oauthProvider = getOAuthProvider("anthropic");
		if (!oauthProvider) {
			throw new Error("Anthropic OAuth provider not found");
		}

		// Exchange authorization code for tokens
		const tokens = await oauthProvider.exchangeCode(
			code,
			flowData.pkce.verifier,
			flowData.oauthConfig,
		);

		const accountId = crypto.randomUUID();

		// Handle console mode - create API key
		if (flowData.mode === "console" || !tokens.refreshToken) {
			const apiKey = await this.createAnthropicApiKey(tokens.accessToken);
			return this.createAccountWithApiKey(accountId, name, apiKey, tier);
		}

		// Handle max mode - standard OAuth flow
		return this.createAccountWithOAuth(accountId, name, tokens, tier);
	}

	/**
	 * Create API key using Anthropic console endpoint
	 */
	private async createAnthropicApiKey(accessToken: string): Promise<string> {
		const response = await fetch(
			"https://api.anthropic.com/api/oauth/claude_cli/create_api_key",
			{
				method: "POST",
				headers: {
					Authorization: `Bearer ${accessToken}`,
					"Content-Type": "application/x-www-form-urlencoded",
					Accept: "application/json, text/plain, */*",
				},
			},
		);

		if (!response.ok) {
			throw new Error(`Failed to create API key: ${response.statusText}`);
		}

		const json = (await response.json()) as { raw_key: string };
		return json.raw_key;
	}

	/**
	 * Create account with OAuth tokens (max mode)
	 */
	private createAccountWithOAuth(
		id: string,
		name: string,
		tokens: OAuthTokens,
		tier: AccountTier,
	): AccountCreated {
		const db = this.dbOps.getDatabase();

		db.run(
			`
			INSERT INTO accounts (
				id, name, provider, api_key, refresh_token, access_token, expires_at, 
				created_at, request_count, total_requests, account_tier
			) VALUES (?, ?, ?, NULL, ?, ?, ?, ?, 0, 0, ?)
			`,
			[
				id,
				name,
				"anthropic",
				tokens.refreshToken || "",
				tokens.accessToken,
				tokens.expiresAt,
				Date.now(),
				tier,
			],
		);

		return {
			id,
			name,
			tier,
			provider: "anthropic",
			authType: "oauth",
		};
	}

	/**
	 * Create account with API key (console mode)
	 */
	private createAccountWithApiKey(
		id: string,
		name: string,
		apiKey: string,
		tier: AccountTier,
	): AccountCreated {
		const db = this.dbOps.getDatabase();

		db.run(
			`
			INSERT INTO accounts (
				id, name, provider, api_key, refresh_token, access_token, expires_at, 
				created_at, request_count, total_requests, account_tier
			) VALUES (?, ?, ?, ?, NULL, NULL, NULL, ?, 0, 0, ?)
			`,
			[id, name, "anthropic", apiKey, Date.now(), tier],
		);

		return {
			id,
			name,
			tier,
			provider: "anthropic",
			authType: "api_key",
		};
	}
}

// Helper function for simpler usage
export async function createOAuthFlow(
	dbOps: DatabaseOperations,
	config: Config,
): Promise<OAuthFlow> {
	return new OAuthFlow(dbOps, config);
}
