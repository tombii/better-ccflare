import {
	BUFFER_SIZES,
	estimateCostUSD,
	KNOWN_PATTERNS,
	parseModelMappings,
	TIME_CONSTANTS,
} from "@better-ccflare/core";
import { sanitizeProxyHeaders } from "@better-ccflare/http-common";
import { Logger } from "@better-ccflare/logger";
import type { Account } from "@better-ccflare/types";
import { BaseProvider } from "../base";
import type { RateLimitInfo, TokenRefreshResult } from "../types";
import { transformRequestBodyModel } from "../utils/model-mapping";

// Configuration interface for Anthropic-compatible providers
export interface AnthropicCompatibleConfig {
	name?: string;
	baseUrl?: string;
	authHeader?: string; // "x-api-key", "authorization", etc.
	authType?: "bearer" | "direct"; // Whether to add "Bearer " prefix for authorization header
	modelMappings?: Record<string, string>; // Model name mappings
	supportsStreaming?: boolean; // Whether this provider supports streaming
	defaultModel?: string; // Default model to use
}

// Default configuration
const DEFAULT_CONFIG: AnthropicCompatibleConfig = {
	name: "anthropic-compatible",
	baseUrl: "https://api.anthropic.com",
	authHeader: "x-api-key",
	authType: "direct",
	supportsStreaming: true,
};

// Hard rate limit statuses (similar to Anthropic)
const HARD_LIMIT_STATUSES = new Set([
	"rate_limited",
	"blocked",
	"queueing_hard",
	"payment_required",
]);

const log = new Logger("BaseAnthropicCompatibleProvider");

export abstract class BaseAnthropicCompatibleProvider extends BaseProvider {
	protected config: AnthropicCompatibleConfig;
	name: string; // Make name concrete instead of abstract

	constructor(config: Partial<AnthropicCompatibleConfig> = {}) {
		super();
		this.config = { ...DEFAULT_CONFIG, ...config };
		// Set name from config, ensuring we always have a valid name
		const providerName =
			this.config.name || DEFAULT_CONFIG.name || "base-anthropic-compatible";
		this.name = providerName;
		if (!this.config.name) {
			this.config.name = providerName;
		}
	}

	/**
	 * Get the endpoint URL for this provider
	 * Must be implemented by each provider
	 */
	abstract getEndpoint(): string;

	/**
	 * Get the authentication header name for this provider
	 * Defaults to config.authHeader but can be overridden
	 */
	getAuthHeader(): string {
		return this.config.authHeader || "x-api-key";
	}

	/**
	 * Get the authentication type for this provider
	 * Defaults to config.authType but can be overridden
	 */
	getAuthType(): "bearer" | "direct" {
		const authType = this.config.authType;
		if (authType !== "bearer" && authType !== "direct") {
			return "direct"; // sensible default
		}
		return authType;
	}

	canHandle(_path: string): boolean {
		return true;
	}

	async refreshToken(
		account: Account,
		_clientId: string,
	): Promise<TokenRefreshResult> {
		// Anthropic-compatible providers use API keys
		// Prioritize api_key field, but maintain fallback to refresh_token for backward compatibility
		let apiKey: string | undefined;
		if (account.api_key) {
			apiKey = account.api_key;
		} else if (account.refresh_token) {
			apiKey = account.refresh_token;
		}

		if (!apiKey) {
			throw new Error(`No API key available for account ${account.name}`);
		}

		log.info(`Using API key for ${this.name} account ${account.name}`);

		return {
			accessToken: apiKey,
			expiresAt: Date.now() + TIME_CONSTANTS.API_KEY_TOKEN_EXPIRY_MS,
			refreshToken: "", // Empty string prevents DB update for API key accounts
		};
	}

	buildUrl(path: string, query: string, _account?: Account): string {
		const baseUrl = this.getEndpoint().replace(/\/$/, ""); // Remove trailing slash
		return `${baseUrl}${path}${query}`;
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
			newHeaders.delete("authorization");

			// Set authentication header for API key
			const token = accessToken || apiKey;
			if (token) {
				const headerName = this.getAuthHeader();
				const authType = this.getAuthType();

				if (headerName === "authorization" && authType === "bearer") {
					newHeaders.set(headerName, `Bearer ${token}`);
				} else {
					newHeaders.set(headerName, token);
				}
			}
		}

		// Remove host header
		newHeaders.delete("host");

		// Remove compression headers to avoid decompression issues
		newHeaders.delete("accept-encoding");
		newHeaders.delete("content-encoding");

		return newHeaders;
	}

	/**
	 * Transform request body to handle model mapping
	 */
	async transformRequestBody(
		request: Request,
		account?: Account,
	): Promise<Request> {
		if (!this.config.supportsStreaming) {
			return request;
		}

		// Use the shared utility for model mapping
		return transformRequestBodyModel(request, account, (model, acc) => {
			// Provider-specific mapping logic
			let mappedModel = model;

			// First try account-specific mappings
			if (acc?.model_mappings) {
				mappedModel = this.mapAccountModel(model, acc);
			}
			// Fall back to static config mappings for backward compatibility
			else if (this.config.modelMappings?.[model]) {
				mappedModel = this.config.modelMappings[model];
			}

			return mappedModel;
		});
	}

	/**
	 * Helper method to map models using account-specific mappings
	 */
	private mapAccountModel(originalModel: string, account: Account): string {
		if (!account.model_mappings) {
			return originalModel;
		}

		const accountMappings = parseModelMappings(account.model_mappings);

		if (!accountMappings) {
			return originalModel;
		}

		// First try exact match
		if (accountMappings[originalModel]) {
			return accountMappings[originalModel];
		}

		// Try pattern matching for known model families (more efficient)
		const modelLower = originalModel.toLowerCase();

		for (const pattern of KNOWN_PATTERNS) {
			if (modelLower.includes(pattern) && accountMappings[pattern]) {
				return accountMappings[pattern];
			}
		}

		return originalModel;
	}

	parseRateLimit(response: Response): RateLimitInfo {
		// Check for unified rate limit headers (Anthropic-style)
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
			const resetTime = resetHeader ? Number(resetHeader) * 1000 : undefined;
			const remaining = remainingHeader ? Number(remainingHeader) : undefined;

			const isRateLimited =
				HARD_LIMIT_STATUSES.has(statusHeader || "") || response.status === 429;

			return {
				isRateLimited,
				resetTime,
				statusHeader: statusHeader || undefined,
				remaining,
			};
		}

		// Fall back to traditional 429 check
		if (response.status !== 429) {
			return { isRateLimited: false };
		}

		const retryAfter = response.headers.get("retry-after");
		let resetTime: number | undefined;

		if (retryAfter) {
			const seconds = Number(retryAfter);
			if (!Number.isNaN(seconds)) {
				resetTime = Date.now() + seconds * 1000;
			} else {
				resetTime = new Date(retryAfter).getTime();
			}
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
		// Generic implementation - specific providers may override
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

			// Handle streaming responses if supported
			if (
				this.config.supportsStreaming &&
				contentType?.includes("text/event-stream")
			) {
				return this.extractStreamingUsage(clone, response.headers);
			}

			// Handle non-streaming JSON responses
			const json = await clone.json();

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

			// Calculate cost if we have a model
			const model = json.model || this.config.defaultModel;
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
		} catch {
			return null;
		}
	}

	/**
	 * Extract usage information from streaming responses
	 * Uses sophisticated SSE parsing for message_start and message_delta events
	 */
	protected async extractStreamingUsage(
		clone: Response,
		_originalHeaders: Headers,
	): Promise<{
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
				if (Date.now() - startTime > READ_TIMEOUT_MS) {
					await reader.cancel();
					throw new Error("Stream read timeout while extracting usage info");
				}

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

				let value: Uint8Array | undefined, done: boolean;
				try {
					({ value, done } = await Promise.race([readPromise, timeoutPromise]));
				} catch (error) {
					if (
						error instanceof Error &&
						error.message === "Read operation timeout"
					) {
						log.warn(
							"Stream read operation timed out while extracting usage info - continuing without usage data",
						);
						return null;
					}
					throw error; // Re-throw other errors
				}

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
										cache_read_input_tokens: data.usage.cache_read_input_tokens,
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

		// For streaming responses, message_delta always contains the final authoritative token counts
		// We should always prefer message_delta when available, regardless of whether tokens are zero
		const finalUsage = messageDeltaUsage || messageStartUsage;

		if (!finalUsage) return null;

		// Use the model from message_start
		const model = messageStartUsage?.model || this.config.defaultModel;

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
			(inputTokens || 0) + cacheReadInputTokens + cacheCreationInputTokens;
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

	/**
	 * Check if a response is a streaming response
	 */
	isStreamingResponse(response: Response): boolean {
		if (!this.config.supportsStreaming) return false;

		const contentType = response.headers.get("content-type") ?? "";
		return (
			contentType.includes("text/event-stream") ||
			contentType.includes("stream")
		);
	}

	/**
	 * Check if this provider supports OAuth
	 */
	supportsOAuth(): boolean {
		return false;
	}
}
