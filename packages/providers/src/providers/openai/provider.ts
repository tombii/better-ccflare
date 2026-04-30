import {
	getEndpointUrl,
	ValidationError,
	validateEndpointUrl,
} from "@better-ccflare/core";
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

	canHandle(_path: string): boolean {
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

		// Store endpoint for provider-specific transformations (e.g., Alibaba caching)
		this.currentEndpoint = endpoint;

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

			// Inject enable_thinking for reasoning models on DashScope
			this.injectDashScopeReasoning(openaiBody, body);

			const newHeaders = new Headers(request.headers);
			newHeaders.set("content-type", "application/json");
			newHeaders.delete("content-length");

			return new Request(request.url, {
				method: request.method,
				headers: newHeaders,
				body: JSON.stringify(openaiBody),
			});
		} catch (error) {
			if (error instanceof ValidationError) {
				throw error;
			}
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
				const promptTokensDetails = json.usage.prompt_tokens_details as
					| {
							cache_creation_input_tokens?: number;
							cached_tokens?: number;
					  }
					| undefined;

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
	protected afterConvert(body: OpenAIRequest): void {
		// Inject cache_control for Alibaba/DashScope endpoints
		if (this.shouldInjectAlibabaCaching()) {
			this.injectAlibabaCaching(body);
		}
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
		// Store model for provider-specific transformations (e.g., Alibaba caching for Qwen)
		if (_body.model && typeof _body.model === "string") {
			this.currentModel = _body.model;
		}
		return account;
	}

	/**
	 * Check if we should inject Alibaba-style prompt caching.
	 * Only triggered for Qwen models on DashScope or OpenCode Go endpoints.
	 * These endpoints support Alibaba's cacheControl format for Qwen models only.
	 */
	private shouldInjectAlibabaCaching(): boolean {
		// Check if current request is for a DashScope or OpenCode Go endpoint
		const endpoint = this.currentEndpoint?.toLowerCase() || "";
		const isDashScopeEndpoint =
			endpoint.includes("dashscope.aliyuncs.com") ||
			endpoint.includes("opencode.ai/zen/go");

		if (!isDashScopeEndpoint) return false;

		// Only apply caching for Qwen models (qwen3.5-plus, qwen3.6-plus, etc.)
		// Other models on these endpoints use different SDKs (openai-compatible, anthropic)
		const model = this.currentModel?.toLowerCase() || "";
		return model.includes("qwen");
	}

	/**
	 * Inject Alibaba-style cache_control on system and final messages.
	 * Uses OpenAI-compatible format (snake_case) since DashScope endpoint is /compatible-mode/v1.
	 * Mirrors opencode's applyCaching logic for prompt caching.
	 */
	private injectAlibabaCaching(body: OpenAIRequest): void {
		if (!body.messages || body.messages.length === 0) return;

		// Find system messages (first 2) and final messages (last 2)
		const systemMessages = body.messages
			.filter((msg) => msg.role === "system")
			.slice(0, 2);

		const nonSystemMessages = body.messages.filter(
			(msg) => msg.role !== "system",
		);
		const finalMessages = nonSystemMessages.slice(-2);

		// Apply caching to these messages
		const messagesToCache = [...systemMessages, ...finalMessages];

		for (const msg of messagesToCache) {
			// DashScope OpenAI-compatible endpoint expects snake_case cache_control
			if (Array.isArray(msg.content)) {
				// Find last valid content part
				const lastPart = msg.content[msg.content.length - 1];
				if (
					lastPart &&
					typeof lastPart === "object" &&
					lastPart.type === "text"
				) {
					// Inject cache_control (snake_case for OpenAI-compatible API)
					(lastPart as any).cache_control = { type: "ephemeral" };
				}
			} else if (typeof msg.content === "string" && msg.content.length > 0) {
				// Convert string content to array with cache_control
				msg.content = [
					{
						type: "text",
						text: msg.content,
						cache_control: { type: "ephemeral" },
					},
				];
			}
		}

		log.debug(
			`Injected cache_control for ${messagesToCache.length} messages on DashScope endpoint`,
		);
	}

	/**
	 * Inject enable_thinking for reasoning models on DashScope.
	 * DashScope's OpenAI-compatible API requires this flag to return reasoning_content.
	 * Without it, reasoning models like Qwen-Plus, Qwen3, qwq, etc. never output thinking tokens.
	 */
	private injectDashScopeReasoning(
		openaiBody: OpenAIRequest,
		anthropicBody: Record<string, unknown>,
	): void {
		// Only apply for DashScope endpoints
		const endpoint = this.currentEndpoint?.toLowerCase() || "";
		if (
			!endpoint.includes("dashscope.aliyuncs.com") &&
			!endpoint.includes("opencode.ai/zen/go")
		)
			return;

		// Check if model is a reasoning model (has thinking/reasoning capabilities)
		const modelId = this.currentModel?.toLowerCase() || "";
		const isReasoningModel =
			modelId.includes("qwen") ||
			modelId.includes("qwq") ||
			modelId.includes("deepseek-r1") ||
			// Also check if anthropic request indicates thinking
			(anthropicBody as any).thinking?.type === "enabled";

		// Skip if it's kimi-k2-thinking (returns reasoning_content by default)
		if (modelId.includes("kimi-k2-thinking")) return;

		// Inject enable_thinking flag
		if (isReasoningModel) {
			(openaiBody as any).enable_thinking = true;
			log.debug(
				`Injected enable_thinking for DashScope reasoning model: ${modelId}`,
			);
		}
	}

	/**
	 * Store current endpoint for provider-specific transformations
	 */
	private currentEndpoint?: string;

	/**
	 * Store current model for provider-specific transformations (e.g., Qwen caching)
	 */
	private currentModel?: string;
}
