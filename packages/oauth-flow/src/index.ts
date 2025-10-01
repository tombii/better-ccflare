import type { Config } from "@better-ccflare/config";
import type { DatabaseOperations } from "@better-ccflare/database";
import {
	generatePKCE,
	getOAuthProvider,
	type OAuthProviderConfig,
	type OAuthTokens,
	type PKCEChallenge,
} from "@better-ccflare/providers";
import type { AccountTier } from "@better-ccflare/types";

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
	priority?: number;
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

/**
 * Handles the Anthropic OAuth flow for both "max" and "console" authentication modes.
 *
 * - "max" mode: Standard OAuth with refresh tokens for Claude Max accounts
 * - "console" mode: OAuth flow that creates a static API key
 *
 * This class does not persist session data. The caller must handle storage
 * between {@link begin} and {@link complete} calls.
 */
export class OAuthFlow {
	constructor(
		private dbOps: DatabaseOperations,
		private config: Config,
	) {}

	/**
	 * Starts an Anthropic OAuth flow.
	 *
	 * The caller MUST persist the returned `sessionId`, `pkce.verifier`,
	 * `mode`, and `tier` so that {@link complete} can validate the callback.
	 *
	 * @param opts - OAuth flow options
	 * @param opts.name - Unique account name
	 * @param opts.mode - Authentication mode ("max" for Claude Max, "console" for API key)
	 * @returns OAuth flow data including auth URL and session info
	 * @throws {Error} If account name already exists
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

		// Create session ID for this OAuth flow
		const sessionId = crypto.randomUUID();

		// NOTE: OAuthFlow itself does not persist the session.
		//       The caller (HTTP-API oauth-init handler) must
		//       store {sessionId, verifier, mode, tier} – typically
		//       via DatabaseOperations.createOAuthSession().

		return {
			sessionId,
			authUrl,
			pkce,
			oauthConfig,
			mode,
		};
	}

	/**
	 * Completes the Anthropic OAuth flow after user authorization.
	 *
	 * Exchanges the authorization code for tokens and creates the account.
	 * For "console" mode, creates an API key instead of storing OAuth tokens.
	 *
	 * @param opts - Completion options
	 * @param opts.sessionId - Session ID from {@link begin}
	 * @param opts.code - Authorization code from OAuth callback
	 * @param opts.tier - Account tier (1, 5, or 20)
	 * @param opts.name - Account name (must match the one from begin)
	 * @param flowData - Flow data returned from {@link begin}
	 * @returns Created account information
	 * @throws {Error} If OAuth provider not found or token exchange fails
	 */
	async complete(
		opts: CompleteOptions,
		flowData: BeginResult,
	): Promise<AccountCreated> {
		const { code, tier = 1, name, priority = 0 } = opts;

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
			return this.createAccountWithApiKey(
				accountId,
				name,
				apiKey,
				tier,
				priority,
			);
		}

		// Handle max mode - standard OAuth flow
		return this.createAccountWithOAuth(accountId, name, tokens, tier, priority);
	}

	/**
	 * Creates an API key using the Anthropic console endpoint.
	 *
	 * This is used for "console" mode accounts where users want a static API key
	 * instead of OAuth tokens that need refreshing.
	 *
	 * @param accessToken - Temporary access token from OAuth flow
	 * @returns The newly created API key
	 * @throws {Error} If API key creation fails
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
	 * Creates an account with OAuth tokens (max mode).
	 *
	 * Stores refresh token, access token, and expiration for automatic token refresh.
	 *
	 * @param id - Unique account ID
	 * @param name - Account name
	 * @param tokens - OAuth tokens from token exchange
	 * @param tier - Account tier (1, 5, or 20)
	 * @returns Created account information
	 */
	private createAccountWithOAuth(
		id: string,
		name: string,
		tokens: OAuthTokens,
		tier: AccountTier,
		priority: number,
	): AccountCreated {
		const db = this.dbOps.getDatabase();

		db.run(
			`
			INSERT INTO accounts (
				id, name, provider, api_key, refresh_token, access_token, expires_at,
				created_at, request_count, total_requests, account_tier, priority
			) VALUES (?, ?, ?, NULL, ?, ?, ?, ?, 0, 0, ?, ?)
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
				priority,
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
	 * Creates an account with API key (console mode).
	 *
	 * Stores only the API key, no OAuth tokens. These accounts don't require
	 * token refresh but cannot be refreshed if the API key is revoked.
	 *
	 * @param id - Unique account ID
	 * @param name - Account name
	 * @param apiKey - API key from Anthropic console
	 * @param tier - Account tier (1, 5, or 20)
	 * @returns Created account information
	 */
	private createAccountWithApiKey(
		id: string,
		name: string,
		apiKey: string,
		tier: AccountTier,
		priority: number,
	): AccountCreated {
		const db = this.dbOps.getDatabase();

		db.run(
			`
			INSERT INTO accounts (
				id, name, provider, api_key, refresh_token, access_token, expires_at,
				created_at, request_count, total_requests, account_tier, priority
			) VALUES (?, ?, ?, ?, NULL, NULL, NULL, ?, 0, 0, ?, ?)
			`,
			[id, name, "anthropic", apiKey, Date.now(), tier, priority],
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
