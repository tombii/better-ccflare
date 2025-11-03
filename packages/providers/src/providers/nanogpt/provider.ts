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
	private activeFetchPromises = new Map<string, Promise<NanoGPTSubscriptionUsage | null>>();

	/**
	 * Fetch NanoGPT subscription usage data with promise pooling to prevent duplicate requests
	 */
	private async fetchNanoGPTUsageData(
		apiKey: string,
	): Promise<NanoGPTSubscriptionUsage | null> {
		// We need an account identifier to implement the promise pooling, but we only have the API key here
		// Let's create a hash of the API key to use as an identifier
		// However, this approach has limitations as we can't easily identify which account this is for
		// Instead, we'll handle the promise pooling in the checkSubscriptionUsage method where we have the account ID
		try {
			const response = await fetch(
				"https://nano-gpt.com/api/subscription/v1/usage",
				{
					headers: {
						Authorization: `Bearer ${apiKey}`,
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
			return existingPromise.then(subscriptionData => {
				if (subscriptionData) {
					return {
						subscription: subscriptionData,
						lastChecked: Date.now(),
					};
				}
				return null;
			});
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
		} finally {
			// Clean up the promise from the map when the operation completes (success or failure)
			this.activeFetchPromises.delete(account.id);
		}
	}

	/**
	 * Override refreshToken to include subscription check and start polling
	 */
	async refreshToken(
		account: Account,
		clientId: string,
	): Promise<TokenRefreshResult> {
		// First, check subscription status
		const usageData = await this.checkSubscriptionUsage(account);

		if (usageData) {
			// Store subscription data in account metadata for later use
			log.debug(
				`NanoGPT subscription status for ${account.name}:`,
				usageData.subscription.state,
			);
		}

		// Start polling for usage data with 90-second interval (like Anthropic)
		// The startPolling method handles duplicate polling prevention internally
		this.startPolling(account, 90000);

		// Call parent implementation for API key handling
		return super.refreshToken(account, clientId);
	}

	/**
	 * Override buildUrl to prevent custom endpoints for NanoGPT and convert paths properly
	 */
	buildUrl(path: string, query: string, _account?: Account): string {
		// NanoGPT should not use custom endpoints - always use the fixed endpoint
		const defaultEndpoint = "https://nano-gpt.com";

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

		return `${defaultEndpoint}${nanoGPTPath}${query}`;
	}

	/**
	 * Override prepareHeaders to handle model mapping for NanoGPT
	 */
	prepareHeaders(
		headers: Headers,
		accessToken?: string,
		apiKey?: string,
	): Headers {
		const newHeaders = super.prepareHeaders(headers, accessToken, apiKey);

		// Add required OpenAI-compatible headers for NanoGPT
		newHeaders.set("Content-Type", "application/json");

		return newHeaders;
	}

	/**
	 * Override processResponse to handle subscription-specific responses
	 */
	async processResponse(
		response: Response,
		account: Account | null,
	): Promise<Response> {
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
			} else if (response.status >= 400) {
				// For other error statuses, we might want to check subscription status
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
		}

		return super.processResponse(response, account);
	}

	/**
	 * Check if daily limit would be exceeded based on current usage
	 */
	async isDailyLimitExceeded(account: Account): Promise<boolean> {
		const usageData = await this.checkSubscriptionUsage(account);

		if (!usageData) {
			return false; // If we can't check, assume it's not exceeded
		}

		const { subscription } = usageData;

		// If daily limit is enforced and daily remaining is 0, it's exceeded
		if (subscription.enforceDailyLimit && subscription.daily.remaining <= 0) {
			return true;
		}

		return false;
	}

	/**
	 * Check if monthly limit would be exceeded based on current usage
	 */
	async isMonthlyLimitExceeded(account: Account): Promise<boolean> {
		const usageData = await this.checkSubscriptionUsage(account);

		if (!usageData) {
			return false; // If we can't check, assume it's not exceeded
		}

		const { subscription } = usageData;

		// If monthly remaining is 0, it's exceeded
		return subscription.monthly.remaining <= 0;
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

	/**
	 * Check if this provider supports usage tracking
	 */
	supportsUsageTracking(): boolean {
		return true; // NanoGPT supports detailed usage tracking via subscription API
	}

	/**
	 * Check if the account is usable based on subscription status
	 */
	async isAccountUsable(account: Account): Promise<boolean> {
		const usageData = await this.checkSubscriptionUsage(account);

		if (!usageData) {
			// If we can't check the subscription (e.g., network error),
			// assume the account is usable to avoid blocking requests unnecessarily
			// The actual API call will fail if there's a real issue
			return true;
		}

		// Use the cached usage data to determine rate limit info instead of making another call
		const rateLimitInfo = await this.getRateLimitInfoFromUsageData(usageData);
		return !rateLimitInfo?.isRateLimited;
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
	 */
	async getRateLimitInfo(account: Account): Promise<RateLimitInfo> {
		const usageData = await this.checkSubscriptionUsage(account);

		if (!usageData) {
			// If we can't get usage data, return as not rate limited to avoid blocking
			return { isRateLimited: false };
		}

		return this.getRateLimitInfoFromUsageData(usageData);
	}
}
