import { Logger } from "@better-ccflare/logger";
import type { Account } from "@better-ccflare/types";
import type { RateLimitInfo, TokenRefreshResult } from "../../types";
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

interface NanoGPTUsageData {
	subscription: NanoGPTSubscriptionUsage;
	lastChecked: number;
}

// Simple in-memory cache for subscription usage data
const subscriptionCache = new Map<string, NanoGPTUsageData>();

export class NanoGPTProvider extends OpenAICompatibleProvider {
	name = "nanogpt";

	/**
	 * Check subscription status and usage before allowing requests
	 */
	async checkSubscriptionUsage(
		account: Account,
	): Promise<NanoGPTUsageData | null> {
		// Prioritize api_key field, fall back to refresh_token for backward compatibility
		const apiKey = account.api_key || account.refresh_token;
		if (!apiKey) {
			log.error(`No API key available for account ${account.name}`);
			return null;
		}

		// Check if we have cached data that's still fresh (less than 30 seconds old)
		const cached = subscriptionCache.get(account.id);
		if (cached && Date.now() - cached.lastChecked < 30000) {
			// 30 seconds cache
			return cached;
		}

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

			const subscriptionData =
				(await response.json()) as NanoGPTSubscriptionUsage;

			const usageData: NanoGPTUsageData = {
				subscription: subscriptionData,
				lastChecked: Date.now(),
			};

			// Cache the result
			subscriptionCache.set(account.id, usageData);

			return usageData;
		} catch (error) {
			log.error(`Error fetching NanoGPT subscription usage:`, error);
			return null;
		}
	}

	/**
	 * Override refreshToken to include subscription check
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

		// Call parent implementation for API key handling
		return super.refreshToken(account, clientId);
	}

	/**
	 * Override processResponse to handle subscription-specific responses
	 */
	async processResponse(
		response: Response,
		account: Account | null,
	): Promise<Response> {
		// Check if this is a subscription usage request
		if (account && account.provider === "nanogpt") {
			// Check if we need to validate subscription status
			// For now, just pass through the response
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
			// If we can't check the subscription, assume it's not usable
			return false;
		}

		const rateLimitInfo = await this.getRateLimitInfo(account);
		return !rateLimitInfo.isRateLimited;
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
}
