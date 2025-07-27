import type { Account } from "@claudeflare/core";

export interface ProxyRequest {
	method: string;
	path: string;
	headers: Headers;
	body: ArrayBuffer | null;
	query: string;
}

export interface ProxyResponse {
	status: number;
	statusText: string;
	headers: Headers;
	body: ReadableStream<Uint8Array> | string | null;
}

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
}
