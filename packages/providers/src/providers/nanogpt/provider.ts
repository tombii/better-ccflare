import { Logger } from "@better-ccflare/logger";
import type { Account } from "@better-ccflare/types";
import type { RateLimitInfo, TokenRefreshResult } from "../../types";
import { type AccessTokenProvider, usageCache } from "../../usage-fetcher";
import { OpenAICompatibleProvider } from "../openai/provider";

const log = new Logger("NanoGPTProvider");

// NanoGPT subscription usage types
interface NanoGPTSubscriptionUsage {
	active: boolean;
	limits: {
		daily: number;
		monthly: number;
	};
	enforceDailyLimit: boolean;
	daily: {
		used: number;
		remaining: number;
		percentUsed: number;
		resetAt: number; // timestamp in milliseconds
	};
	monthly: {
		used: number;
		remaining: number;
		percentUsed: number;
		resetAt: number; // timestamp in milliseconds
	};
	period: {
		currentPeriodEnd: string | null;
	};
	state: "active" | "grace" | "inactive";
	graceUntil: string | null;
}

export class NanoGPTProvider extends OpenAICompatibleProvider {
	name = "nanogpt";

	// Cache for active fetch promises to prevent duplicate API calls for the same account
	private activeFetchPromises = new Map<
		string,
		Promise<NanoGPTSubscriptionUsage | null>
	>();

	/**
	 * Override canHandle to reject system/internal endpoints
	 */
	canHandle(path: string): boolean {
		// Reject system endpoints that shouldn't go to external APIs
		if (path.startsWith("/api/system/")) {
			log.debug(`[NanoGPT] Rejecting system endpoint: ${path}`);
			return false;
		}

		// Reject health check endpoints
		if (path === "/health" || path === "/ping" || path === "/status") {
			log.debug(`[NanoGPT] Rejecting health endpoint: ${path}`);
			return false;
		}

		// Reject administrative endpoints
		if (path.startsWith("/admin/") || path.startsWith("/api/admin/")) {
			log.debug(`[NanoGPT] Rejecting admin endpoint: ${path}`);
			return false;
		}

		// Reject proxy management endpoints
		if (
			path.startsWith("/api/accounts/") ||
			path.startsWith("/api/analytics")
		) {
			log.debug(`[NanoGPT] Rejecting management endpoint: ${path}`);
			return false;
		}

		// For all other paths, delegate to parent but also reject Anthropic-specific endpoints
		return super.canHandle(path);
	}

	/**
	 * Override buildUrl to use NanoGPT-specific endpoint and path conversion
	 */
	buildUrl(path: string, query: string, account?: Account): string {
		// NanoGPT should not use custom endpoints - always use the fixed endpoint
		// Even if account.custom_endpoint is set, we ignore it for NanoGPT
		const defaultEndpoint = "https://nano-gpt.com";

		// Log if custom endpoint was provided but ignored
		if (account?.custom_endpoint) {
			console.log(
				`[NanoGPT] Ignoring custom endpoint ${account.custom_endpoint}, using fixed endpoint ${defaultEndpoint}`,
			);
		}

		// Convert Anthropic paths to OpenAI-compatible paths for NanoGPT
		// Anthropic: /v1/messages -> NanoGPT: /api/v1/chat/completions
		let nanoGPTPath = path;
		if (path === "/v1/messages") {
			nanoGPTPath = "/api/v1/chat/completions";
		} else if (path === "/v1/complete") {
			// Handle other Anthropic-specific paths if they exist
			nanoGPTPath = "/api/v1/completions";
		} else if (path === "/v1/messages/count_tokens") {
			// Token counting might not be supported or have a different endpoint
			nanoGPTPath = "/api/v1/chat/completions"; // Fallback for now
		}

		// Remove beta=true parameter from query string for NanoGPT as well
		let cleanQuery = query;
		if (query) {
			try {
				const url = new URL(`https://dummy.com${nanoGPTPath}${query}`);
				const searchParams = url.searchParams;

				// Remove beta parameter if present
				if (searchParams.has("beta")) {
					searchParams.delete("beta");
					cleanQuery = searchParams.toString();
					if (cleanQuery) {
						cleanQuery = `?${cleanQuery}`;
					}
					log.debug(
						`Removed beta parameter from query string for NanoGPT provider`,
					);
				}
			} catch (error) {
				log.warn(
					`Failed to parse query string for beta removal: ${query}`,
					error,
				);
			}
		}

		const fullUrl = `${defaultEndpoint}${nanoGPTPath}${cleanQuery}`;
		log.debug(
			`[NanoGPT] Building URL - path: ${path} -> ${nanoGPTPath}, full URL: ${fullUrl}`,
		);
		return fullUrl;
	}

	/**
	 * Override prepareHeaders to use standard Authorization: Bearer header for NanoGPT authentication
	 */
	prepareHeaders(
		headers: Headers,
		_accessToken?: string,
		apiKey?: string,
	): Headers {
		const newHeaders = new Headers(headers);

		// Remove host header
		newHeaders.delete("host");

		// Remove Anthropic-specific headers to prevent credential leaks to non-Anthropic providers
		newHeaders.delete("anthropic-version");
		newHeaders.delete("anthropic-dangerous-direct-browser-access");

		// Remove original authorization header to prevent credential leaks
		// The system will add its own authentication (API key) for the target provider
		newHeaders.delete("authorization");

		// NanoGPT uses standard Authorization: Bearer header for authentication
		if (apiKey) {
			newHeaders.set("Authorization", `Bearer ${apiKey}`);
		}

		// Add Content-Type header
		newHeaders.set("Content-Type", "application/json");

		return newHeaders;
	}

	/**
	 * Fetch NanoGPT subscription usage data with promise pooling to prevent duplicate requests
	 */
	private async fetchNanoGPTUsageData(
		apiKey: string,
	): Promise<NanoGPTSubscriptionUsage | null> {
		try {
			const response = await fetch(
				"https://nano-gpt.com/api/subscription/v1/usage",
				{
					headers: {
						"x-api-key": apiKey,
					},
				},
			);

			if (!response.ok) {
				log.error(
					`Failed to fetch NanoGPT subscription usage: ${response.status} ${response.statusText}`,
				);
				return null;
			}

			const subscriptionData = await response.json();
			return subscriptionData as NanoGPTSubscriptionUsage;
		} catch (error) {
			log.error(`Error fetching NanoGPT subscription usage:`, error);
			return null;
		}
	}

	/**
	 * Start polling for NanoGPT subscription usage data
	 */
	startPolling(account: Account, intervalMs?: number) {
		// Create a function to fetch and return NanoGPT usage data for the cache
		const tokenProvider: AccessTokenProvider = async () => {
			// Use only the api_key field (no fallback to refresh_token to avoid inconsistency)
			const apiKey = account.api_key;
			if (!apiKey) {
				throw new Error(`No API key available for account ${account.name}`);
			}

			// Fetch the NanoGPT usage data
			const usageData = await this.fetchNanoGPTUsageData(apiKey);
			if (!usageData) {
				throw new Error(
					`Failed to fetch NanoGPT usage data for account ${account.name}`,
				);
			}

			// Return the usage data as a string for the cache (it will be stored and retrieved as-is)
			return JSON.stringify(usageData);
		};

		// Start polling with the usage cache system using the same interval as Anthropic (~90 seconds)
		// Note: We're using the provider name "nanogpt" which will be checked by the cache system
		// Prevent duplicate polling by checking if already polling
		if (!usageCache.isPolling(account.id)) {
			usageCache.startPolling(account.id, tokenProvider, this.name, intervalMs);
		}
	}

	/**
	 * Stop polling for NanoGPT subscription usage data
	 */
	stopPolling(accountId: string) {
		usageCache.stopPolling(accountId);
	}

	/**
	 * Check subscription status and usage before allowing requests
	 */
	async checkSubscriptionUsage(account: Account): Promise<{
		subscription: NanoGPTSubscriptionUsage;
		lastChecked: number;
	} | null> {
		// Use the global usage cache system with 90-second polling interval
		const cachedJson = usageCache.get(account.id);
		if (cachedJson) {
			try {
				// The cached data is stored as JSON string, parse it back to the expected format
				const subscriptionData = JSON.parse(
					cachedJson as unknown as string,
				) as NanoGPTSubscriptionUsage;
				return {
					subscription: subscriptionData,
					lastChecked: Date.now() - (usageCache.getAge(account.id) || 0),
				};
			} catch (error) {
				log.error(`Error parsing cached NanoGPT usage data:`, error);
				// Fall through to direct fetch below
			}
		}

		// If not in cache, fetch directly once and don't cache via this method
		// The polling system will handle regular updates
		const apiKey = account.api_key;
		if (!apiKey) {
			log.error(`No API key available for account ${account.name}`);
			return null;
		}

		// Implement promise pooling to prevent duplicate API calls for the same account
		const existingPromise = this.activeFetchPromises.get(account.id);
		if (existingPromise) {
			// Return the existing promise if one is already in flight for this account
			try {
				const subscriptionData = await existingPromise;
				if (subscriptionData) {
					return {
						subscription: subscriptionData,
						lastChecked: Date.now(),
					};
				}
				return null;
			} catch (error) {
				// If the existing promise fails, log and continue with a new request
				log.warn(
					`Existing fetch promise failed for account ${account.name}, retrying:`,
					error,
				);
				// Clean up the failed promise from the map
				this.activeFetchPromises.delete(account.id);
			}
		}

		// Create a new promise for this fetch operation
		const fetchPromise = this.fetchNanoGPTUsageData(apiKey);

		// Store the promise in the map BEFORE awaiting it to prevent race conditions
		this.activeFetchPromises.set(account.id, fetchPromise);

		try {
			const subscriptionData = await fetchPromise;
			if (!subscriptionData) {
				return null;
			}

			return {
				subscription: subscriptionData,
				lastChecked: Date.now(),
			};
		} catch (error) {
			log.error(
				`Failed to fetch NanoGPT usage data for account ${account.name}:`,
				error,
			);
			return null;
		} finally {
			// Clean up the promise from the map when the operation completes (success or failure)
			this.activeFetchPromises.delete(account.id);
		}
	}

	/**
	 * Override refreshToken for account initialization and subscription monitoring setup
	 * For API key providers like NanoGPT, this method is called during account setup
	 * to initialize subscription monitoring, not for actual token refresh.
	 * Subscription check is done in the background to avoid blocking main requests.
	 */
	async refreshToken(
		account: Account,
		clientId: string,
	): Promise<TokenRefreshResult> {
		// Check subscription status in the background without blocking
		// This allows the main API request to proceed even if subscription API has issues
		this.checkSubscriptionUsage(account)
			.then((usageData) => {
				if (usageData) {
					// Store subscription data in account metadata for later use
					log.debug(
						`NanoGPT subscription status for ${account.name}:`,
						usageData.subscription.state,
					);
				}
			})
			.catch((error) => {
				// Log subscription check errors but don't block the main flow
				log.warn(
					`NanoGPT subscription check failed for ${account.name}, proceeding with PAYG mode:`,
					error,
				);
			});

		// Start polling for usage data with 90-second interval (like Anthropic)
		// The startPolling method handles duplicate polling prevention internally
		// Run this in the background as well to avoid blocking
		setImmediate(() => {
			this.startPolling(account, 90000);
		});

		// Call parent implementation for API key handling immediately
		return super.refreshToken(account, clientId);
	}

	/**
	 * Override processResponse to handle subscription-specific responses and streaming usage extraction
	 */
	async processResponse(
		response: Response,
		account: Account | null,
	): Promise<Response> {
		const isStreaming = response.headers
			.get("content-type")
			?.includes("text/event-stream");

		// Check if this is a NanoGPT account
		if (account && account.provider === "nanogpt") {
			// Check if the response indicates subscription-related issues
			if (response.status === 401 || response.status === 403) {
				// Unauthorized or Forbidden - could indicate subscription issues
				log.warn(
					`NanoGPT account ${account.name} returned status ${response.status}, may need subscription check`,
				);
			} else if (response.status === 429) {
				// Rate limited - check if it's related to subscription limits
				log.info(
					`NanoGPT account ${account.name} is rate limited, checking subscription status`,
				);
			} else if (response.status >= 400 && !isStreaming) {
				// For other error statuses (only for non-streaming responses), we might want to check subscription status
				// Don't try to read streaming response bodies as they can only be consumed once
				const responseBody = await response.clone().text();
				if (
					responseBody.includes("subscription") ||
					responseBody.includes("limit")
				) {
					log.warn(
						`NanoGPT account ${account.name} returned error related to subscription: ${responseBody}`,
					);
				}
			}

			// For streaming responses, we need to capture usage data from the stream
			if (isStreaming && response.body) {
				const { readable, writable } = new TransformStream();
				const writer = writable.getWriter();
				const reader = response.body.getReader();
				const decoder = new TextDecoder();
				let buffer = "";
				let usageInfo: {
					model?: string;
					promptTokens?: number;
					completionTokens?: number;
					totalTokens?: number;
					costUsd?: number;
					inputTokens?: number;
					outputTokens?: number;
				} | null = null;

				// Get request ID from response headers to associate usage data
				const requestId = response.headers.get("x-request-id");

				// Process the stream to extract usage data
				const processStream = async () => {
					try {
						let _fullStreamContent = "";
						let modelFromStream: string | undefined;
						while (true) {
							const { done, value } = await reader.read();
							if (done) break;

							const chunk = decoder.decode(value, { stream: true });
							buffer += chunk;
							_fullStreamContent += chunk;

							// Look for data lines in the SSE stream
							const lines = buffer.split("\n");
							buffer = lines.pop() || ""; // Keep incomplete line in buffer

							for (const line of lines) {
								if (line.startsWith("data: ")) {
									const data = line.slice(6); // Remove "data: " prefix
									if (data !== "[DONE]") {
										try {
											const parsed = JSON.parse(data);

											// Add debugging for parsed stream data only when finish_reason is "stop"
											if (parsed.choices?.[0]?.finish_reason === "stop") {
												// Removed debug logging of parsed stream data
											}

											// Extract model name from any chunk that has it
											if (parsed.model) {
												modelFromStream = parsed.model;
											}

											// Check if this is the final chunk with usage data
											if (parsed.usage && parsed.x_nanogpt_pricing) {
												// Extract usage information
												const promptTokens = parsed.usage.prompt_tokens || 0;
												const completionTokens =
													parsed.usage.completion_tokens || 0;
												const totalTokens =
													parsed.usage.total_tokens ||
													promptTokens + completionTokens;
												// Extract cost from multiple possible locations: usage.cost, x_nanogpt_pricing.cost, or x_nanogpt_pricing.amount
												const costUsd =
													parsed.usage.cost ||
													parsed.x_nanogpt_pricing?.cost ||
													parsed.x_nanogpt_pricing?.amount;

												usageInfo = {
													model: parsed.model,
													promptTokens,
													completionTokens,
													totalTokens,
													costUsd,
													inputTokens:
														parsed.usage.input_tokens || promptTokens,
													outputTokens: completionTokens,
												};
											}
											// Write the chunk to the output stream
											await writer.write(
												new TextEncoder().encode(`${line}\n`),
											);
										} catch (_e) {
											// If parsing fails, still write the line
											await writer.write(
												new TextEncoder().encode(`${line}\n`),
											);
										}
									} else {
										// Write the [DONE] line
										await writer.write(new TextEncoder().encode(`${line}\n`));
									}
								} else if (line.trim()) {
									// Write non-data lines (like event: or id: lines)
									await writer.write(new TextEncoder().encode(`${line}\n`));
								}
							}
						}

						// Process any remaining buffer
						if (buffer.trim()) {
							await writer.write(new TextEncoder().encode(`${buffer}\n`));
						}

						// If we didn't extract usage info but we have a model name, create minimal usage info with just the model
						if (!usageInfo && modelFromStream) {
							usageInfo = {
								model: modelFromStream,
								promptTokens: undefined,
								completionTokens: undefined,
								totalTokens: undefined,
								costUsd: undefined,
								inputTokens: undefined,
								outputTokens: undefined,
							};
						}
					} finally {
						try {
							// Store the extracted usage info if we found it and have a request ID
							if (usageInfo && requestId) {
								NanoGPTProvider.streamingUsageMap.set(requestId, usageInfo);
								log.debug(
									`NanoGPT: Stored usage info for request ${requestId}`,
								);
							}
							await writer.close();
						} catch (closeError) {
							log.error("Error closing stream writer:", closeError);
						}
					}
				};

				// Start processing the stream in the background
				const streamProcessingPromise = processStream();

				// Create a new response with the processed stream
				const newResponse = new Response(readable, {
					status: response.status,
					statusText: response.statusText,
					headers: response.headers,
				});

				// Wait for the stream processing to complete before returning the response
				// This ensures that the usage info is stored in the map before the response processor
				// calls updateAccountMetadata
				await streamProcessingPromise;

				return super.processResponse(newResponse, account);
			}
		}

		return super.processResponse(response, account);
	}

	// Static map to store usage info extracted from streams, keyed by request ID
	private static streamingUsageMap = new Map<
		string,
		{
			model?: string;
			promptTokens?: number;
			completionTokens?: number;
			totalTokens?: number;
			costUsd?: number;
			inputTokens?: number;
			outputTokens?: number;
		}
	>();

	/**
	 * Get usage info extracted from a streaming response by request ID
	 */
	getStreamingUsageInfo(requestId: string) {
		const usageInfo = NanoGPTProvider.streamingUsageMap.get(requestId);
		if (usageInfo) {
			// Clean up the stored usage info after retrieval
			NanoGPTProvider.streamingUsageMap.delete(requestId);
			return usageInfo;
		}
		return null;
	}

	/**
	 * Check if daily limit would be exceeded based on current usage
	 * This method should not block and should work in PAYG mode by default
	 */
	async isDailyLimitExceeded(account: Account): Promise<boolean> {
		try {
			// Try to get cached subscription data first (non-blocking)
			const cachedJson = usageCache.get(account.id);
			if (cachedJson) {
				try {
					const subscriptionData = JSON.parse(
						cachedJson as unknown as string,
					) as NanoGPTSubscriptionUsage;

					// If we have cached data, check the daily limit
					if (
						subscriptionData.enforceDailyLimit &&
						subscriptionData.daily.remaining <= 0
					) {
						return true;
					}
				} catch (parseError) {
					log.warn(
						`Failed to parse cached subscription data for ${account.name}:`,
						parseError,
					);
					// Fall through to return false (not exceeded) to avoid blocking
				}
			}

			// If no cached data or parsing failed, assume limit is not exceeded to avoid blocking
			return false;
		} catch (error) {
			log.warn(
				`Error checking daily limit for ${account.name}, proceeding with PAYG mode:`,
				error,
			);
			return false; // Don't block requests if subscription check fails
		}
	}

	/**
	 * Check if monthly limit would be exceeded based on current usage
	 * This method should not block and should work in PAYG mode by default
	 */
	async isMonthlyLimitExceeded(account: Account): Promise<boolean> {
		try {
			// Try to get cached subscription data first (non-blocking)
			const cachedJson = usageCache.get(account.id);
			if (cachedJson) {
				try {
					const subscriptionData = JSON.parse(
						cachedJson as unknown as string,
					) as NanoGPTSubscriptionUsage;

					// If we have cached data, check the monthly limit
					return subscriptionData.monthly.remaining <= 0;
				} catch (parseError) {
					log.warn(
						`Failed to parse cached subscription data for ${account.name}:`,
						parseError,
					);
					// Fall through to return false (not exceeded) to avoid blocking
				}
			}

			// If no cached data or parsing failed, assume limit is not exceeded to avoid blocking
			return false;
		} catch (error) {
			log.warn(
				`Error checking monthly limit for ${account.name}, proceeding with PAYG mode:`,
				error,
			);
			return false; // Don't block requests if subscription check fails
		}
	}

	/**
	 * Get current subscription usage data for the account
	 */
	async getSubscriptionUsage(
		account: Account,
	): Promise<NanoGPTSubscriptionUsage | null> {
		const usageData = await this.checkSubscriptionUsage(account);
		return usageData ? usageData.subscription : null;
	}

	/** Transform request body to add stream_options and force streaming for usage tracking */
	async transformRequestBody(
		request: Request,
		account?: Account,
	): Promise<Request> {
		// Log the request headers for debugging, masking sensitive information
		const headersObj = Object.fromEntries(request.headers.entries());
		if (headersObj.authorization) {
			headersObj.authorization = "Bearer [MASKED]";
		}
		console.log(
			`[NanoGPT] Request headers:`,
			JSON.stringify(headersObj, null, 2),
		);

		// First, let the parent class handle model mapping by calling its transformRequestBody
		const mappedRequest = await super.transformRequestBody(request, account);

		// Then clone the mapped request to add NanoGPT-specific modifications
		const clonedRequest = mappedRequest.clone();
		const body = await clonedRequest.text();

		if (body) {
			try {
				const jsonBody = JSON.parse(body);

				// Remove beta parameter from request body if present
				if (jsonBody.beta) {
					delete jsonBody.beta;
					log.debug(`[NanoGPT] Removed beta parameter from request body`);
				}

				// For NanoGPT, we need to force streaming to capture usage information
				// regardless of what the client requests, since usage info comes through the stream
				jsonBody.stream = true; // Always enable streaming for NanoGPT
				// Always ensure stream_options includes usage for proper data extraction
				if (!jsonBody.stream_options) {
					jsonBody.stream_options = { include_usage: true };
					log.debug(
						`[NanoGPT] Forced streaming with stream_options for usage tracking`,
					);
				} else if (!jsonBody.stream_options.include_usage) {
					// Ensure include_usage is set to true if stream_options exists but doesn't have it
					jsonBody.stream_options.include_usage = true;
					log.debug(`[NanoGPT] Added include_usage to existing stream_options`);
				}

				// Convert back to string and create new request
				const modifiedBody = JSON.stringify(jsonBody);
				return new Request(mappedRequest, {
					body: modifiedBody,
				});
			} catch (error) {
				log.error(`NanoGPT: Error parsing request body:`, error);
				// If parsing fails, return the mapped request from parent
				return mappedRequest;
			}
		}

		return mappedRequest;
	}

	/**
	 * Check if this provider supports usage tracking
	 */
	supportsUsageTracking(): boolean {
		return true; // NanoGPT supports detailed usage tracking via subscription API
	}

	/**
	 * Check if the account is usable based on subscription status
	 * This method should not block and should work in PAYG mode by default
	 */
	async isAccountUsable(account: Account): Promise<boolean> {
		try {
			// Try to get cached subscription data first (non-blocking)
			const cachedJson = usageCache.get(account.id);
			if (cachedJson) {
				try {
					const subscriptionData = JSON.parse(
						cachedJson as unknown as string,
					) as NanoGPTSubscriptionUsage;

					// If we have cached data, use it to determine usability
					const rateLimitInfo = this.getRateLimitInfoFromUsageData({
						subscription: subscriptionData,
						lastChecked: Date.now() - (usageCache.getAge(account.id) || 0),
					});
					return !rateLimitInfo.isRateLimited;
				} catch (parseError) {
					log.warn(
						`Failed to parse cached subscription data for ${account.name}:`,
						parseError,
					);
					// Fall through to assume usable in PAYG mode
				}
			}

			// If no cached data or parsing failed, assume account is usable in PAYG mode
			// Don't await the subscription check to avoid blocking requests
			return true;
		} catch (error) {
			log.warn(
				`Error checking account usability for ${account.name}, proceeding with PAYG mode:`,
				error,
			);
			return true; // Assume usable to avoid blocking requests
		}
	}

	/**
	 * Get rate limit info based on subscription usage data (internal helper to avoid duplicate API calls)
	 */
	private getRateLimitInfoFromUsageData(usageData: {
		subscription: NanoGPTSubscriptionUsage;
		lastChecked: number;
	}): RateLimitInfo {
		const { subscription } = usageData;

		// If the account is inactive (no subscription), treat as PAYG (pay-as-you-go)
		if (subscription.state === "inactive") {
			// PAYG accounts don't have rate limits managed by us, they're managed by the provider
			return { isRateLimited: false };
		}

		// Determine if the account is rate limited based on subscription usage
		let isRateLimited = false;
		let resetTime: number | undefined;

		// If daily limit is enforced and daily limit is reached
		if (subscription.enforceDailyLimit && subscription.daily.remaining <= 0) {
			isRateLimited = true;
			resetTime = subscription.daily.resetAt; // Use daily reset time
		}
		// If monthly limit is reached
		else if (subscription.monthly.remaining <= 0) {
			isRateLimited = true;
			resetTime = subscription.monthly.resetAt; // Use monthly reset time
		}

		return {
			isRateLimited,
			resetTime,
			statusHeader: isRateLimited ? "rate_limited" : "allowed",
		};
	}

	/**
	 * Get rate limit info based on subscription usage
	 * This method should not block and should work in PAYG mode by default
	 */
	async getRateLimitInfo(account: Account): Promise<RateLimitInfo> {
		try {
			// Try to get cached subscription data first (non-blocking)
			const cachedJson = usageCache.get(account.id);
			if (cachedJson) {
				try {
					const subscriptionData = JSON.parse(
						cachedJson as unknown as string,
					) as NanoGPTSubscriptionUsage;

					// If we have cached data, use it to determine rate limit info
					return this.getRateLimitInfoFromUsageData({
						subscription: subscriptionData,
						lastChecked: Date.now() - (usageCache.getAge(account.id) || 0),
					});
				} catch (parseError) {
					log.warn(
						`Failed to parse cached subscription data for ${account.name}:`,
						parseError,
					);
					// Fall through to return default non-rate-limited state
				}
			}

			// If no cached data or parsing failed, return as not rate limited to avoid blocking
			// This enables PAYG mode when subscription API is unavailable
			return { isRateLimited: false };
		} catch (error) {
			log.warn(
				`Error getting rate limit info for ${account.name}, proceeding with PAYG mode:`,
				error,
			);
			return { isRateLimited: false }; // Don't block requests if subscription check fails
		}
	}

	/**
	 * Override extractUsageInfo to extract NanoGPT-specific pricing information
	 * For streaming responses, this method returns null, and usage is extracted in processResponse
	 */
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
			const contentType = response.headers.get("content-type");

			log.debug(
				`NanoGPT: Processing ${contentType} response for usage extraction`,
			);

			// Handle streaming responses (SSE) - return null since usage will be extracted in processResponse
			if (contentType?.includes("text/event-stream")) {
				log.debug(
					`NanoGPT: Streaming response detected, usage will be extracted in processResponse`,
				);
				return null;
			} else {
				// Handle non-streaming JSON responses
				const clone = response.clone();
				const json = (await clone.json()) as {
					model?: string;
					usage?: {
						prompt_tokens?: number;
						completion_tokens?: number;
						total_tokens?: number;
						cost?: number;
						currency?: string;
						cache_creation_input_tokens?: number;
						cache_read_input_tokens?: number;
						prompt_tokens_details?: Record<string, unknown>;
						completion_tokens_details?: Record<string, unknown>;
						reasoning_tokens?: number;
						citation_tokens?: number;
						num_search_queries?: number;
						input_tokens?: number;
					};
					x_nanogpt_pricing?: {
						amount?: number;
						currency?: string;
						cost?: number;
						inputTokens?: number;
						outputTokens?: number;
						cacheCost?: number;
						paymentSource?: string;
					};
				};

				log.debug(`NanoGPT: Parsed JSON response for usage extraction`);

				if (!json.usage) {
					log.debug(`NanoGPT: No usage object found in response`);
					// Even if no usage data, return model information if available
					if (json.model) {
						log.debug(`NanoGPT: Returning model name only: ${json.model}`);
						return {
							model: json.model,
							promptTokens: undefined,
							completionTokens: undefined,
							totalTokens: undefined,
							costUsd: undefined,
							inputTokens: undefined,
							outputTokens: undefined,
							cacheReadInputTokens: 0,
							cacheCreationInputTokens: 0,
						};
					}
					return null;
				}

				const promptTokens = json.usage.prompt_tokens || 0;
				const completionTokens = json.usage.completion_tokens || 0;
				const totalTokens =
					json.usage.total_tokens || promptTokens + completionTokens;

				log.debug(
					`NanoGPT: Extracted tokens - prompt: ${promptTokens}, completion: ${completionTokens}, total: ${totalTokens}`,
				);

				// Extract NanoGPT-specific pricing information
				const nanoGptPricing = json.x_nanogpt_pricing;
				log.debug(`NanoGPT: Processing x_nanogpt_pricing object`);

				let costUsd: number | undefined;

				// Check for cost in multiple locations: usage.cost, x_nanogpt_pricing.cost, or x_nanogpt_pricing.amount
				const usageCost =
					typeof json.usage?.cost === "number" ? json.usage.cost : undefined;
				const pricingCost =
					nanoGptPricing &&
					(typeof nanoGptPricing.cost === "number" ||
						typeof nanoGptPricing.amount === "number")
						? nanoGptPricing.cost || nanoGptPricing.amount
						: undefined;

				costUsd = usageCost || pricingCost;

				if (costUsd !== undefined) {
					log.debug(`NanoGPT: Extracted exact cost $${costUsd} from response`);
				} else {
					log.debug(
						`NanoGPT: No pricing info in response, cost will be calculated by parent`,
					);
					// Still return the extracted data even if no pricing is available, but only if we have model info
					if (json.model) {
						log.debug(
							`NanoGPT: Returning model and token info without cost: ${json.model}`,
						);
						return {
							model: json.model,
							promptTokens,
							completionTokens,
							totalTokens,
							costUsd: undefined, // Cost will be calculated by parent
							inputTokens: promptTokens,
							outputTokens: completionTokens,
							cacheReadInputTokens: 0,
							cacheCreationInputTokens: 0,
						};
					}
					// Let the parent class handle cost calculation if NanoGPT pricing not available
					return null;
				}

				const result = {
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

				log.debug(`NanoGPT: Returning usage info with model: ${json.model}`);
				return result;
			}
		} catch (error) {
			console.error("NanoGPT: Failed to extract usage info:", error);
			log.error("NanoGPT: Failed to extract usage info:", error);
			return null;
		}
	}
}
