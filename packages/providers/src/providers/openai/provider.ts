import { getEndpointUrl, validateEndpointUrl } from "@better-ccflare/core";
import { Logger } from "@better-ccflare/logger";
import {
	convertAnthropicPathToOpenAI,
	convertAnthropicRequestToOpenAI,
	convertOpenAIResponseToAnthropic,
	type OpenAIRequest,
	sanitizeHeaders,
	transformStreamingResponse,
} from "@better-ccflare/openai-formats";
import type { Account } from "@better-ccflare/types";
import { BaseProvider } from "../../base";
import type { RateLimitInfo, TokenRefreshResult } from "../../types";

const log = new Logger("OpenAICompatibleProvider");

export class OpenAICompatibleProvider extends BaseProvider {
	name = "openai-compatible";

	canHandle(path: string): boolean {
		// Reject Anthropic-specific endpoints that don't exist in OpenAI API
		if (path === "/v1/messages/count_tokens") {
			return false;
		}
		// Handle all other paths for OpenAI-compatible providers
		return true;
	}

	async refreshToken(
		account: Account,
		_clientId: string,
	): Promise<TokenRefreshResult> {
		// OpenAI-compatible providers use API keys, not OAuth tokens
		// Store the API key in refresh_token field for consistency
		if (!account.refresh_token) {
			throw new Error(`No API key available for account ${account.name}`);
		}

		// For API key based providers, we don't need to refresh tokens
		// Just return the existing API key as both access and refresh token
		return {
			accessToken: account.refresh_token,
			expiresAt: Date.now() + 365 * 24 * 60 * 60 * 1000, // 1 year from now
			refreshToken: "", // Empty string prevents DB update for API key accounts
		};
	}

	buildUrl(path: string, query: string, account?: Account): string {
		// Get endpoint URL with validation
		let endpoint: string;
		try {
			endpoint = account ? getEndpointUrl(account) : "https://api.openai.com";
			// Validate the endpoint
			endpoint = validateEndpointUrl(endpoint, "endpoint");
		} catch (error) {
			log.error(
				`Invalid endpoint for account ${account?.name || "unknown"}, using default: ${error instanceof Error ? error.message : String(error)}`,
			);
			endpoint = "https://api.openai.com";
		}

		// Convert Anthropic paths to OpenAI-compatible paths
		// Anthropic: /v1/messages → OpenAI: /v1/chat/completions
		let openaiPath = convertAnthropicPathToOpenAI(path);
		if (endpoint.endsWith("/v1") && openaiPath.startsWith("/v1/")) {
			openaiPath = openaiPath.replace(/^\/v1/, "");
		}

		return `${endpoint}${openaiPath}${query}`;
	}

	prepareHeaders(
		headers: Headers,
		_accessToken?: string,
		apiKey?: string,
	): Headers {
		const newHeaders = new Headers(headers);

		// SECURITY: Remove client's authorization header when we have provider credentials
		// to prevent credential leakage. If no credentials provided (passthrough mode),
		// preserve client's authorization for direct API access.
		// Use explicit undefined checks to handle empty strings correctly.
		if (_accessToken !== undefined || apiKey !== undefined) {
			newHeaders.delete("authorization");
		}

		// OpenAI uses Bearer token authentication with API key
		if (apiKey) {
			newHeaders.set("Authorization", `Bearer ${apiKey}`);
		} else if (_accessToken) {
			newHeaders.set("Authorization", `Bearer ${_accessToken}`);
		}

		// Remove host header
		newHeaders.delete("host");

		// Remove Anthropic-specific headers
		newHeaders.delete("anthropic-version");
		newHeaders.delete("anthropic-dangerous-direct-browser-access");

		return newHeaders;
	}

	parseRateLimit(response: Response): RateLimitInfo {
		// OpenAI-compatible providers (OpenRouter, etc.) should never be marked as rate-limited
		// by our load balancer. They handle their own rate limiting and return errors inline.
		// We always return isRateLimited: false to prevent the account from being marked unavailable.

		// Extract rate limit info headers if present (for informational purposes only)
		const resetHeader = response.headers.get("x-ratelimit-reset-requests");
		const remainingHeader = response.headers.get(
			"x-ratelimit-remaining-requests",
		);

		const resetTime = resetHeader ? Number(resetHeader) * 1000 : undefined;
		const remaining = remainingHeader ? Number(remainingHeader) : undefined;

		// Always return isRateLimited: false - do not block OpenAI-compatible accounts
		return {
			isRateLimited: false,
			resetTime,
			statusHeader: "allowed",
			remaining,
		};
	}

	async processResponse(
		response: Response,
		_account: Account | null,
	): Promise<Response> {
		// Convert OpenAI response format back to Anthropic format
		const contentType = response.headers.get("content-type");

		if (contentType?.includes("application/json")) {
			try {
				const clone = response.clone();
				const data = await clone.json();
				const anthropicData = convertOpenAIResponseToAnthropic(data);

				return new Response(JSON.stringify(anthropicData), {
					status: response.status,
					statusText: response.statusText,
					headers: sanitizeHeaders(response.headers),
				});
			} catch (error) {
				log.error(
					"Failed to convert OpenAI response to Anthropic format:",
					error,
				);
				// If conversion fails, return original response
			}
		}

		// For streaming responses, we need to transform the SSE stream
		if (contentType?.includes("text/event-stream")) {
			return transformStreamingResponse(response);
		}

		// For non-JSON responses, return as-is with sanitized headers
		return new Response(response.body, {
			status: response.status,
			statusText: response.statusText,
			headers: sanitizeHeaders(response.headers),
		});
	}

	/**
	 * Transform request body from Anthropic format to OpenAI format
	 */
	async transformRequestBody(
		request: Request,
		account?: Account,
	): Promise<Request> {
		const contentType = request.headers.get("content-type");

		if (!contentType?.includes("application/json")) {
			return request; // Not a JSON request, return as-is
		}

		try {
			const body = await request.json();
			const effectiveAccount = this.beforeConvert(body, account);
			const openaiBody = convertAnthropicRequestToOpenAI(
				body,
				effectiveAccount,
			);
			this.afterConvert(openaiBody);
			const newHeaders = new Headers(request.headers);
			newHeaders.set("content-type", "application/json");
			newHeaders.delete("content-length");

			return new Request(request.url, {
				method: request.method,
				headers: newHeaders,
				body: JSON.stringify(openaiBody),
			});
		} catch (error) {
			log.error(
				"Failed to transform Anthropic request to OpenAI format:",
				error,
			);
			return request; // Return original request if transformation fails
		}
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
				// For streaming, we can only extract usage from the final chunk
				// This is complex to implement properly, so we'll return null for now
				// In a full implementation, we'd need to buffer the entire stream
				return null;
			} else {
				// Handle non-streaming JSON responses
				const json = (await clone.json()) as {
					model?: string;
					usage?: {
						prompt_tokens?: number;
						completion_tokens?: number;
						total_tokens?: number;
						prompt_tokens_details?: Record<string, unknown>;
					};
				};

				if (!json.usage) return null;

				const promptTokens = json.usage.prompt_tokens || 0;
				const completionTokens = json.usage.completion_tokens || 0;
				const totalTokens =
					json.usage.total_tokens || promptTokens + completionTokens;

				// Extract cache statistics from prompt_tokens_details (Qwen/DashScope)
				const promptTokensDetails = json.usage.prompt_tokens_details as {
					cache_creation_input_tokens?: number;
					cached_tokens?: number;
				} | undefined;

				const cacheCreationInputTokens =
					promptTokensDetails?.cache_creation_input_tokens || 0;
				const cacheReadInputTokens = promptTokensDetails?.cached_tokens || 0;

				// Calculate cost using OpenAI-compatible pricing
				const costUsd = this.calculateCost(
					json.model,
					promptTokens,
					completionTokens,
				);

				return {
					model: json.model,
					promptTokens,
					completionTokens,
					totalTokens,
					costUsd,
					inputTokens: promptTokens,
					outputTokens: completionTokens,
					cacheReadInputTokens,
					cacheCreationInputTokens,
				};
			}
		} catch {
			// Ignore parsing errors
			return null;
		}
	}

	/**
	 * Calculate cost based on model and token usage
	 */
	protected calculateCost(
		model?: string,
		promptTokens: number = 0,
		completionTokens: number = 0,
	): number {
		if (!model) return 0;

		// Basic OpenAI-compatible pricing (can be enhanced based on provider)
		const pricing: Record<string, { input: number; output: number }> = {
			"gpt-3.5-turbo": { input: 0.0005, output: 0.0015 },
			"gpt-4": { input: 0.03, output: 0.06 },
			"gpt-4-turbo": { input: 0.01, output: 0.03 },
			"gpt-4o": { input: 0.005, output: 0.015 },
			"gpt-4o-mini": { input: 0.00015, output: 0.0006 },
			// Default pricing for unknown models
			default: { input: 0.001, output: 0.002 },
		};

		// Find matching pricing (use exact match or default)
		let modelPricing = pricing[model];
		if (!modelPricing) {
			// Try to match prefix (e.g., "gpt-4o-*" models)
			const prefix = Object.keys(pricing).find((key) =>
				model.includes(key.split("*")[0]),
			);
			modelPricing = pricing[prefix || "default"];
		}

		const inputCost = (promptTokens / 1000) * modelPricing.input;
		const outputCost = (completionTokens / 1000) * modelPricing.output;

		return Number((inputCost + outputCost).toFixed(6));
	}

	/**
	 * Check if this provider supports OAuth
	 */
	supportsOAuth(): boolean {
		return false; // OpenAI-compatible providers use API keys
	}

	/**
	 * Check if this provider supports usage tracking
	 */
	supportsUsageTracking(): boolean {
		return true; // OpenAI-compatible providers support usage tracking via response body
	}

	/**
	 * Hook called after converting Anthropic request to OpenAI format.
	 * Override to inject provider-specific fields (e.g., cache_control, vision flags).
	 */
	protected afterConvert(_body: OpenAIRequest): void {
		// No-op by default — override in subclasses
	}

	/**
	 * Hook called before converting Anthropic request to OpenAI format.
	 * Override to adjust the account (e.g., inject default model mappings).
	 * Returns the account to use for model mapping.
	 */
	protected beforeConvert(
		_body: Record<string, unknown>,
		account?: Account,
	): Account | undefined {
		return account;
	}
}
