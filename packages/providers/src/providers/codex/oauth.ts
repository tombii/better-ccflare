import { OAuthError } from "@better-ccflare/core";
import { Logger } from "@better-ccflare/logger";
import type {
	OAuthProvider,
	OAuthProviderConfig,
	PKCEChallenge,
	TokenResult,
} from "../../types";

const oauthLog = new Logger("CodexOAuthProvider");

const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const AUTHORIZE_URL = "https://auth.openai.com/oauth/authorize";
const TOKEN_URL = "https://auth.openai.com/oauth/token";
const REDIRECT_URI = "http://localhost:1455/auth/callback";
const SCOPES = [
	"openid",
	"profile",
	"email",
	"offline_access",
	"api.connectors.read",
	"api.connectors.invoke",
];

export class CodexOAuthProvider implements OAuthProvider {
	getOAuthConfig(): OAuthProviderConfig {
		return {
			authorizeUrl: AUTHORIZE_URL,
			tokenUrl: TOKEN_URL,
			clientId: CLIENT_ID,
			scopes: SCOPES,
			redirectUri: REDIRECT_URI,
		};
	}

	generateAuthUrl(config: OAuthProviderConfig, pkce: PKCEChallenge): string {
		// Use manual string building with encodeURIComponent (not URLSearchParams
		// which uses + for spaces instead of %20)
		const state = this.generateSecureRandomState();

		const params = [
			`client_id=${encodeURIComponent(config.clientId)}`,
			`response_type=code`,
			`redirect_uri=${encodeURIComponent(config.redirectUri)}`,
			`scope=${encodeURIComponent(config.scopes.join(" "))}`,
			`code_challenge=${encodeURIComponent(pkce.challenge)}`,
			`code_challenge_method=S256`,
			`state=${encodeURIComponent(state)}`,
			`id_token_add_organizations=true`,
			`codex_cli_simplified_flow=true`,
			`originator=codex_cli_rs`,
		].join("&");

		return `${config.authorizeUrl}?${params}`;
	}

	async exchangeCode(
		code: string,
		verifier: string,
		config: OAuthProviderConfig,
	): Promise<TokenResult> {
		oauthLog.debug("Exchanging authorization code for tokens");

		const body = new URLSearchParams({
			grant_type: "authorization_code",
			code,
			redirect_uri: config.redirectUri,
			client_id: config.clientId,
			code_verifier: verifier,
		});

		const response = await fetch(config.tokenUrl, {
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body: body.toString(),
		});

		oauthLog.debug(
			`Token exchange response: ${response.status} ${response.statusText}`,
		);

		if (!response.ok) {
			let errorDetails: {
				error?: string;
				error_description?: string;
			} | null = null;
			try {
				errorDetails = await response.json();
			} catch {
				// ignore parse failure
			}

			const errorMessage =
				errorDetails?.error_description ||
				errorDetails?.error ||
				response.statusText ||
				"OAuth token exchange failed";

			throw new OAuthError(errorMessage, "codex", errorDetails?.error);
		}

		const json = (await response.json()) as {
			refresh_token: string;
			access_token: string;
			expires_in: number;
			id_token?: string;
		};

		return {
			refreshToken: json.refresh_token,
			accessToken: json.access_token,
			expiresAt: Date.now() + json.expires_in * 1000,
		};
	}

	private generateSecureRandomState(): string {
		const array = new Uint8Array(32);
		crypto.getRandomValues(array);
		return Array.from(array, (byte) => byte.toString(16).padStart(2, "0")).join(
			"",
		);
	}
}
