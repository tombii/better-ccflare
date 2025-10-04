import type { Database } from "bun:sqlite";
import { Logger } from "@better-ccflare/logger";
import { getProvider } from "@better-ccflare/providers";
import type { Account } from "@better-ccflare/types";

const log = new Logger("AutoRefreshScheduler");

/**
 * Auto-refresh scheduler that monitors accounts with auto-refresh enabled
 * and sends dummy messages when their usage window resets
 */
export class AutoRefreshScheduler {
	private db: Database;
	private intervalId: Timer | null = null;
	private checkInterval = 60000; // Check every minute
	// Track the rate_limit_reset timestamp for each account when we last refreshed it
	// This allows us to detect when a new window has started (different rate_limit_reset)
	private lastRefreshResetTime: Map<string, number> = new Map();
	// Prevent concurrent refresh operations
	private isRefreshing = false;

	constructor(db: Database) {
		this.db = db;
	}

	/**
	 * Start the auto-refresh scheduler
	 */
	start(): void {
		if (this.intervalId) {
			log.warn("Auto-refresh scheduler already running");
			return;
		}

		log.info("Starting auto-refresh scheduler");
		this.intervalId = setInterval(() => {
			this.checkAndRefresh();
		}, this.checkInterval);

		// Run immediately on start
		this.checkAndRefresh();
	}

	/**
	 * Stop the auto-refresh scheduler
	 */
	stop(): void {
		if (this.intervalId) {
			clearInterval(this.intervalId);
			this.intervalId = null;
			log.info("Auto-refresh scheduler stopped");
		}
		// Clear the tracking map to free memory
		this.lastRefreshResetTime.clear();
	}

	/**
	 * Check for accounts that need auto-refresh and send dummy messages
	 */
	private async checkAndRefresh(): Promise<void> {
		// Prevent concurrent refresh operations
		if (this.isRefreshing) {
			log.debug(
				"Auto-refresh check skipped - previous check still in progress",
			);
			return;
		}

		this.isRefreshing = true;
		try {
			// Check if database is available
			if (!this.db) {
				log.warn("Database not available for auto-refresh check");
				return;
			}

			const now = Date.now();

			// Periodically clean up the tracking map - remove entries for accounts that no longer exist
			// or have auto-refresh disabled
			this.cleanupTracking();

			// Get all accounts with auto-refresh enabled that have reset windows
			const query = this.db.query<
				{
					id: string;
					name: string;
					provider: string;
					refresh_token: string;
					access_token: string | null;
					expires_at: number | null;
					rate_limit_reset: number | null;
					account_tier: number;
					custom_endpoint: string | null;
				},
				[number]
			>(
				`
				SELECT
					id, name, provider, refresh_token, access_token,
					expires_at, rate_limit_reset, account_tier, custom_endpoint
				FROM accounts
				WHERE
					auto_refresh_enabled = 1
					AND paused = 0
					AND provider = 'anthropic'
					AND rate_limit_reset IS NOT NULL
					AND rate_limit_reset <= ?
			`,
			);

			const accounts = query.all(now);

			if (accounts.length === 0) {
				return;
			}

			// Filter accounts: only refresh if this is a NEW window
			// We detect a new window by comparing the current rate_limit_reset with the one we stored when we last refreshed
			const accountsToRefresh = accounts.filter((account) => {
				const lastResetTime = this.lastRefreshResetTime.get(account.id);

				if (!lastResetTime) {
					// Never refreshed this account before - refresh it
					log.info(`First-time refresh for account: ${account.name}`);
					return true;
				}

				if (!account.rate_limit_reset) {
					// No rate_limit_reset available - skip
					return false;
				}

				// Check if the current rate_limit_reset from the database is NEWER than the one we stored when we last refreshed
				// This indicates that the usage window has renewed since our last refresh
				if (account.rate_limit_reset > lastResetTime) {
					// The window has renewed - time to refresh again
					log.info(
						`New window detected for account ${account.name}: current reset ${new Date(account.rate_limit_reset).toISOString()} > last refresh ${new Date(lastResetTime).toISOString()}`,
					);
					return true;
				}

				// The window hasn't renewed yet - skip
				log.debug(
					`No new window for account ${account.name}: current reset ${new Date(account.rate_limit_reset).toISOString()} <= last refresh ${new Date(lastResetTime).toISOString()}`,
				);
				return false;
			});

			if (accountsToRefresh.length === 0) {
				return;
			}

			log.info(
				`Found ${accountsToRefresh.length} account(s) with new windows for auto-refresh`,
			);

			// Send dummy message to each account
			// The sendDummyMessage method will update lastRefreshResetTime with the NEW rate_limit_reset from the API
			for (const accountRow of accountsToRefresh) {
				await this.sendDummyMessage(accountRow);
			}
		} catch (error) {
			log.error("Error in auto-refresh check:", error);
		} finally {
			this.isRefreshing = false;
		}
	}

	/**
	 * Send a dummy message to refresh the usage window for an account
	 * @returns true if the refresh was successful, false otherwise
	 */
	private async sendDummyMessage(accountRow: {
		id: string;
		name: string;
		provider: string;
		refresh_token: string;
		access_token: string | null;
		expires_at: number | null;
		rate_limit_reset: number | null;
		account_tier: number;
		custom_endpoint: string | null;
	}): Promise<boolean> {
		try {
			log.info(`Sending auto-refresh message to account: ${accountRow.name}`);

			const provider = getProvider(accountRow.provider);
			if (!provider) {
				log.error(
					`No provider found for ${accountRow.provider} (account: ${accountRow.name})`,
				);
				return false;
			}

			// Create a minimal account object
			const account: Account = {
				id: accountRow.id,
				name: accountRow.name,
				provider: accountRow.provider,
				api_key: null,
				refresh_token: accountRow.refresh_token,
				access_token: accountRow.access_token,
				expires_at: accountRow.expires_at,
				request_count: 0,
				total_requests: 0,
				last_used: null,
				created_at: 0,
				rate_limited_until: null,
				session_start: null,
				session_request_count: 0,
				account_tier: accountRow.account_tier,
				paused: false,
				rate_limit_reset: accountRow.rate_limit_reset,
				rate_limit_status: null,
				rate_limit_remaining: null,
				priority: 0,
				auto_fallback_enabled: false,
				auto_refresh_enabled: true,
				custom_endpoint: accountRow.custom_endpoint,
			};

			// Prepare dummy message request
			const dummyMessages = [
				"Write a hello world program in Python",
				"What is 2+2?",
				"Tell me a programmer joke",
				"What is the capital of France?",
				"Explain recursion in one sentence",
			];

			const randomMessage =
				dummyMessages[Math.floor(Math.random() * dummyMessages.length)];

			const endpoint =
				accountRow.custom_endpoint || "https://api.anthropic.com/v1/messages";

			const requestBody = {
				model: "claude-3-5-sonnet-20241022",
				max_tokens: 10,
				messages: [
					{
						role: "user",
						content: randomMessage,
					},
				],
			};

			// Use provider's prepareHeaders method for consistent authentication
			const headers = provider.prepareHeaders(
				new Headers({
					"Content-Type": "application/json",
					"anthropic-version": "2023-06-01",
				}),
				account.access_token || undefined,
				account.api_key || undefined,
			);

			// Send the request
			const response = await fetch(endpoint, {
				method: "POST",
				headers,
				body: JSON.stringify(requestBody),
			});

			if (response.ok) {
				log.info(
					`Auto-refresh message sent successfully for account: ${accountRow.name}`,
				);

				// Update the rate_limit_reset timestamp by reading response headers
				const rateLimitReset = response.headers.get("x-ratelimit-reset");
				if (rateLimitReset) {
					const resetTimestamp = new Date(rateLimitReset).getTime();
					this.db.run("UPDATE accounts SET rate_limit_reset = ? WHERE id = ?", [
						resetTimestamp,
						accountRow.id,
					]);

					// Update our tracking with the NEW rate_limit_reset from the API
					// This is the reset time for the window we just started
					this.lastRefreshResetTime.set(accountRow.id, resetTimestamp);

					log.info(
						`Updated rate_limit_reset for ${accountRow.name} to ${rateLimitReset}`,
					);
				}
				return true;
			}

			log.error(
				`Auto-refresh message failed for account ${accountRow.name}: ${response.status} ${response.statusText}`,
			);

			// Log response body for debugging
			try {
				const errorBody = await response.text();
				log.error(`Response body: ${errorBody}`);
			} catch {
				// Ignore error reading body
			}
			return false;
		} catch (error) {
			log.error(
				`Error sending auto-refresh message to account ${accountRow.name}:`,
				error,
			);
			return false;
		}
	}

	/**
	 * Clean up the tracking map by removing entries for accounts that no longer exist
	 * or have auto-refresh disabled
	 */
	private cleanupTracking(): void {
		try {
			// Check if database is available
			if (!this.db) {
				log.warn("Database not available for cleanup tracking");
				return;
			}

			// Get all account IDs that have auto-refresh enabled
			const query = this.db.query<{ id: string }, []>(
				`SELECT id FROM accounts WHERE auto_refresh_enabled = 1 AND provider = 'anthropic'`,
			);

			const activeAccountIds = query.all().map((row) => row.id);
			const activeAccountIdSet = new Set(activeAccountIds);

			// Remove entries from the map that are not in the active set
			for (const accountId of this.lastRefreshResetTime.keys()) {
				if (!activeAccountIdSet.has(accountId)) {
					this.lastRefreshResetTime.delete(accountId);
					log.debug(
						`Removed tracking entry for account ${accountId} (no longer exists or auto-refresh disabled)`,
					);
				}
			}
		} catch (error) {
			log.error("Error cleaning up tracking map:", error);
			// Don't throw - this is a non-critical cleanup operation
		}
	}
}
