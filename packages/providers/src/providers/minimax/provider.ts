import {
	BUFFER_SIZES,
	estimateCostUSD,
	TIME_CONSTANTS,
} from "@better-ccflare/core";
import { sanitizeProxyHeaders } from "@better-ccflare/http-common";
import { Logger } from "@better-ccflare/logger";
import type { Account } from "@better-ccflare/types";
import { BaseProvider } from "../../base";
import type { RateLimitInfo, TokenRefreshResult } from "../../types";

const log = new Logger("MinimaxProvider");

export class MinimaxProvider extends BaseProvider {
	name = "minimax";

	canHandle(_path: string): boolean {
		// Handle all paths for minimax endpoints
		return true;
	}

	async refreshToken(
		account: Account,
		_clientId: string,
	): Promise<TokenRefreshResult> {
		// Minimax uses API keys, not OAuth tokens
		// If refresh_token is actually an API key, return it as the access token
		if (!account.refresh_token) {
			throw new Error(`No API key available for account ${account.name}`);
		}

		log.info(`Using API key for minimax account ${account.name}`);

		// For API key based authentication, we don't have token refresh
		// The "refresh_token" field stores the API key
		// TODO: When we switch to using api_key field, consider if API keys should expire
		return {
			accessToken: account.refresh_token,
			expiresAt: Date.now() + TIME_CONSTANTS.API_KEY_TOKEN_EXPIRY_MS,
			refreshToken: account.refresh_token,
		};
	}

	buildUrl(path: string, query: string, account?: Account): string {
		// Minimax provider only supports the official API endpoint
		const endpoint = "https://api.minimax.io/anthropic";
		return `${endpoint}${path}${query}`;
	}

	prepareHeaders(
		headers: Headers,
		accessToken?: string,
		apiKey?: string,
	): Headers {
		const newHeaders = new Headers(headers);

		// Minimax uses Bearer token for API key
		if (accessToken) {
			newHeaders.set("authorization", `Bearer ${accessToken}`);
		} else if (apiKey) {
			newHeaders.set("authorization", `Bearer ${apiKey}`);
		}

		// Remove host header
		newHeaders.delete("host");

		// Remove compression headers to avoid decompression issues
		newHeaders.delete("accept-encoding");
		newHeaders.delete("content-encoding");

		return newHeaders;
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
		// Minimax doesn't provide tier information in responses
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
				const maxBytes = BUFFER_SIZES.ANTHROPIC_STREAM_CAP_BYTES;
				const decoder = new TextDecoder();
				const READ_TIMEOUT_MS = TIME_CONSTANTS.STREAM_READ_TIMEOUT_MS;
				const startTime = Date.now();

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
								TIME_CONSTANTS.STREAM_OPERATION_TIMEOUT_MS,
							),
						);

						const { value, done } = await Promise.race([
							readPromise,
							timeoutPromise,
						]);

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

				// For Minimax streaming responses, message_delta always contains the final authoritative token counts
				// We should always prefer message_delta when available, regardless of whether tokens are zero
				const finalUsage = messageDeltaUsage || messageStartUsage;

				if (finalUsage) {
					// Use the model from message_start (Minimax returns MiniMax-M2 model names directly)
					const model = messageStartUsage?.model || "MiniMax-M2";

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

				// Calculate cost if we have a model (Minimax returns MiniMax-M2 model names directly)
				const model = json.model || "MiniMax-M2";
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
	 * Minimax doesn't support OAuth - uses API keys instead
	 */
	supportsOAuth(): boolean {
		return false;
	}
}