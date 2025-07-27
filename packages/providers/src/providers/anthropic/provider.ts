import type { Account } from "@claudeflare/core";
import { BaseProvider } from "../../base";
import type { RateLimitInfo, TokenRefreshResult } from "../../types";

export class AnthropicProvider extends BaseProvider {
	name = "anthropic";

	canHandle(_path: string): boolean {
		// Handle all paths for now since this is Anthropic-specific
		return true;
	}

	async refreshToken(
		account: Account,
		clientId: string,
	): Promise<TokenRefreshResult> {
		const response = await fetch(
			"https://console.anthropic.com/v1/oauth/token",
			{
				method: "POST",
				headers: {
					"Content-Type": "application/json",
				},
				body: JSON.stringify({
					grant_type: "refresh_token",
					refresh_token: account.refresh_token,
					client_id: clientId,
				}),
			},
		);

		if (!response.ok) {
			throw new Error(
				`Failed to refresh token for account ${account.name}: ${response.statusText}`,
			);
		}

		const json = (await response.json()) as {
			access_token: string;
			expires_in: number;
		};

		return {
			accessToken: json.access_token,
			expiresAt: Date.now() + json.expires_in * 1000,
		};
	}

	buildUrl(path: string, query: string): string {
		return `https://api.anthropic.com${path}${query}`;
	}

	prepareHeaders(headers: Headers, accessToken: string): Headers {
		const newHeaders = super.prepareHeaders(headers, accessToken);
		// Remove compression headers to avoid decompression issues
		newHeaders.delete("accept-encoding");
		newHeaders.delete("content-encoding");
		return newHeaders;
	}

	checkRateLimit(response: Response): RateLimitInfo {
		if (response.status !== 429) {
			return { isRateLimited: false };
		}

		const rateLimitReset = response.headers.get("x-ratelimit-reset");
		const resetTime = rateLimitReset
			? parseInt(rateLimitReset) * 1000
			: Date.now() + 60000; // Default to 1 minute

		return {
			isRateLimited: true,
			resetTime,
		};
	}

	async processResponse(
		response: Response,
		_account: Account,
	): Promise<Response> {
		// Strip Content-Encoding header to avoid decompression issues
		const headers = new Headers(response.headers);
		headers.delete("content-encoding");
		headers.delete("Content-Encoding");

		return new Response(response.body, {
			status: response.status,
			statusText: response.statusText,
			headers,
		});
	}

	async extractTierInfo(response: Response): Promise<number | null> {
		try {
			const clone = response.clone();
			const json = (await clone.json()) as {
				type?: string;
				usage?: {
					rate_limit_tokens?: number;
				};
			};

			// Check for tier information in response
			if (json.type === "message" && json.usage?.rate_limit_tokens) {
				const rateLimit = json.usage.rate_limit_tokens;
				if (rateLimit >= 800000) return 20;
				if (rateLimit >= 200000) return 5;
				return 1;
			}
		} catch {
			// Ignore JSON parsing errors
		}

		return null;
	}

	/**
	 * Check if this provider supports OAuth
	 */
	supportsOAuth(): boolean {
		return true;
	}

	/**
	 * Get the OAuth provider for this provider
	 */
	getOAuthProvider() {
		// Lazy load to avoid circular dependencies
		const { AnthropicOAuthProvider } = require("./oauth.js");
		return new AnthropicOAuthProvider();
	}
}
