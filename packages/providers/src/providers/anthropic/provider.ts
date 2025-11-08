import { BUFFER_SIZES, validateEndpointUrl } from "@better-ccflare/core";
import { sanitizeProxyHeaders } from "@better-ccflare/http-common";
import { Logger } from "@better-ccflare/logger";
import type { Account } from "@better-ccflare/types";
import { BaseProvider } from "../../base";
import type { RateLimitInfo, TokenRefreshResult } from "../../types";

// Hard rate limit statuses that should block account usage
const HARD_LIMIT_STATUSES = new Set([
	"rate_limited",
	"blocked",
	"queueing_hard",
	"payment_required",
]);

// Soft warning statuses that should not block account usage
const _SOFT_WARNING_STATUSES = new Set(["allowed_warning", "queueing_soft"]);

const log = new Logger("AnthropicProvider");

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
		// Debug: Log account classification
		log.debug(`Account classification for ${account.name}:`, {
			hasApiKey: !!account.api_key,
			hasAccessToken: !!account.access_token,
			hasRefreshToken: !!account.refresh_token,
			provider: account.provider,
		});

		// Determine account type based on token presence (same logic as re-authentication)
		const isConsoleMode = !!account.api_key;
		const accountType = isConsoleMode ? "Console (API key)" : "CLI (OAuth)";
		log.debug(`Account type: ${accountType}`);

		if (isConsoleMode) {
			// For console API key accounts, return the API key directly
			if (!account.api_key) {
				throw new Error(
					`No API key available for console account ${account.name}`,
				);
			}

			log.info(`Using API key for console account ${account.name}`);

			return {
				accessToken: account.api_key,
				expiresAt: Date.now() + 24 * 60 * 60 * 1000, // API keys don't expire, but set a reasonable time
				refreshToken: "", // Empty string prevents DB update for console mode
			};
		}

		// For OAuth accounts (claude-oauth), use the OAuth refresh flow
		if (!account.refresh_token) {
			throw new Error(`No refresh token available for account ${account.name}`);
		}

		log.info(
			`Refreshing OAuth token for account ${account.name} with client ID: ${clientId}`,
		);

		// Debug: Log the refresh attempt details
		log.debug(`Token refresh attempt for ${account.name}:`, {
			refreshTokenPreview: account.refresh_token
				? `${account.refresh_token.substring(0, 30)}...`
				: "null/undefined",
			clientId,
			refreshTokenLength: account.refresh_token?.length || 0,
		});

		const requestBody = {
			grant_type: "refresh_token",
			refresh_token: account.refresh_token,
			client_id: clientId,
		};

		log.debug("Request body:", requestBody);

		const response = await fetch(
			"https://console.anthropic.com/v1/oauth/token",
			{
				method: "POST",
				headers: {
					"Content-Type": "application/json",
				},
				body: JSON.stringify(requestBody),
			},
		);

		log.debug(`Response status: ${response.status} ${response.statusText}`, {
			headers: Object.fromEntries(response.headers.entries()),
		});

		if (!response.ok) {
			let errorMessage = response.statusText;
			let errorData: unknown = null;
			try {
				const responseText = await response.text();
				log.debug("Error response body:", responseText);
				errorData = JSON.parse(responseText);
				const errorObj = errorData as {
					error?: string;
					error_description?: string;
					message?: string;
				};
				errorMessage =
					errorObj.error_description ||
					errorObj.error ||
					errorObj.message ||
					errorMessage;

				// Log specific OAuth authentication errors
				if (response.status === 401 && typeof errorMessage === "string") {
					if (
						errorMessage.includes(
							"OAuth authentication is currently not supported",
						)
					) {
						log.error(
							`OAuth authentication not supported for ${account.name} - the refresh token may be revoked or invalid. Account may need re-authentication.`,
						);
					} else if (
						errorMessage.includes("invalid_grant") ||
						errorMessage.includes("invalid_refresh_token")
					) {
						log.error(
							`Refresh token invalid or expired for ${account.name} - account needs re-authentication`,
						);
					}
				}
			} catch {
				// If we can't parse the error response, use the status text
				log.error(
					`Failed to parse token refresh error response for ${account.name}: ${response.statusText}`,
				);
			}
			log.error(
				`Token refresh failed for ${account.name}: Status ${response.status}, Error: ${errorMessage}`,
				errorData,
			);
			throw new Error(
				`Failed to refresh token for account ${account.name}: ${errorMessage}`,
			);
		}

		const json = (await response.json()) as {
			access_token: string;
			expires_in: number;
			refresh_token?: string;
		};

		// Ensure we always return a refresh token
		const refreshToken = json.refresh_token || account.refresh_token;

		if (!json.refresh_token) {
			log.warn(
				`Anthropic refresh endpoint did not return a refresh_token for ${account.name} - continuing with previous one`,
			);
		} else {
			log.info(
				`Token refresh successful for ${account.name}, new refresh token provided`,
			);
		}

		return {
			accessToken: json.access_token,
			expiresAt: Date.now() + json.expires_in * 1000,
			refreshToken: refreshToken,
		};
	}

	buildUrl(path: string, query: string, account?: Account): string {
		const defaultEndpoint = "https://api.anthropic.com";

		if (account?.custom_endpoint) {
			try {
				// Validate and sanitize the custom endpoint
				const validatedEndpoint = validateEndpointUrl(
					account.custom_endpoint,
					"custom_endpoint",
				);
				return `${validatedEndpoint}${path}${query}`;
			} catch (error) {
				log.warn(
					`Invalid custom endpoint for account ${account.name}: ${account.custom_endpoint}. Using default.`,
					error,
				);
				return `${defaultEndpoint}${path}${query}`;
			}
		}

		return `${defaultEndpoint}${path}${query}`;
	}

	prepareHeaders(
		headers: Headers,
		accessToken?: string,
		apiKey?: string,
	): Headers {
		const newHeaders = new Headers(headers);

		// Remove original authorization header to prevent credential leaks
		// The system will add its own authentication (OAuth token or API key) for Anthropic
		newHeaders.delete("authorization");

		// Set authentication header
		if (accessToken) {
			newHeaders.set("Authorization", `Bearer ${accessToken}`);
		} else if (apiKey) {
			newHeaders.set("x-api-key", apiKey);
		}

		// Remove host header
		newHeaders.delete("host");

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

			// Only mark as rate limited for hard limit statuses or 429
			const isRateLimited =
				HARD_LIMIT_STATUSES.has(statusHeader || "") || response.status === 429;

			return {
				isRateLimited,
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
		// Sanitize headers by removing hop-by-hop headers
		const headers = sanitizeProxyHeaders(response.headers);

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
				// Use bounded reader to avoid consuming entire stream
				const reader = clone.body?.getReader();
				if (!reader) return null;

				let buffered = "";
				const maxBytes = BUFFER_SIZES.ANTHROPIC_STREAM_CAP_BYTES;
				const decoder = new TextDecoder();
				let foundMessageStart = false;
				const READ_TIMEOUT_MS = 10000; // 10 second timeout for stream reads
				const startTime = Date.now();

				try {
					while (buffered.length < maxBytes) {
						// Check for timeout
						if (Date.now() - startTime > READ_TIMEOUT_MS) {
							await reader.cancel();
							throw new Error(
								"Stream read timeout while extracting usage info",
							);
						}

						// Read with timeout
						const readPromise = reader.read();
						const timeoutPromise = new Promise<{
							value?: Uint8Array;
							done: boolean;
						}>((_, reject) =>
							setTimeout(
								() => reject(new Error("Read operation timeout")),
								5000,
							),
						);

						const { value, done } = await Promise.race([
							readPromise,
							timeoutPromise,
						]);

						if (done) break;

						buffered += decoder.decode(value, { stream: true });

						// Check if we have the message_start event
						if (buffered.includes("event: message_start")) {
							foundMessageStart = true;
							// Read a bit more to ensure we get the data line
							const nextReadPromise = reader.read();
							const nextTimeoutPromise = new Promise<{
								value?: Uint8Array;
								done: boolean;
							}>((_, reject) =>
								setTimeout(
									() => reject(new Error("Read operation timeout")),
									5000,
								),
							);

							const { value: nextValue, done: nextDone } = await Promise.race([
								nextReadPromise,
								nextTimeoutPromise,
							]);

							if (!nextDone && nextValue) {
								buffered += decoder.decode(nextValue, { stream: true });
							}
							break;
						}
					}
				} finally {
					// Cancel the reader to prevent hanging
					reader.cancel().catch(() => {});
				}

				if (!foundMessageStart) return null;

				// Parse the buffered content
				const lines = buffered.split("\n");

				// Parse SSE events
				for (let i = 0; i < lines.length; i++) {
					const line = lines[i];
					if (line.startsWith("event: message_start")) {
						// Next line should be the data
						const dataLine = lines[i + 1];
						if (dataLine?.startsWith("data: ")) {
							try {
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
									const cacheReadInputTokens =
										usage.cache_read_input_tokens || 0;
									const outputTokens = usage.output_tokens || 0;
									const promptTokens =
										inputTokens +
										cacheCreationInputTokens +
										cacheReadInputTokens;
									const completionTokens = outputTokens;
									const totalTokens = promptTokens + completionTokens;

									// Extract cost from header if available
									const costHeader = response.headers.get(
										"anthropic-billing-cost",
									);
									const costUsd = costHeader
										? parseFloat(costHeader)
										: undefined;

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
							} catch {
								// Ignore parse errors
							}
						}
					}
				}

				// For streaming responses, we only extract initial usage
				// Output tokens will be accumulated during streaming but we can't capture that here
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
