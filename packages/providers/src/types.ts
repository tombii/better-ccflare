import type { Account } from "@better-ccflare/types";

export interface TokenRefreshResult {
	accessToken: string;
	expiresAt: number;
	refreshToken: string; // Always required - either new token or existing one
}

export interface RateLimitInfo {
	isRateLimited: boolean;
	resetTime?: number;
	statusHeader?: string;
	remaining?: number;
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
	buildUrl(path: string, query: string, account?: Account): string;

	/**
	 * Prepare headers for the provider request
	 * @param headers - Original request headers
	 * @param accessToken - OAuth access token (for Bearer authentication)
	 * @param apiKey - API key (provider-specific header)
	 */
	prepareHeaders(
		headers: Headers,
		accessToken?: string,
		apiKey?: string,
	): Headers;

	/**
	 * Parse rate limit information from response
	 */
	parseRateLimit(response: Response): RateLimitInfo;

	/**
	 * Process the response before returning to client
	 */
	processResponse(
		response: Response,
		account: Account | null,
	): Promise<Response>;

	/**
	 * Transform the request body before sending to the provider
	 */
	transformRequestBody?(request: Request, account?: Account): Promise<Request>;

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

	/**
	 * Check if the response is a streaming response
	 */
	isStreamingResponse?(response: Response): boolean;
}

// OAuth-specific types
export interface OAuthProviderConfig {
	authorizeUrl: string;
	tokenUrl: string;
	clientId: string;
	scopes: string[];
	redirectUri: string;
	mode?: string;
}

export interface OAuthProvider {
	getOAuthConfig(mode?: string, redirectUri?: string): OAuthProviderConfig;
	exchangeCode(
		code: string,
		verifier: string,
		config: OAuthProviderConfig,
	): Promise<TokenResult>;
	generateAuthUrl(config: OAuthProviderConfig, pkce: PKCEChallenge): string;
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
