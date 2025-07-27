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

	prepareHeaders(headers: Headers, accessToken?: string): Headers {
		const newHeaders = super.prepareHeaders(headers, accessToken);
		// Remove compression headers to avoid decompression issues
		newHeaders.delete("accept-encoding");
		newHeaders.delete("content-encoding");
		return newHeaders;
	}

	parseRateLimit(response: Response): RateLimitInfo {
		// Check for unified rate limit headers
		const statusHeader = response.headers.get(
			"anthropic-ratelimit-unified-status",
		);
		const resetHeader = response.headers.get(
			"anthropic-ratelimit-unified-reset",
		);
		const remainingHeader = response.headers.get(
			"anthropic-ratelimit-unified-remaining",
		);

		if (statusHeader || resetHeader) {
			const resetTime = resetHeader ? Number(resetHeader) * 1000 : undefined; // Convert to ms
			const remaining = remainingHeader ? Number(remainingHeader) : undefined;

			return {
				isRateLimited: statusHeader !== "allowed",
				resetTime,
				statusHeader: statusHeader || undefined,
				remaining,
			};
		}

		// Fall back to 429 status with x-ratelimit-reset header
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
		_account: Account | null,
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

	async extractUsageInfo(response: Response): Promise<{
		model?: string;
		promptTokens?: number;
		completionTokens?: number;
		totalTokens?: number;
		costUsd?: number;
		inputTokens?: number;
		cacheReadInputTokens?: number;
		cacheCreationInputTokens?: number;
		outputTokens?: number;
	} | null> {
		try {
			const clone = response.clone();
			const contentType = response.headers.get("content-type");

			// Handle streaming responses (SSE)
			if (contentType?.includes("text/event-stream")) {
				const text = await clone.text();
				const lines = text.split("\n");

				// Parse SSE events
				for (let i = 0; i < lines.length; i++) {
					const line = lines[i];
					if (line.startsWith("event: message_start")) {
						// Next line should be the data
						const dataLine = lines[i + 1];
						if (dataLine?.startsWith("data: ")) {
							const jsonStr = dataLine.slice(6); // Remove "data: " prefix
							const data = JSON.parse(jsonStr) as {
								message?: {
									model?: string;
									usage?: {
										input_tokens?: number;
										output_tokens?: number;
										cache_creation_input_tokens?: number;
										cache_read_input_tokens?: number;
									};
								};
							};

							if (data.message?.usage) {
								const usage = data.message.usage;
								const inputTokens = usage.input_tokens || 0;
								const cacheCreationInputTokens =
									usage.cache_creation_input_tokens || 0;
								const cacheReadInputTokens = usage.cache_read_input_tokens || 0;
								const outputTokens = usage.output_tokens || 0;
								const promptTokens =
									inputTokens + cacheCreationInputTokens + cacheReadInputTokens;
								const completionTokens = outputTokens;
								const totalTokens = promptTokens + completionTokens;

								// Extract cost from header if available
								const costHeader = response.headers.get(
									"anthropic-billing-cost",
								);
								const costUsd = costHeader ? parseFloat(costHeader) : undefined;

								return {
									model: data.message.model,
									promptTokens,
									completionTokens,
									totalTokens,
									costUsd,
									inputTokens,
									cacheReadInputTokens,
									cacheCreationInputTokens,
									outputTokens,
								};
							}
						}
					}
				}

				// Also check for message_delta events to accumulate final usage
				const accumulatedUsage = {
					output_tokens: 0,
				};
				let model: string | undefined;

				for (const line of lines) {
					if (line.startsWith("data: ")) {
						const jsonStr = line.slice(6);
						try {
							const data = JSON.parse(jsonStr);
							if (data.type === "message_delta" && data.usage?.output_tokens) {
								accumulatedUsage.output_tokens = data.usage.output_tokens;
							}
							if (data.type === "message_start" && data.message?.model) {
								model = data.message.model;
							}
						} catch {
							// Ignore parse errors for individual lines
						}
					}
				}

				// If we found usage in delta events, return that
				if (accumulatedUsage.output_tokens > 0) {
					const costHeader = response.headers.get("anthropic-billing-cost");
					const costUsd = costHeader ? parseFloat(costHeader) : undefined;

					return {
						model,
						promptTokens: 0, // We don't have prompt tokens in delta
						completionTokens: accumulatedUsage.output_tokens,
						totalTokens: accumulatedUsage.output_tokens,
						costUsd,
						inputTokens: 0,
						cacheReadInputTokens: 0,
						cacheCreationInputTokens: 0,
						outputTokens: accumulatedUsage.output_tokens,
					};
				}

				// No usage data found in streaming response
				return null;
			} else {
				// Handle non-streaming JSON responses
				const json = (await clone.json()) as {
					model?: string;
					usage?: {
						input_tokens?: number;
						output_tokens?: number;
						cache_creation_input_tokens?: number;
						cache_read_input_tokens?: number;
					};
				};

				if (!json.usage) return null;

				const inputTokens = json.usage.input_tokens || 0;
				const cacheCreationInputTokens =
					json.usage.cache_creation_input_tokens || 0;
				const cacheReadInputTokens = json.usage.cache_read_input_tokens || 0;
				const outputTokens = json.usage.output_tokens || 0;
				const promptTokens =
					inputTokens + cacheCreationInputTokens + cacheReadInputTokens;
				const completionTokens = outputTokens;
				const totalTokens = promptTokens + completionTokens;

				// Extract cost from header if available
				const costHeader = response.headers.get("anthropic-billing-cost");
				const costUsd = costHeader ? parseFloat(costHeader) : undefined;

				return {
					model: json.model,
					promptTokens,
					completionTokens,
					totalTokens,
					costUsd,
					inputTokens,
					cacheReadInputTokens,
					cacheCreationInputTokens,
					outputTokens,
				};
			}
		} catch {
			// Ignore parsing errors
			return null;
		}
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
