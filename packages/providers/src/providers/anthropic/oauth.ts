import { OAuthError } from "@better-ccflare/core";
import { Logger } from "@better-ccflare/logger";
import type {
	OAuthProvider,
	OAuthProviderConfig,
	PKCEChallenge,
	TokenResult,
} from "../../types";

const oauthLog = new Logger("AnthropicOAuthProvider");

export class AnthropicOAuthProvider implements OAuthProvider {
	/**
	 * Generate a secure random state string for CSRF protection
	 * This is separate from the PKCE verifier and should never contain secrets
	 */
	private generateSecureRandomState(): string {
		const array = new Uint8Array(32);
		crypto.getRandomValues(array);
		return Array.from(array, (byte) => byte.toString(16).padStart(2, "0")).join(
			"",
		);
	}

	getOAuthConfig(
		mode: "console" | "claude-oauth" = "console",
	): OAuthProviderConfig {
		const baseUrl =
			mode === "console"
				? "https://console.anthropic.com"
				: "https://claude.ai";

		return {
			authorizeUrl: `${baseUrl}/oauth/authorize`,
			tokenUrl: "https://console.anthropic.com/v1/oauth/token",
			clientId: "", // Will be passed from config
			scopes: ["org:create_api_key", "user:profile", "user:inference"],
			redirectUri: "https://console.anthropic.com/oauth/code/callback",
			mode,
		};
	}

	generateAuthUrl(config: OAuthProviderConfig, pkce: PKCEChallenge): string {
		// Generate secure random state for CSRF protection (separate from PKCE verifier)
		const state = this.generateSecureRandomState();

		// For claude-oauth mode (Claude CLI), use the login flow that redirects to OAuth
		if (config.mode === "claude-oauth") {
			const baseUrl = config.authorizeUrl.split("/oauth/authorize")[0];
			const oauthParams = new URLSearchParams();
			oauthParams.set("code", "true");
			oauthParams.set("client_id", config.clientId);
			oauthParams.set("response_type", "code");
			oauthParams.set("redirect_uri", config.redirectUri);
			oauthParams.set("scope", config.scopes.join(" "));
			oauthParams.set("code_challenge", pkce.challenge);
			oauthParams.set("code_challenge_method", "S256");
			oauthParams.set("state", state);

			const returnTo = `/oauth/authorize?${oauthParams.toString()}`;

			const loginUrl = new URL(`${baseUrl}/login`);
			loginUrl.searchParams.set("selectAccount", "true");
			loginUrl.searchParams.set("returnTo", returnTo);

			return loginUrl.toString();
		} else {
			// For console mode, use direct OAuth flow
			const url = new URL(config.authorizeUrl);
			url.searchParams.set("code", "true");
			url.searchParams.set("client_id", config.clientId);
			url.searchParams.set("response_type", "code");
			url.searchParams.set("redirect_uri", config.redirectUri);
			url.searchParams.set("scope", config.scopes.join(" "));
			url.searchParams.set("code_challenge", pkce.challenge);
			url.searchParams.set("code_challenge_method", "S256");
			url.searchParams.set("state", state);
			return url.toString();
		}
	}

	async exchangeCode(
		code: string,
		verifier: string,
		config: OAuthProviderConfig,
	): Promise<TokenResult> {
		// The authorization code from Anthropic contains a state parameter: code#state
		const splits = code.split("#");
		const actualCode = splits[0];
		const state = splits[1];

		oauthLog.debug(`OAuth exchangeCode called:`, {
			hasState: !!state,
			clientId: config.clientId,
			mode: config.mode,
		});

		const requestBody = {
			code: actualCode,
			state: state,
			grant_type: "authorization_code",
			client_id: config.clientId,
			redirect_uri: config.redirectUri,
			code_verifier: verifier,
		};

		// Don't log sensitive request body in production
		if (process.env.NODE_ENV === "development") {
			oauthLog.debug("Exchange request body:", {
				grant_type: requestBody.grant_type,
				client_id: requestBody.client_id,
				redirect_uri: requestBody.redirect_uri,
				// Omit code and code_verifier from logs
			});
		}

		const response = await fetch(config.tokenUrl, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(requestBody),
		});

		oauthLog.debug(
			`Exchange response status: ${response.status} ${response.statusText}`,
		);

		if (!response.ok) {
			let errorDetails: {
				error?: string | { message?: string };
				error_description?: string;
			} | null = null;
			try {
				errorDetails = await response.json();
			} catch {
				// Failed to parse error response
			}

			// Handle error being either a string or an object with a message
			let errorStr: string;
			if (typeof errorDetails?.error === "object" && errorDetails.error) {
				errorStr =
					errorDetails.error.message ||
					JSON.stringify(errorDetails.error) ||
					"Unknown error";
			} else {
				errorStr = errorDetails?.error || "";
			}

			const errorMessage =
				errorDetails?.error_description ||
				errorStr ||
				response.statusText ||
				"OAuth token exchange failed";

			throw new OAuthError(
				errorMessage,
				"anthropic",
				typeof errorDetails?.error === "string"
					? errorDetails.error
					: undefined,
			);
		}

		const json = (await response.json()) as {
			refresh_token: string;
			access_token: string;
			expires_in: number;
		};

		return {
			refreshToken: json.refresh_token,
			accessToken: json.access_token,
			expiresAt: Date.now() + json.expires_in * 1000,
		};
	}
}
