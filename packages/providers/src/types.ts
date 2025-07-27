import type { Account } from "@claudeflare/core";

export interface TokenRefreshResult {
	accessToken: string;
	expiresAt: number;
}

export interface RateLimitInfo {
	isRateLimited: boolean;
	resetTime?: number;
}

export interface Provider {
	name: string;

	/**
	 * Check if this provider can handle the given request path
	 */
	canHandle(path: string): boolean;

	/**
	 * Refresh the access token for an account
	 */
	refreshToken(account: Account, clientId: string): Promise<TokenRefreshResult>;

	/**
	 * Build the target URL for the provider
	 */
	buildUrl(path: string, query: string): string;

	/**
	 * Prepare headers for the provider request
	 */
	prepareHeaders(headers: Headers, accessToken: string): Headers;

	/**
	 * Check if response indicates rate limiting
	 */
	checkRateLimit(response: Response): RateLimitInfo;

	/**
	 * Process the response before returning to client
	 */
	processResponse(response: Response, account: Account): Promise<Response>;

	/**
	 * Extract tier information from response if available
	 */
	extractTierInfo?(response: Response): Promise<number | null>;

	/**
	 * Extract usage information from response if available
	 */
	extractUsageInfo?(response: Response): Promise<{
		model?: string;
		promptTokens?: number;
		completionTokens?: number;
		totalTokens?: number;
		costUsd?: number;
		inputTokens?: number;
		cacheReadInputTokens?: number;
		cacheCreationInputTokens?: number;
		outputTokens?: number;
	} | null>;
}

// OAuth-specific types
export interface OAuthConfig {
	authorizeUrl: string;
	tokenUrl: string;
	clientId: string;
	scopes: string[];
	redirectUri: string;
	mode?: string;
}

export interface OAuthProvider {
	getOAuthConfig(mode?: string): OAuthConfig;
	exchangeCode(
		code: string,
		verifier: string,
		config: OAuthConfig,
	): Promise<TokenResult>;
	generateAuthUrl(config: OAuthConfig, pkce: PKCEChallenge): string;
}

export interface PKCEChallenge {
	verifier: string;
	challenge: string;
}

export interface TokenResult {
	refreshToken: string;
	accessToken: string;
	expiresAt: number;
}
