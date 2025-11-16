import {
	getEndpointUrl,
	mapModelName,
	validateEndpointUrl,
} from "@better-ccflare/core";
import { Logger } from "@better-ccflare/logger";
import type { Account } from "@better-ccflare/types";
import { BaseProvider } from "../../base";
import type { RateLimitInfo, TokenRefreshResult } from "../../types";

const log = new Logger("OpenAICompatibleProvider");

// OpenAI API Request/Response Types
interface OpenAIMessage {
	role: "system" | "user" | "assistant";
	content: string;
}

interface OpenAIRequest {
	model: string;
	messages: OpenAIMessage[];
	max_tokens?: number;
	temperature?: number;
	top_p?: number;
	stop?: string | string[];
	stream?: boolean;
}

interface AnthropicMessage {
	role: "user" | "assistant";
	content: string | Array<{ type: "text"; text: string }>;
}

interface AnthropicRequest {
	model: string;
	max_tokens: number;
	messages: AnthropicMessage[];
	system?: string;
	temperature?: number;
	top_p?: number;
	stop_sequences?: string[];
	stream?: boolean;
}

interface OpenAIUsage {
	prompt_tokens?: number;
	completion_tokens?: number;
	total_tokens?: number;
	prompt_tokens_details?: Record<string, unknown>;
}

interface OpenAIResponse {
	id?: string;
	object?: string;
	model?: string;
	choices?: Array<{
		message?: {
			content?: string;
			role?: string;
		};
		delta?: {
			content?: string;
		};
		finish_reason?: string;
	}>;
	usage?: OpenAIUsage;
	error?: {
		message?: string;
		type?: string;
		code?: string;
	};
}

interface AnthropicResponse {
	type: "message" | "error";
	id?: string;
	role?: string;
	content?: Array<{
		type: "text";
		text: string;
	}>;
	model?: string;
	stop_reason?: string;
	stop_sequence?: string;
	usage?: {
		input_tokens: number;
		output_tokens: number;
	};
	error?: {
		type: string;
		message: string;
	};
}

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
		let openaiPath = this.convertAnthropicPathToOpenAI(path);
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
				const anthropicData = this.convertOpenAIResponseToAnthropic(data);

				return new Response(JSON.stringify(anthropicData), {
					status: response.status,
					statusText: response.statusText,
					headers: this.sanitizeHeaders(response.headers),
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
			return this.transformStreamingResponse(response);
		}

		// For non-JSON responses, return as-is with sanitized headers
		return new Response(response.body, {
			status: response.status,
			statusText: response.statusText,
			headers: this.sanitizeHeaders(response.headers),
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
			const openaiBody = this.convertAnthropicRequestToOpenAI(body, account);
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
					cacheReadInputTokens: 0,
					cacheCreationInputTokens: 0,
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
	private calculateCost(
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
	 * Convert Anthropic API paths to OpenAI-compatible paths
	 */
	private convertAnthropicPathToOpenAI(anthropicPath: string): string {
		// Anthropic /v1/messages → OpenAI /v1/chat/completions
		if (anthropicPath === "/v1/messages") {
			return "/v1/chat/completions";
		}

		// For other paths, keep them as-is for now
		// This could be expanded based on needs
		return anthropicPath;
	}

	/**
	 * Convert Anthropic request format to OpenAI format
	 */
	private convertAnthropicRequestToOpenAI(
		anthropicData: AnthropicRequest,
		account?: Account,
	): OpenAIRequest {
		// Map the model name from Anthropic to provider-specific
		const mappedModel = account
			? mapModelName(anthropicData.model, account)
			: "openai/gpt-5";

		const openaiRequest: OpenAIRequest = {
			model: mappedModel,
			messages: [],
		};

		// Map parameters
		if (anthropicData.max_tokens !== undefined) {
			openaiRequest.max_tokens = anthropicData.max_tokens;
		}
		if (anthropicData.temperature !== undefined) {
			openaiRequest.temperature = anthropicData.temperature;
		}
		if (anthropicData.top_p !== undefined) {
			openaiRequest.top_p = anthropicData.top_p;
		}
		if (anthropicData.stop_sequences !== undefined) {
			openaiRequest.stop = anthropicData.stop_sequences;
		}
		if (anthropicData.stream !== undefined) {
			openaiRequest.stream = anthropicData.stream;
		}

		// Handle system message (Anthropic has it as top-level, OpenAI has it in messages array)
		const messages: OpenAIMessage[] = [];
		if (anthropicData.system) {
			messages.push({
				role: "system",
				content: anthropicData.system,
			});
		}

		// Add user/assistant messages
		if (anthropicData.messages && Array.isArray(anthropicData.messages)) {
			for (const message of anthropicData.messages) {
				const openaiMessage: OpenAIMessage = {
					role: message.role,
					content: Array.isArray(message.content)
						? message.content
								.filter((part) => part.type === "text")
								.map((part) => part.text)
								.join("")
						: message.content,
				};

				// Handle content arrays (Anthropic supports rich content)
				if (Array.isArray(message.content)) {
					// Convert Anthropic content array to OpenAI string format
					const textParts = message.content
						.filter((part: { type: string }) => part.type === "text")
						.map((part: { text: string }) => part.text)
						.join("");
					openaiMessage.content = textParts;
				}

				messages.push(openaiMessage);
			}
		}

		openaiRequest.messages = messages;
		return openaiRequest;
	}

	/**
	 * Convert OpenAI response format to Anthropic format
	 */
	private convertOpenAIResponseToAnthropic(
		openaiData: OpenAIResponse,
	): AnthropicResponse {
		// Handle error responses
		if (openaiData.error) {
			return {
				type: "error",
				error: {
					type: openaiData.error.type || "api_error",
					message: openaiData.error.message || "An error occurred",
				},
			};
		}

		// Handle successful responses
		const choice = openaiData.choices?.[0];
		if (!choice) {
			return {
				type: "error",
				error: {
					type: "invalid_response",
					message: "Invalid response format from OpenAI provider",
				},
			};
		}

		return {
			id: openaiData.id || `msg_${Date.now()}`,
			type: "message",
			role: "assistant",
			content: [
				{
					type: "text",
					text: choice.message?.content || "",
				},
			],
			model: openaiData.model,
			stop_reason: this.mapOpenAIFinishReason(choice.finish_reason),
			stop_sequence: undefined,
			usage: {
				input_tokens: openaiData.usage?.prompt_tokens || 0,
				output_tokens: openaiData.usage?.completion_tokens || 0,
			},
		};
	}

	/**
	 * Map OpenAI finish_reason to Anthropic stop_reason
	 */
	private mapOpenAIFinishReason(openaiReason?: string): string {
		switch (openaiReason) {
			case "stop":
				return "end_turn";
			case "length":
				return "max_tokens";
			case "function_call":
			case "tool_calls":
				return "tool_use";
			case "content_filter":
				return "stop_sequence";
			default:
				return "end_turn";
		}
	}

	/**
	 * Transform streaming response from OpenAI to Anthropic format
	 */
	private transformStreamingResponse(response: Response): Response {
		if (!response.body) {
			return response;
		}

		const encoder = new TextEncoder();
		const decoder = new TextDecoder();

		// Use pipeThrough to transform the stream while preserving clonability
		const transformedBody = response.body.pipeThrough(
			new TransformStream<Uint8Array, Uint8Array>({
				start(_controller) {
					// biome-ignore lint/suspicious/noExplicitAny: TransformStream doesn't support custom context properties
					(this as any).buffer = "";
					// biome-ignore lint/suspicious/noExplicitAny: TransformStream doesn't support custom context properties
					(this as any).hasStarted = false;
					// biome-ignore lint/suspicious/noExplicitAny: TransformStream doesn't support custom context properties
					(this as any).extractedModel = "unknown";
					// biome-ignore lint/suspicious/noExplicitAny: TransformStream doesn't support custom context properties
					(this as any).hasSentStart = false;
					// biome-ignore lint/suspicious/noExplicitAny: TransformStream doesn't support custom context properties
					(this as any).hasSentContentBlockStart = false;
				},
				transform(chunk, controller) {
					try {
						// biome-ignore lint/suspicious/noExplicitAny: TransformStream doesn't support custom context properties
						const context = this as any;
						// Decode the chunk and add to buffer
						context.buffer += decoder.decode(chunk, { stream: true });
						const lines = context.buffer.split("\n");
						// Keep incomplete line in buffer
						context.buffer = lines.pop() || "";

						for (const line of lines) {
							const trimmed = line.trim();
							if (!trimmed || !trimmed.startsWith("data:")) continue;

							const dataStr = trimmed.slice(5).trim();

							// Handle [DONE] marker
							if (dataStr === "[DONE]") {
								// Send content_block_stop
								if (context.hasSentContentBlockStart) {
									const contentBlockStop = {
										type: "content_block_stop",
										index: 0,
									};
									controller.enqueue(
										encoder.encode(`event: content_block_stop\n`),
									);
									controller.enqueue(
										encoder.encode(
											`data: ${JSON.stringify(contentBlockStop)}\n\n`,
										),
									);
								}

								// Send message_delta
								const messageDelta = {
									type: "message_delta",
									delta: {
										stop_reason: "end_turn",
										stop_sequence: null,
									},
									usage: {
										output_tokens: 0,
									},
								};
								controller.enqueue(encoder.encode(`event: message_delta\n`));
								controller.enqueue(
									encoder.encode(`data: ${JSON.stringify(messageDelta)}\n\n`),
								);

								// Send message_stop
								const messageStop = {
									type: "message_stop",
								};
								controller.enqueue(encoder.encode(`event: message_stop\n`));
								controller.enqueue(
									encoder.encode(`data: ${JSON.stringify(messageStop)}\n\n`),
								);
								continue;
							}

							// Parse OpenAI chunk
							try {
								const data = JSON.parse(dataStr);

								// Extract model from first chunk
								if (!context.hasStarted && data.model) {
									context.extractedModel = data.model;
									context.hasStarted = true;
								}

								// Send message_start on first chunk
								if (!context.hasSentStart) {
									context.hasSentStart = true;
									const messageStart = {
										type: "message_start",
										message: {
											id: `msg_${Date.now()}`,
											type: "message",
											role: "assistant",
											content: [],
											model: context.extractedModel,
											stop_reason: null,
											stop_sequence: null,
											usage: {
												input_tokens: 0,
												output_tokens: 0,
											},
										},
									};
									controller.enqueue(encoder.encode(`event: message_start\n`));
									controller.enqueue(
										encoder.encode(`data: ${JSON.stringify(messageStart)}\n\n`),
									);

									// Send ping
									const ping = { type: "ping" };
									controller.enqueue(encoder.encode(`event: ping\n`));
									controller.enqueue(
										encoder.encode(`data: ${JSON.stringify(ping)}\n\n`),
									);
								}

								const delta = data.choices?.[0]?.delta;
								if (delta?.content) {
									// Send content_block_start on first content
									if (!context.hasSentContentBlockStart) {
										context.hasSentContentBlockStart = true;
										const contentBlockStart = {
											type: "content_block_start",
											index: 0,
											content_block: {
												type: "text",
												text: "",
											},
										};
										controller.enqueue(
											encoder.encode(`event: content_block_start\n`),
										);
										controller.enqueue(
											encoder.encode(
												`data: ${JSON.stringify(contentBlockStart)}\n\n`,
											),
										);
									}

									// Send content delta
									const contentBlockDelta = {
										type: "content_block_delta",
										index: 0,
										delta: {
											type: "text_delta",
											text: delta.content,
										},
									};
									controller.enqueue(
										encoder.encode(`event: content_block_delta\n`),
									);
									controller.enqueue(
										encoder.encode(
											`data: ${JSON.stringify(contentBlockDelta)}\n\n`,
										),
									);
								}
							} catch (_parseError) {
								// Ignore JSON parse errors for malformed chunks
							}
						}
					} catch (error) {
						log.error("Error in transform:", error);
					}
				},
			}),
		);

		// The issue: response.clone() on a pipeThrough'd Response returns the original
		// untransformed body in some environments. Solution: Manually tee the stream
		// and attach the analytics stream as a property for response-handler to use.

		// Tee the transformed stream into two independent streams
		const [clientStream, analyticsStream] = transformedBody.tee();

		// Create the response that will be returned to the client
		const clientResponse = new Response(clientStream, {
			status: response.status,
			statusText: response.statusText,
			headers: this.sanitizeHeaders(response.headers),
		});

		// Attach the analytics stream as a non-enumerable property
		// The response-handler will check for this and use it instead of calling clone()
		Object.defineProperty(clientResponse, "__analyticsStream", {
			value: analyticsStream,
			writable: false,
			enumerable: false,
			configurable: false,
		});

		return clientResponse;
	}

	/**
	 * Sanitize headers by removing provider-specific headers
	 */
	private sanitizeHeaders(headers: Headers): Headers {
		const sanitized = new Headers();

		for (const [key, value] of headers.entries()) {
			// Skip provider-specific headers
			if (
				!key.startsWith("x-ratelimit-") &&
				!key.startsWith("openai-") &&
				key !== "access-control-expose-headers"
			) {
				sanitized.set(key, value);
			}
		}

		// Add back important headers that should be preserved
		sanitized.set(
			"content-type",
			headers.get("content-type") || "application/json",
		);

		return sanitized;
	}
}
