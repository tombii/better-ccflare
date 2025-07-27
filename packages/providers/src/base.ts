import type { Account } from "@claudeflare/core";
import type { Provider, RateLimitInfo, TokenRefreshResult } from "./types.js";

export abstract class BaseProvider implements Provider {
	abstract name: string;

	/**
	 * Check if this provider can handle the given request path
	 * Default implementation: handle all paths
	 */
	canHandle(_path: string): boolean {
		return true;
	}

	/**
	 * Refresh the access token for an account
	 * Must be implemented by each provider
	 */
	abstract refreshToken(
		account: Account,
		clientId: string,
	): Promise<TokenRefreshResult>;

	/**
	 * Build the target URL for the provider
	 * Must be implemented by each provider
	 */
	abstract buildUrl(path: string, query: string): string;

	/**
	 * Prepare headers for the provider request
	 * Default implementation: Add Bearer token and remove host header
	 */
	prepareHeaders(headers: Headers, accessToken: string): Headers {
		const newHeaders = new Headers(headers);
		newHeaders.set("Authorization", `Bearer ${accessToken}`);
		newHeaders.delete("host");
		return newHeaders;
	}

	/**
	 * Check if response indicates rate limiting
	 * Default implementation: Check for 429 status
	 */
	checkRateLimit(response: Response): RateLimitInfo {
		if (response.status !== 429) {
			return { isRateLimited: false };
		}

		// Try to extract reset time from headers
		const retryAfter = response.headers.get("retry-after");
		let resetTime: number | undefined;

		if (retryAfter) {
			// Retry-After can be seconds or HTTP date
			const seconds = Number(retryAfter);
			if (!Number.isNaN(seconds)) {
				resetTime = Date.now() + seconds * 1000;
			} else {
				resetTime = new Date(retryAfter).getTime();
			}
		}

		return { isRateLimited: true, resetTime };
	}

	/**
	 * Process the response before returning to client
	 * Default implementation: Return response as-is
	 */
	async processResponse(
		response: Response,
		_account: Account,
	): Promise<Response> {
		return response;
	}

	/**
	 * Extract tier information from response if available
	 * Default implementation: Return null (no tier info)
	 */
	async extractTierInfo?(_response: Response): Promise<number | null> {
		return null;
	}
}
