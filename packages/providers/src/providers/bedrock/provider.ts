import {
	BedrockRuntimeClient,
	ConverseCommand,
	ConverseStreamCommand,
} from "@aws-sdk/client-bedrock-runtime";
import { estimateCostUSD } from "@better-ccflare/core";
import { Logger } from "@better-ccflare/logger";
import type { Account } from "@better-ccflare/types";
import { BaseProvider } from "../../base";
import type { Provider, RateLimitInfo, TokenRefreshResult } from "../../types";
import {
	createBedrockCredentialChain,
	parseBedrockConfig,
	translateBedrockError,
} from "./index";
import { translateModelName } from "./model-cache";
import {
	type CrossRegionMode,
	canUseInferenceProfile,
	getFallbackMode,
	transformModelIdPrefix,
} from "./model-transformer";
import {
	type ClaudeRequest,
	detectStreamingMode,
	transformMessagesRequest,
	transformStreamingRequest,
} from "./request-transformer";
import {
	type BedrockConverseResponse,
	transformNonStreamingResponse,
} from "./response-parser";

const log = new Logger("BedrockProvider");

/**
 * AWS Bedrock provider for better-ccflare
 *
 * Integrates with better-ccflare's provider system to route /v1/messages requests
 * to AWS Bedrock accounts. Uses Phase 1 utilities for credential management and
 * AWS SDK v3 for automatic SigV4 signing.
 *
 * Architecture:
 * - Credentials resolved per-request from ~/.aws/credentials (no database storage)
 * - Profile and region stored in custom_endpoint field (format: "bedrock:profile:region")
 * - AWS SDK BedrockRuntimeClient handles SigV4 signing automatically
 * - Stub methods for Phases 3-5 (model translation, response handling, token extraction)
 *
 * Phase progression:
 * - Phase 2 (current): Provider registration and credential validation
 * - Phase 3: Request transformation (model translation, BedrockRuntimeClient)
 * - Phase 4: Response handling (streaming, error mapping)
 * - Phase 5: Token extraction and usage tracking
 */
export class BedrockProvider extends BaseProvider implements Provider {
	name = "bedrock";

	/**
	 * Check if this provider can handle the given request path
	 *
	 * Currently only supports Anthropic Messages API compatibility (/v1/messages).
	 * Future phases may add support for other endpoints.
	 *
	 * User decision (CONTEXT.md): Return true even if account config is invalid.
	 * Error surfaces at request time, not during routing.
	 *
	 * @param path - Request path (e.g., "/v1/messages")
	 * @returns true if this provider can handle the path
	 */
	canHandle(path: string): boolean {
		// Only handle /v1/messages for now (Anthropic Messages API compatibility)
		return path.startsWith("/v1/messages");
	}

	/**
	 * Refresh/validate AWS credentials for a Bedrock account
	 *
	 * Bedrock uses AWS credentials (not OAuth tokens), so this method validates
	 * that credentials exist and are accessible via the AWS credential chain.
	 *
	 * Resolution order (AWS SDK standard):
	 * 1. Environment variables (AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_SESSION_TOKEN)
	 * 2. AWS profiles from ~/.aws/credentials (using specified profile)
	 * 3. IAM role via instance metadata (when running on EC2/ECS)
	 *
	 * Returns a long-lived dummy token (1 year) since credentials are read from
	 * ~/.aws/credentials per-request, not cached in database.
	 *
	 * @param account - Account with custom_endpoint format "bedrock:profile:region"
	 * @param _clientId - Unused (Bedrock doesn't use OAuth)
	 * @returns TokenRefreshResult with dummy token indicating credentials are valid
	 * @throws Error if credentials are invalid or profile is misconfigured
	 */
	async refreshToken(
		account: Account,
		_clientId: string,
	): Promise<TokenRefreshResult> {
		// Parse profile and region from custom_endpoint ("bedrock:profile:region")
		const config = parseBedrockConfig(account.custom_endpoint);

		if (!config) {
			throw new Error(
				`Invalid Bedrock config for account ${account.name}: expected format "bedrock:profile:region"`,
			);
		}

		// Validate credentials exist by creating credential chain
		// This fails early if profile is misconfigured
		try {
			const credentialProvider = createBedrockCredentialChain(account);
			// Attempt to resolve credentials to validate they exist
			await credentialProvider();
			log.info(
				`Bedrock credentials valid for account ${account.name} (profile: ${config.profile}, region: ${config.region})`,
			);
		} catch (error) {
			const { message: errorMsg } = translateBedrockError(error);
			throw new Error(
				`Bedrock credential validation failed for ${account.name}: ${errorMsg}`,
			);
		}

		// Return dummy token (Bedrock doesn't use tokens, credentials are resolved per-request)
		// Use long expiry since credentials are read from ~/.aws/credentials per-request
		return {
			accessToken: "bedrock-credentials-valid",
			expiresAt: Date.now() + 365 * 24 * 60 * 60 * 1000, // 1 year
			refreshToken: "", // Empty string prevents DB update
		};
	}

	/**
	 * Build target URL for Bedrock request
	 *
	 * Bedrock uses AWS SDK client (not HTTP URLs), so this returns a placeholder.
	 * Actual requests in Phase 3 use BedrockRuntimeClient.invokeModel(), not fetch().
	 *
	 * @param path - Request path (e.g., "/v1/messages")
	 * @param query - Query string (e.g., "?foo=bar")
	 * @param account - Account configuration (for name logging)
	 * @returns Placeholder URL for logging/debugging
	 */
	buildUrl(path: string, query: string, account?: Account): string {
		// Bedrock uses AWS SDK client (not HTTP URLs)
		// Return placeholder - actual requests use BedrockRuntimeClient in Phase 3
		return `bedrock://${account?.name || "unknown"}${path}${query}`;
	}

	/**
	 * Prepare headers for Bedrock request
	 *
	 * Bedrock uses AWS SigV4 signing (not HTTP headers like Authorization or x-api-key).
	 * Phase 1 AWS SDK handles signing automatically via BedrockRuntimeClient.
	 *
	 * Remove client's authorization headers to prevent conflicts with AWS signing.
	 *
	 * @param headers - Original request headers
	 * @param _accessToken - Unused (Bedrock uses AWS credentials, not tokens)
	 * @param _apiKey - Unused (Bedrock uses AWS credentials, not API keys)
	 * @returns Cleaned headers with authorization removed
	 */
	prepareHeaders(
		headers: Headers,
		_accessToken?: string,
		_apiKey?: string,
	): Headers {
		// Bedrock uses AWS SigV4 signing (not headers)
		// Phase 1 AWS SDK handles signing automatically
		// Remove client's authorization headers to prevent conflicts
		const newHeaders = new Headers(headers);
		newHeaders.delete("authorization");
		newHeaders.delete("x-api-key");
		newHeaders.delete("host");
		newHeaders.delete("accept-encoding");
		newHeaders.delete("content-encoding");
		return newHeaders;
	}

	/**
	 * Parse rate limit information from Bedrock response
	 *
	 * AWS Bedrock throttling is handled via error codes (ThrottlingException),
	 * not via HTTP headers like Anthropic (anthropic-ratelimit-*).
	 *
	 * Stub for now - Phase 4 implements throttling detection from error codes.
	 *
	 * @param response - Bedrock response
	 * @returns Rate limit info (stub implementation)
	 */
	parseRateLimit(response: Response): RateLimitInfo {
		// AWS Bedrock throttling handled via error codes (ThrottlingException)
		// Not via HTTP headers like Anthropic
		// Stub for now - Phase 4 implements throttling detection
		if (response.status === 429) {
			return { isRateLimited: true };
		}
		return { isRateLimited: false };
	}

	/**
	 * Process Bedrock response before returning to client
	 *
	 * Phase 4 implementation:
	 * - Error detection and status code translation
	 * - Content-type detection (JSON vs SSE)
	 * - Non-streaming responses transformed to Claude Messages API format
	 * - Streaming responses forwarded unchanged (SSE events to client)
	 *
	 * Error handling:
	 * - Streaming errors pass through to client (errors surface in SSE parser)
	 * - Non-streaming errors translate to HTTP status codes with user-friendly messages
	 *
	 * @param response - Bedrock response
	 * @param account - Account configuration (for logging)
	 * @returns Processed response
	 */
	async processResponse(
		response: Response,
		account: Account | null,
	): Promise<Response> {
		// Check for error status codes
		if (!response.ok) {
			const contentType = response.headers.get("content-type") || "";

			// Streaming error: forward to client (errors surface in client-side SSE parser)
			if (contentType.includes("text/event-stream")) {
				log.warn(
					`Bedrock streaming error response (${account?.name || "unknown"}), forwarding to client`,
				);
				return response;
			}

			// Non-streaming error: parse and translate
			if (contentType.includes("application/json")) {
				try {
					const clone = response.clone();
					const json = await clone.json();
					const errorType = json.error?.type || json.__type || "";
					const { statusCode, message } = translateBedrockError({
						name: errorType,
						message: json.error?.message || json.message,
					});

					log.error(
						`Bedrock error (${account?.name || "unknown"}): ${errorType} → ${statusCode}`,
					);

					return new Response(JSON.stringify({ error: message }), {
						status: statusCode,
						headers: response.headers,
					});
				} catch (parseError) {
					// Failed to parse error, return original response
					log.error(
						`Failed to parse Bedrock error: ${(parseError as Error).message}`,
					);
					return response;
				}
			}
		}

		// Successful response: detect format from response headers (not request state)
		const contentType = response.headers.get("content-type") || "";

		// Streaming response: forward SSE unchanged to client
		if (contentType.includes("text/event-stream")) {
			return response;
		}

		// Non-streaming JSON response: transform to Claude format
		if (contentType.includes("application/json")) {
			return transformNonStreamingResponse(response);
		}

		// Unknown content type: pass through unchanged (shouldn't happen from Bedrock)
		return response;
	}

	/**
	 * Transform request body and invoke Bedrock API
	 *
	 * Phase 3 implementation:
	 * - Streaming mode detection via stream parameter in request body
	 * - Model name translation via database lookup
	 * - Passthrough for unknown models with auto-learning
	 * - Request body transformation to Bedrock Converse/ConverseStream API format
	 * - Bedrock API invocation with automatic SigV4 signing
	 * - Fallback to non-streaming for models that don't support streaming
	 *
	 * Note: Bedrock uses AWS SDK (not HTTP fetch like other providers).
	 * This method invokes Bedrock API directly and returns a Response object
	 * wrapped in a Request to maintain compatibility with Provider interface.
	 *
	 * @param request - Original request
	 * @param account - Account configuration (for region/profile)
	 * @returns Request wrapping Bedrock Response (compatibility shim)
	 */
	async transformRequestBody(
		request: Request,
		account?: Account,
	): Promise<Request> {
		// Step 1: Parse config
		if (!account) {
			throw new Error("Account is required for Bedrock provider");
		}

		const config = parseBedrockConfig(account.custom_endpoint);
		if (!config) {
			throw new Error(
				`Invalid Bedrock config for account ${account.name}: expected format "bedrock:profile:region"`,
			);
		}

		// Step 2: Detect streaming mode BEFORE reading body
		const requestClone = request.clone();
		const isStreaming = await detectStreamingMode(requestClone);

		// Step 3: Extract model from request
		const bodyText = await request.text();
		const body = JSON.parse(bodyText) as ClaudeRequest;

		// Step 4: Check for custom model override first
		let bedrockModelId: string | null = null;

		// Check if account has custom model in model_mappings
		if (account.model_mappings) {
			try {
				const mappings = JSON.parse(account.model_mappings);
				if (mappings.custom && typeof mappings.custom === "string") {
					bedrockModelId = mappings.custom;
					log.info(
						`Using custom Bedrock model from account settings: ${bedrockModelId}`,
					);
				}
			} catch (error) {
				log.warn(
					`Failed to parse model_mappings for account ${account.name}: ${(error as Error).message}`,
				);
			}
		}

		// Step 5: If no custom model, translate client model name to Bedrock model ID using fuzzy matching
		if (!bedrockModelId) {
			bedrockModelId = await translateModelName(body.model, account);
		}

		if (!bedrockModelId) {
			// No fuzzy match found, try passthrough with client model name as-is
			log.info(
				`No fuzzy match found for model ${body.model}, attempting passthrough`,
			);
			bedrockModelId = body.model;
		}

		const finalModelId = bedrockModelId;

		// Apply cross-region mode transformation
		const crossRegionMode =
			(account?.cross_region_mode as CrossRegionMode) ?? "geographic";
		let transformedModelId = transformModelIdPrefix(
			finalModelId,
			crossRegionMode,
		);

		// Validate model supports requested mode and fall back if needed
		if (!canUseInferenceProfile(transformedModelId, crossRegionMode)) {
			const fallback = getFallbackMode(transformedModelId, crossRegionMode);
			if (fallback) {
				log.warn(
					`Model ${finalModelId} doesn't support ${crossRegionMode} inference mode, falling back to ${fallback}`,
				);
				transformedModelId = transformModelIdPrefix(finalModelId, fallback);
			} else {
				log.warn(
					`Model ${finalModelId} has no supported inference mode, using regional fallback`,
				);
				transformedModelId = transformModelIdPrefix(finalModelId, "regional");
			}
		}

		// Step 6: Transform request based on streaming mode
		const converseInput = isStreaming
			? transformStreamingRequest(body)
			: transformMessagesRequest(body);

		// Step 7: Create client
		const credentials = createBedrockCredentialChain(account);
		const client = new BedrockRuntimeClient({
			region: config.region,
			credentials,
		});

		// Step 8: Call Bedrock API with appropriate command
		try {
			if (isStreaming) {
				// Streaming request using ConverseStreamCommand
				const command = new ConverseStreamCommand({
					modelId: transformedModelId,
					...converseInput,
				} as any); // Cast to any due to ConverseStreamCommandInput type constraints

				const response = await client.send(command);

				// Phase 4 will handle SSE streaming properly
				// For now, return raw Bedrock streaming response
				// Note: response.stream is an AsyncIterable<ResponseStream>
				// We'll need to convert this to a ReadableStream for the Response
				// For Phase 3, we'll create a simple wrapper
				const encoder = new TextEncoder();
				const stream = new ReadableStream({
					async start(controller) {
						try {
							// response.stream is the AsyncIterable from Bedrock
							if (response.stream) {
								for await (const event of response.stream) {
									// Forward events as-is for Phase 3
									// Phase 4 will transform to Claude Messages API format
									const data = JSON.stringify(event);
									controller.enqueue(encoder.encode(`data: ${data}\n\n`));
								}
							}
							controller.close();
						} catch (error) {
							controller.error(error);
						}
					},
				});

				return new Request("https://bedrock.aws/response", {
					method: "POST",
					headers: {
						"content-type": "text/event-stream",
						"cache-control": "no-cache",
						connection: "keep-alive",
						"x-bedrock-response": "true", // Marker for downstream handling
					},
					body: stream,
				});
			} else {
				// Non-streaming request using ConverseCommand
				const command = new ConverseCommand({
					modelId: transformedModelId,
					...converseInput,
				} as any); // Cast to any due to ConverseCommandInput type constraints

				const response = await client.send(command);

				// Return Response wrapped as Request for compatibility
				// Phase 4 will handle proper response transformation
				const responseBody = JSON.stringify(response);
				return new Request("https://bedrock.aws/response", {
					method: "POST",
					headers: {
						"content-type": "application/json",
						"x-bedrock-response": "true", // Marker for downstream handling
					},
					body: responseBody,
				});
			}
		} catch (error: any) {
			// Streaming fallback logic
			if (
				isStreaming &&
				error.name === "ValidationException" &&
				error.message?.includes("streaming")
			) {
				log.warn(
					`Model ${finalModelId} does not support streaming, falling back to non-streaming`,
				);

				// Retry without streaming
				const command = new ConverseCommand({
					modelId: transformedModelId,
					...transformMessagesRequest(body),
				} as any);

				const response = await client.send(command);

				const responseBody = JSON.stringify(response);
				return new Request("https://bedrock.aws/response", {
					method: "POST",
					headers: {
						"content-type": "application/json",
						"x-bedrock-response": "true",
					},
					body: responseBody,
				});
			}

			// Re-throw Bedrock errors with translation
			const { message: translatedError } = translateBedrockError(error);
			throw new Error(translatedError);
		}
	}

	/**
	 * Extract usage information from Bedrock response
	 *
	 * Phase 4 implementation:
	 * - Parse usage block from non-streaming JSON responses
	 * - Calculate costs based on model pricing via estimateCostUSD
	 * - Track cache usage (inputTokens, cacheReadInputTokens, cacheWriteInputTokens)
	 * - Graceful degradation: returns null on errors (streaming or missing usage)
	 *
	 * Note: Streaming usage extraction deferred to Phase 5 (requires SSE parsing)
	 *
	 * @param response - Bedrock response
	 * @returns Usage information or null
	 */
	async extractUsageInfo(response: Response): Promise<{
		model?: string;
		promptTokens?: number;
		completionTokens?: number;
		totalTokens?: number;
		inputTokens?: number;
		outputTokens?: number;
		costUsd?: number;
	} | null> {
		try {
			const contentType = response.headers.get("content-type") || "";

			// Only process JSON responses (streaming handled in Phase 5)
			if (!contentType.includes("application/json")) {
				return null;
			}

			const clone = response.clone();
			const json = (await clone.json()) as BedrockConverseResponse;

			if (!json.usage) {
				return null;
			}

			// Calculate token counts
			const inputTokens = json.usage.inputTokens || 0;
			const cacheWriteTokens = json.usage.cacheWriteInputTokens || 0;
			const cacheReadTokens = json.usage.cacheReadInputTokens || 0;
			const outputTokens = json.usage.outputTokens || 0;
			const promptTokens = inputTokens + cacheWriteTokens + cacheReadTokens;
			const totalTokens = promptTokens + outputTokens;

			// Calculate cost (graceful degradation if cost calculation fails)
			let costUsd: number | undefined;
			try {
				costUsd = await estimateCostUSD("bedrock", {
					inputTokens: inputTokens,
					outputTokens: outputTokens,
					cacheReadInputTokens: cacheReadTokens,
					cacheCreationInputTokens: cacheWriteTokens,
				});
			} catch (error) {
				log.warn(
					`Failed to calculate Bedrock cost: ${(error as Error).message}`,
				);
			}

			return {
				promptTokens,
				completionTokens: outputTokens,
				totalTokens,
				inputTokens,
				outputTokens,
				costUsd,
			};
		} catch (error) {
			log.error(
				`Failed to extract usage from Bedrock response: ${(error as Error).message}`,
			);
			return null;
		}
	}

	/**
	 * Parse usage from streaming SSE response (final event)
	 *
	 * Phase 5 implementation:
	 * - Wait for final SSE event containing usage metadata
	 * - Extract tokens and calculate cost immediately
	 * - Return null on parsing errors (graceful degradation per CONTEXT.md)
	 *
	 * User decision (CONTEXT.md):
	 * - "Wait for final SSE event to extract token usage (not incremental parsing)"
	 * - "If usage extraction fails, log warning and continue (mark usage as null/zero, don't fail request)"
	 * - "Calculate cost immediately when usage is extracted and store in database"
	 *
	 * @param response - Streaming SSE response
	 * @returns Usage information or null if extraction fails
	 */
	async parseUsage(response: Response): Promise<{
		model?: string;
		promptTokens?: number;
		completionTokens?: number;
		totalTokens?: number;
		inputTokens?: number;
		outputTokens?: number;
		costUsd?: number;
	} | null> {
		try {
			const contentType = response.headers.get("content-type") || "";

			// Non-streaming: delegate to extractUsageInfo
			if (contentType.includes("application/json")) {
				return this.extractUsageInfo(response);
			}

			// Streaming: parse SSE events to find final usage
			if (!contentType.includes("text/event-stream")) {
				log.warn("parseUsage called on non-SSE response, skipping");
				return null;
			}

			// Read entire SSE stream to find final usage event
			const reader = response.body?.getReader();
			if (!reader) {
				log.warn("No response body reader available");
				return null;
			}

			const decoder = new TextDecoder();
			let buffer = "";
			let usage: any = null;

			try {
				while (true) {
					const { done, value } = await reader.read();
					if (done) break;

					buffer += decoder.decode(value, { stream: true });
					const lines = buffer.split("\n");
					buffer = lines.pop() || ""; // Keep incomplete line in buffer

					for (const line of lines) {
						if (!line.startsWith("data: ")) continue;

						const data = line.slice(6).trim();
						if (data === "[DONE]") continue;

						try {
							const event = JSON.parse(data);

							// Bedrock SSE format: look for usage in various event types
							if (event.usage) {
								usage = event.usage;
							}
							// Alternative: message_stop event with usage
							if (event.type === "message_stop" && event.usage) {
								usage = event.usage;
							}
						} catch {
							// Ignore malformed JSON events
						}
					}
				}
			} finally {
				reader.releaseLock();
			}

			if (!usage) {
				log.debug("No usage found in SSE stream");
				return null;
			}

			// Calculate token counts (same logic as extractUsageInfo)
			const inputTokens = usage.inputTokens || usage.input_tokens || 0;
			const cacheWriteTokens =
				usage.cacheWriteInputTokens || usage.cache_write_input_tokens || 0;
			const cacheReadTokens =
				usage.cacheReadInputTokens || usage.cache_read_input_tokens || 0;
			const outputTokens = usage.outputTokens || usage.output_tokens || 0;
			const promptTokens = inputTokens + cacheWriteTokens + cacheReadTokens;
			const totalTokens = promptTokens + outputTokens;

			// Calculate cost immediately (per CONTEXT.md: "Calculate cost immediately when usage is extracted")
			let costUsd: number | undefined;
			try {
				costUsd = await estimateCostUSD("bedrock", {
					inputTokens,
					outputTokens,
					cacheReadInputTokens: cacheReadTokens,
					cacheCreationInputTokens: cacheWriteTokens,
				});
			} catch (error) {
				log.warn(
					`Failed to calculate Bedrock cost: ${(error as Error).message}`,
				);
			}

			return {
				promptTokens,
				completionTokens: outputTokens,
				totalTokens,
				inputTokens,
				outputTokens,
				costUsd,
			};
		} catch (error) {
			// Graceful degradation per CONTEXT.md: "If usage extraction fails, log warning and continue"
			log.warn(
				`Failed to parse usage from Bedrock SSE stream: ${(error as Error).message}`,
			);
			return null;
		}
	}

	/**
	 * Check if Bedrock response is streaming
	 *
	 * Stub for now - Phase 3 implements streaming detection:
	 * - Bedrock uses SSE (Server-Sent Events) format
	 * - Check for text/event-stream content type
	 *
	 * @param response - Bedrock response
	 * @returns true if response is streaming (stub implementation)
	 */
	isStreamingResponse(response: Response): boolean {
		// Stub - Phase 3 implements streaming detection
		const contentType = response.headers.get("content-type") || "";
		return (
			contentType.includes("text/event-stream") ||
			contentType.includes("stream")
		);
	}
}
