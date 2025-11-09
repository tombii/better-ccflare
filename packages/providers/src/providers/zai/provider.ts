import { estimateCostUSD } from "@better-ccflare/core";
import { sanitizeProxyHeaders } from "@better-ccflare/http-common";
import { Logger } from "@better-ccflare/logger";
import type { Account } from "@better-ccflare/types";
import { BaseProvider } from "../../base";
import type { RateLimitInfo, TokenRefreshResult } from "../../types";

const log = new Logger("ZaiProvider");

export class ZaiProvider extends BaseProvider {
	name = "zai";

	canHandle(_path: string): boolean {
		// Handle all paths for z.ai endpoints
		return true;
	}

	async refreshToken(
		account: Account,
		_clientId: string,
	): Promise<TokenRefreshResult> {
		// z.ai uses API keys, not OAuth tokens
		// If refresh_token is actually an API key, return it as the access token
		if (!account.refresh_token) {
			throw new Error(`No API key available for account ${account.name}`);
		}

		log.info(`Using API key for z.ai account ${account.name}`);

		// For API key based authentication, we don't have token refresh
		// The "refresh_token" field stores the API key
		return {
			accessToken: account.refresh_token,
			expiresAt: Date.now() + 365 * 24 * 60 * 60 * 1000, // 1 year from now
			refreshToken: account.refresh_token,
		};
	}

	buildUrl(path: string, query: string, account?: Account): string {
		const defaultEndpoint = "https://api.z.ai/api/anthropic";
		const endpoint = account?.custom_endpoint || defaultEndpoint;

		// Validate and sanitize the custom endpoint
		const sanitizedEndpoint = endpoint.trim().replace(/\/$/, ""); // Remove trailing slash

		return `${sanitizedEndpoint}${path}${query}`;
	}

	prepareHeaders(
		headers: Headers,
		accessToken?: string,
		apiKey?: string,
	): Headers {
		const newHeaders = new Headers(headers);

		// SECURITY: Remove client's authorization header when we have provider credentials
		// to prevent credential leakage. If no credentials provided (passthrough mode),
		// preserve client's authorization for direct API access.
		// Use explicit undefined checks to handle empty strings correctly.
		if (accessToken !== undefined || apiKey !== undefined) {
			// Remove authorization header since z.ai uses x-api-key
			newHeaders.delete("authorization");

			// z.ai expects the API key in x-api-key header
			if (accessToken) {
				newHeaders.set("x-api-key", accessToken);
			} else if (apiKey) {
				newHeaders.set("x-api-key", apiKey);
			}
		}

		// Remove host header
		newHeaders.delete("host");

		// Remove compression headers to avoid decompression issues
		newHeaders.delete("accept-encoding");
		newHeaders.delete("content-encoding");

		return newHeaders;
	}

	async parseRateLimitFromBody(
		response: Response,
	): Promise<number | undefined> {
		try {
			const clone = response.clone();
			const body = await clone.json();

			// Check for Zai rate limit error format
			// {
			//   "type": "error",
			//   "error": {
			//     "type": "1308",
			//     "message": "Usage limit reached for 5 hour. Your limit will reset at 2025-10-03 08:23:14"
			//   }
			// }
			if (
				body?.type === "error" &&
				body?.error?.type === "1308" &&
				body?.error?.message
			) {
				const message = body.error.message as string;
				// Extract timestamp from message like "Your limit will reset at 2025-10-03 08:23:14"
				const match = message.match(
					/reset at (\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})/,
				);
				if (match) {
					const resetTimeStr = match[1];
					// Parse as Singapore time (UTC+8) and convert to UTC
					const [datePart, timePart] = resetTimeStr.split(" ");
					const [year, month, day] = datePart.split("-").map(Number);
					const [hour, minute, second] = timePart.split(":").map(Number);

					// Create date in Singapore time (UTC+8)
					// We need to subtract 8 hours to get UTC
					const singaporeDate = new Date(
						Date.UTC(year, month - 1, day, hour, minute, second),
					);
					const utcTime = singaporeDate.getTime() - 8 * 60 * 60 * 1000;

					log.info(
						`Parsed Zai rate limit reset time: ${resetTimeStr} Singapore time -> ${new Date(utcTime).toISOString()} UTC`,
					);

					return utcTime;
				}
			}
		} catch (error) {
			log.debug("Failed to parse rate limit from response body:", error);
		}
		return undefined;
	}

	parseRateLimit(response: Response): RateLimitInfo {
		// Check for standard rate limit headers
		if (response.status !== 429) {
			return { isRateLimited: false };
		}

		// Try to extract reset time from headers first
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

		// If no header-based reset time and this is a 429, we need to parse the body
		// We'll return a promise-based result for async body parsing
		if (!resetTime) {
			// Parse body asynchronously and return the reset time
			// Note: This needs to be handled by the caller since parseRateLimit is sync
			// We'll add a separate async method for body parsing
		}

		return { isRateLimited: true, resetTime };
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

	async extractTierInfo(_response: Response): Promise<number | null> {
		// z.ai doesn't provide tier information in responses
		// We'll rely on the account tier set during account creation
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

			// Handle streaming responses (SSE) - similar to Anthropic
			if (contentType?.includes("text/event-stream")) {
				// For streaming, we'll extract usage from the message_start and message_delta events
				// This is similar to the Anthropic implementation but handles both events
				const reader = clone.body?.getReader();
				if (!reader) return null;

				let buffered = "";
				const maxBytes = 100000; // Larger buffer to capture more of the stream
				const decoder = new TextDecoder();

				// Track usage from both message_start and message_delta
				let messageStartUsage: {
					input_tokens?: number;
					output_tokens?: number;
					cache_creation_input_tokens?: number;
					cache_read_input_tokens?: number;
					model?: string;
				} | null = null;

				let messageDeltaUsage: {
					input_tokens?: number;
					output_tokens?: number;
					cache_read_input_tokens?: number;
				} | null = null;

				try {
					while (buffered.length < maxBytes) {
						const { value, done } = await reader.read();
						if (done) break;

						buffered += decoder.decode(value, { stream: true });

						// Process all complete lines in the buffer
						const lines = buffered.split("\n");
						buffered = lines.pop() || ""; // Keep incomplete line in buffer

						for (let i = 0; i < lines.length; i++) {
							const line = lines[i].trim();
							if (!line) continue;

							// Parse SSE event
							if (line.startsWith("event: message_start")) {
								// Look for the next data line, skipping empty lines
								let dataLine = null;
								for (let j = i + 1; j < lines.length; j++) {
									const nextLine = lines[j].trim();
									if (nextLine.startsWith("data: ")) {
										dataLine = nextLine;
										break;
									} else if (nextLine && !nextLine.startsWith("event: ")) {
										// If we encounter a non-empty line that's not an event, break
										break;
									}
								}

								if (dataLine) {
									try {
										const jsonStr = dataLine.slice(6);
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
											messageStartUsage = {
												input_tokens: data.message.usage.input_tokens,
												output_tokens: data.message.usage.output_tokens,
												cache_creation_input_tokens:
													data.message.usage.cache_creation_input_tokens,
												cache_read_input_tokens:
													data.message.usage.cache_read_input_tokens,
												model: data.message.model,
											};
										}
									} catch {
										// Ignore parse errors
									}
								}
							} else if (line.startsWith("event: message_delta")) {
								// Look for the next data line, skipping empty lines
								let dataLine = null;
								for (let j = i + 1; j < lines.length; j++) {
									const nextLine = lines[j].trim();
									if (nextLine.startsWith("data: ")) {
										dataLine = nextLine;
										break;
									} else if (nextLine && !nextLine.startsWith("event: ")) {
										// If we encounter a non-empty line that's not an event, break
										break;
									}
								}

								if (dataLine) {
									try {
										const jsonStr = dataLine.slice(6);
										const data = JSON.parse(jsonStr) as {
											usage?: {
												input_tokens?: number;
												output_tokens?: number;
												cache_read_input_tokens?: number;
											};
										};

										if (data.usage) {
											messageDeltaUsage = {
												input_tokens: data.usage.input_tokens,
												output_tokens: data.usage.output_tokens,
												cache_read_input_tokens:
													data.usage.cache_read_input_tokens,
											};
										}
									} catch {
										// Ignore parse errors
									}
								}
							}
						}

						// If we have both message_start and message_delta, we can return the complete usage
						if (messageDeltaUsage) {
							break; // We have the final usage from message_delta
						}
					}
				} finally {
					reader.cancel().catch(() => {});
				}

				// For ZAI streaming responses, message_delta always contains the final authoritative token counts
				// We should always prefer message_delta when available, regardless of whether tokens are zero
				const finalUsage = messageDeltaUsage || messageStartUsage;

				if (finalUsage) {
					// Use the model from message_start (z.ai returns GLM model names directly)
					const model = messageStartUsage?.model;

					// For message_delta, input_tokens and cache_read_input_tokens may be the final counts
					// For message_start, we have all the detailed breakdown
					const inputTokens =
						finalUsage.input_tokens || messageStartUsage?.input_tokens || 0;
					const cacheReadInputTokens =
						finalUsage.cache_read_input_tokens ||
						messageStartUsage?.cache_read_input_tokens ||
						0;
					const cacheCreationInputTokens =
						messageStartUsage?.cache_creation_input_tokens || 0;
					const outputTokens =
						finalUsage.output_tokens || messageStartUsage?.output_tokens || 0;

					const promptTokens =
						(inputTokens || 0) +
						cacheReadInputTokens +
						cacheCreationInputTokens;
					const completionTokens = outputTokens;
					const totalTokens = promptTokens + completionTokens;

					// Calculate cost if we have a model
					let costUsd: number | undefined;
					if (model) {
						try {
							costUsd = await estimateCostUSD(model, {
								inputTokens,
								outputTokens,
								cacheReadInputTokens,
								cacheCreationInputTokens,
							});
						} catch (error) {
							log.warn(`Failed to calculate cost for model ${model}:`, error);
						}
					}

					return {
						model,
						promptTokens,
						completionTokens,
						totalTokens,
						inputTokens,
						cacheReadInputTokens,
						cacheCreationInputTokens,
						outputTokens,
						costUsd,
					};
				}

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

				// Calculate cost if we have a model (z.ai returns GLM model names directly)
				const model = json.model;
				let costUsd: number | undefined;
				if (model) {
					try {
						costUsd = await estimateCostUSD(model, {
							inputTokens,
							outputTokens,
							cacheReadInputTokens,
							cacheCreationInputTokens,
						});
					} catch (error) {
						log.warn(`Failed to calculate cost for model ${model}:`, error);
					}
				}

				return {
					model,
					promptTokens,
					completionTokens,
					totalTokens,
					inputTokens,
					cacheReadInputTokens,
					cacheCreationInputTokens,
					outputTokens,
					costUsd,
				};
			}
		} catch {
			return null;
		}
	}

	/**
	 * Check if a response is a streaming response
	 */
	isStreamingResponse(response: Response): boolean {
		const contentType = response.headers.get("content-type");
		return contentType?.includes("text/event-stream") || false;
	}

	/**
	 * z.ai doesn't support OAuth - uses API keys instead
	 */
	supportsOAuth(): boolean {
		return false;
	}
}
