import type { Database } from "bun:sqlite";
import { Config } from "@better-ccflare/config";
import { registerHeartbeat, requestEvents } from "@better-ccflare/core";
import { DatabaseOperations } from "@better-ccflare/database";
import { Logger } from "@better-ccflare/logger";
import { createOAuthFlow } from "@better-ccflare/oauth-flow";
import {
	fetchUsageData,
	generatePKCE,
	getProvider,
} from "@better-ccflare/providers";
import type { Account } from "@better-ccflare/types";
import { getValidAccessToken } from "./handlers";
import type { ProxyContext } from "./proxy";

/**
 * Try to open the user's default browser with the given URL.
 * Returns true on success, false otherwise.
 */
async function openBrowser(url: string): Promise<boolean> {
	try {
		// Try to use the open package if available
		const { default: open } = await import("open");
		await open(url, { wait: false });
		return true;
	} catch (_err) {
		// Fallback – platform-specific browser opening
		try {
			if (process.platform === "win32") {
				// Use powershell -Command Start-Process 'url'
				const { spawn } = await import("node:child_process");
				spawn(
					"powershell.exe",
					["-NoProfile", "-Command", "Start-Process", `'${url}'`],
					{
						detached: true,
						stdio: "ignore",
					},
				).unref();
			} else if (process.platform === "darwin") {
				const { spawn } = await import("node:child_process");
				spawn("open", [url], { detached: true, stdio: "ignore" }).unref();
			} else {
				// Linux generic fallback
				const { spawn } = await import("node:child_process");
				spawn("xdg-open", [url], { detached: true, stdio: "ignore" }).unref();
			}
			return true;
		} catch {
			return false;
		}
	}
}

const log = new Logger("AutoRefreshScheduler");

/**
 * Auto-refresh scheduler that monitors accounts with auto-refresh enabled
 * and sends dummy messages when their usage window resets
 */
export class AutoRefreshScheduler {
	private db: Database;
	private proxyContext: ProxyContext;
	private unregisterInterval: (() => void) | null = null;
	private checkInterval = 60000; // Check every minute
	// Track the rate_limit_reset timestamp for each account when we last refreshed it
	// This allows us to detect when a new window has started (different rate_limit_reset)
	private lastRefreshResetTime: Map<string, number> = new Map();
	// Prevent concurrent refresh operations using a Promise-based mutex
	private refreshMutex: Promise<void> | null = null;
	private refreshMutexResolver: (() => void) | null = null;
	// Track consecutive failure counts for accounts to identify consistently failing ones
	private consecutiveFailures: Map<string, number> = new Map();
	// Threshold for marking an account as needing re-authentication
	private readonly FAILURE_THRESHOLD = 5;

	constructor(db: Database, proxyContext: ProxyContext) {
		this.db = db;
		this.proxyContext = proxyContext;
	}

	/**
	 * Initiate OAuth reauthentication for an expired token
	 * @returns true if reauthentication was initiated successfully, false otherwise
	 */
	private async initiateOAuthReauth(accountRow: {
		id: string;
		name: string;
		provider: string;
		refresh_token: string;
		access_token: string | null;
		expires_at: number | null;
		rate_limit_reset: number | null;
		custom_endpoint: string | null;
	}): Promise<boolean> {
		try {
			log.info(
				`Initiating OAuth reauthentication for account: ${accountRow.name}`,
			);

			// Create a local callback URL using the server's port
			const protocol =
				process.env.SSL_KEY_PATH && process.env.SSL_CERT_PATH
					? "https"
					: "http";
			const port = this.proxyContext.runtime.port;
			const redirectUri = `${protocol}://localhost:${port}/oauth/callback`;

			// Initialize OAuth flow
			const config = new Config();
			const dbOps = new DatabaseOperations();
			const _oauthFlow = await createOAuthFlow(dbOps, config);

			// Generate PKCE challenge
			const pkce = await generatePKCE();

			// Get OAuth provider with local redirect URI
			const oauthProvider = await import("@better-ccflare/providers").then(
				(m) => m.getOAuthProvider("anthropic"),
			);
			if (!oauthProvider) {
				log.error(`OAuth provider not found for account ${accountRow.name}`);
				return false;
			}

			const runtime = config.getRuntime();
			const oauthConfig = oauthProvider.getOAuthConfig(
				"claude-oauth",
				redirectUri,
			);
			oauthConfig.clientId = runtime.clientId;

			// Generate authorization URL
			const authUrl = oauthProvider.generateAuthUrl(oauthConfig, pkce);

			// Create OAuth session in database
			const sessionId = crypto.randomUUID();
			dbOps.createOAuthSession(
				sessionId,
				accountRow.name,
				pkce.verifier,
				"claude-oauth",
				accountRow.custom_endpoint || "",
				10, // 10 minute TTL
			);

			// Open browser for user authorization
			log.info(
				`Opening browser for OAuth reauthentication of account: ${accountRow.name}`,
			);
			log.info(`Please authorize the request in your browser.`);

			// Try to open browser using cross-platform utility
			const browserOpened = await openBrowser(authUrl);
			if (!browserOpened) {
				log.warn(
					`Failed to open browser automatically. Please manually visit: ${authUrl}`,
				);
				log.info(
					`After authorizing, you'll be redirected to the local callback endpoint automatically.`,
				);
			}

			log.info(
				`OAuth reauthentication initiated for account: ${accountRow.name}`,
			);
			log.info(`The browser will redirect to: ${redirectUri}`);
			log.info(
				`After successful authorization, the tokens will be updated automatically.`,
			);

			return true;
		} catch (error) {
			log.error(
				`Failed to initiate OAuth reauthentication for account ${accountRow.name}:`,
				error,
			);
			return false;
		}
	}

	/**
	 * Start the auto-refresh scheduler
	 */
	start(): void {
		if (this.unregisterInterval) {
			log.warn("Auto-refresh scheduler already running");
			return;
		}

		log.info("Starting auto-refresh scheduler");
		this.unregisterInterval = registerHeartbeat({
			id: "auto-refresh-scheduler",
			callback: () => this.checkAndRefresh(),
			seconds: Math.floor(this.checkInterval / 1000),
			description: "Auto-refresh scheduler for account usage windows",
		});

		// Run immediately on start
		this.checkAndRefresh();
	}

	/**
	 * Stop the auto-refresh scheduler
	 */
	stop(): void {
		if (this.unregisterInterval) {
			this.unregisterInterval();
			this.unregisterInterval = null;
			log.info("Auto-refresh scheduler stopped");
		}
		// Clear the tracking maps to free memory
		this.lastRefreshResetTime.clear();
		this.consecutiveFailures.clear();
	}

	/**
	 * Check for accounts that need auto-refresh and send dummy messages
	 */
	private async checkAndRefresh(): Promise<void> {
		// Use a mutex to prevent concurrent refresh operations
		if (this.refreshMutex) {
			log.debug(
				"Auto-refresh check skipped - previous check still in progress",
			);
			return;
		}

		// Create a new mutex promise to indicate we're currently refreshing
		const mutexPromise = new Promise<void>((resolve) => {
			this.refreshMutexResolver = resolve;
		});
		this.refreshMutex = mutexPromise;

		try {
			// Check if database is available
			if (!this.db) {
				log.warn("Database not available for auto-refresh check");
				return;
			}

			const now = Date.now();
			const nowStr = new Date(now).toISOString();
			log.info(`Starting auto-refresh check at ${nowStr}`);
			console.log(`[${nowStr}] Starting auto-refresh check`);

			// Periodically clean up the tracking map - remove entries for accounts that no longer exist
			// or have auto-refresh disabled
			this.cleanupTracking();

			// Get all accounts with auto-refresh enabled
			const allAccountsQuery = this.db.query<
				{
					id: string;
					name: string;
					provider: string;
					refresh_token: string;
					access_token: string | null;
					expires_at: number | null;
					rate_limit_reset: number | null;
					custom_endpoint: string | null;
					auto_refresh_enabled: number;
				},
				[]
			>(
				`
				SELECT
					id, name, provider, refresh_token, access_token,
					expires_at, rate_limit_reset, custom_endpoint, auto_refresh_enabled
				FROM accounts
				WHERE provider = 'anthropic'
				ORDER BY name
			`,
			);

			const allAccounts = allAccountsQuery.all();
			log.info(`Found ${allAccounts.length} total Anthropic accounts`);
			console.log(`[${nowStr}] Found ${allAccounts.length} total Anthropic accounts`);

			// Log status of all accounts
			allAccounts.forEach((account) => {
				const minutesUntilExpiry = account.expires_at ? (account.expires_at - now) / (1000 * 60) : null;
				const minutesUntilReset = account.rate_limit_reset ? (account.rate_limit_reset - now) / (1000 * 60) : null;
				const autoRefreshEnabled = account.auto_refresh_enabled === 1;

				log.info(
					`Account ${account.name}: ` +
					`auto_refresh=${autoRefreshEnabled}, ` +
					`token=${account.access_token ? 'valid' : 'null'}, ` +
					`expires_in=${minutesUntilExpiry ? minutesUntilExpiry.toFixed(1) : 'null'}min, ` +
					`rate_reset_in=${minutesUntilReset ? minutesUntilReset.toFixed(1) : 'null'}min`
				);
				console.log(
					`[${nowStr}] Account ${account.name}: ` +
					`auto_refresh=${autoRefreshEnabled}, ` +
					`token=${account.access_token ? 'valid' : 'null'}, ` +
					`expires_in=${minutesUntilExpiry ? minutesUntilExpiry.toFixed(1) : 'null'}min, ` +
					`rate_reset_in=${minutesUntilReset ? minutesUntilReset.toFixed(1) : 'null'}min`
				);
			});

			// Get accounts that meet refresh criteria
			const query = this.db.query<
				{
					id: string;
					name: string;
					provider: string;
					refresh_token: string;
					access_token: string | null;
					expires_at: number | null;
					rate_limit_reset: number | null;
					custom_endpoint: string | null;
				},
				[number, number, number]
			>(
				`
				SELECT
					id, name, provider, refresh_token, access_token,
					expires_at, rate_limit_reset, custom_endpoint
				FROM accounts
				WHERE
					auto_refresh_enabled = 1
					AND provider = 'anthropic'
					AND (
						-- Usage window reset
						(rate_limit_reset IS NOT NULL AND rate_limit_reset <= ?)
						OR rate_limit_reset IS NULL
						OR rate_limit_reset < (? - 24 * 60 * 60 * 1000) -- Reset time is more than 24h old (stale)
						OR (expires_at IS NOT NULL AND expires_at <= ?) -- Token expired or will expire within buffer
					)
			`,
			);

			const accounts = query.all(now, now, now);

			log.info(
				`Auto-refresh check found ${accounts.length} account(s) meeting refresh criteria`,
			);

			if (accounts.length === 0) {
				log.info("No accounts require refresh at this time");
				return;
			}

			// Log detailed information about accounts being considered
			accounts.forEach((account) => {
				const minutesUntilExpiry = account.expires_at ? (account.expires_at - now) / (1000 * 60) : null;
				const minutesUntilReset = account.rate_limit_reset ? (account.rate_limit_reset - now) / (1000 * 60) : null;

				log.info(
					`Considering account ${account.name}: ` +
					`expires_in=${minutesUntilExpiry ? minutesUntilExpiry.toFixed(1) : 'null'}min, ` +
					`rate_reset_in=${minutesUntilReset ? minutesUntilReset.toFixed(1) : 'null'}min, ` +
					`reset_time=${account.rate_limit_reset ? new Date(account.rate_limit_reset).toISOString() : "null"}`
				);
			});

			// Separate accounts into two categories: window refresh and token expiration
			const accountsForWindowRefresh = accounts.filter((account) =>
				this.shouldRefreshWindow(account, now),
			);
			const accountsWithExpiredTokens = accounts.filter((account) =>
				this.isTokenExpired(account, now),
			);

			log.info(
				`Account categorization: ${accountsForWindowRefresh.length} for window refresh, ` +
				`${accountsWithExpiredTokens.length} for token reauthentication`
			);
			console.log(
				`[${nowStr}] Account categorization: ${accountsForWindowRefresh.length} for window refresh, ` +
				`${accountsWithExpiredTokens.length} for token reauthentication`
			);

			// Handle window refresh accounts
			if (accountsForWindowRefresh.length > 0) {
				log.info(
					`Processing ${accountsForWindowRefresh.length} account(s) for window refresh`,
				);
				log.info(`Accounts: ${accountsForWindowRefresh.map(a => a.name).join(', ')}`);

				// Send dummy message to each account
				// The sendDummyMessage method will update lastRefreshResetTime with the NEW rate_limit_reset from the API
				for (const accountRow of accountsForWindowRefresh) {
					await this.sendDummyMessage(accountRow);
				}
			}

			// Handle expired token accounts
			if (accountsWithExpiredTokens.length > 0) {
				log.info(
					`Processing ${accountsWithExpiredTokens.length} account(s) for OAuth reauthentication`,
				);
				log.info(`Accounts: ${accountsWithExpiredTokens.map(a => a.name).join(', ')}`);

				// Initiate OAuth reauthentication for each account with expired tokens
				for (const accountRow of accountsWithExpiredTokens) {
					await this.initiateOAuthReauth(accountRow);
				}
			}

			if (
				accountsForWindowRefresh.length === 0 &&
				accountsWithExpiredTokens.length === 0
			) {
				log.info("Auto-refresh check completed - no actions required");
				return;
			}

			log.info("Auto-refresh check completed successfully");
		} catch (error) {
			if (error instanceof Error) {
				const errorMessage = `Error in auto-refresh check: ${error.name}: ${error.message}`;
				log.error(errorMessage);
				if (error.stack) {
					// Log the stack trace separately to ensure it's visible
					console.error(`Auto-refresh stack trace: ${error.stack}`);
				}
			} else if (error !== undefined && error !== null) {
				log.error(`Error in auto-refresh check: ${JSON.stringify(error)}`);
			} else {
				log.error(
					"Error in auto-refresh check: Unknown error (possibly undefined or null)",
				);
			}
		} finally {
			// Resolve the mutex to indicate the refresh operation is complete
			if (this.refreshMutexResolver) {
				this.refreshMutexResolver();
				this.refreshMutexResolver = null;
			}
			this.refreshMutex = null;
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

			log.info(
				`Current token expires at: ${accountRow.expires_at ? new Date(accountRow.expires_at).toISOString() : "null"}`,
			);
			log.info(`Current time: ${new Date().toISOString()}`);
			log.info(`Access token available: ${!!accountRow.access_token}`);
			log.info(`Refresh token available: ${!!accountRow.refresh_token}`);

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
				paused: false,
				rate_limit_reset: accountRow.rate_limit_reset,
				rate_limit_status: null,
				rate_limit_remaining: null,
				priority: 0,
				auto_fallback_enabled: false,
				auto_refresh_enabled: true,
				custom_endpoint: accountRow.custom_endpoint,
				model_mappings: null,
			};

			// Emit request start event for analytics
			const requestId = crypto.randomUUID();
			const timestamp = Date.now();
			requestEvents.emit("event", {
				type: "start",
				id: requestId,
				timestamp,
				method: "POST",
				path: "/v1/messages",
				accountId: account.id,
				statusCode: 0, // Will be updated later
				agentUsed: null,
			});

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

			// Send request through proxy with special header to force specific account usage
			// This ensures proper request handling and analytics while using the correct account
			const proxyPort = this.proxyContext.runtime.port;
			// Determine protocol based on SSL configuration
			const protocol =
				process.env.SSL_KEY_PATH && process.env.SSL_CERT_PATH
					? "https"
					: "http";
			const endpoint = `${protocol}://localhost:${proxyPort}/v1/messages`;

			// Use same headers as normal Claude Code CLI requests, plus the special account ID header
			const headers = new Headers({
				accept: "application/json",
				"accept-language": "*",
				"anthropic-beta":
					"oauth-2025-04-20,fine-grained-tool-streaming-2025-05-14",
				"anthropic-dangerous-direct-browser-access": "true",
				"anthropic-version": "2023-06-01",
				connection: "keep-alive",
				"content-type": "application/json",
				"sec-fetch-mode": "cors",
				"user-agent": "claude-cli/2.0.28 (external, cli)",
				"x-app": "cli",
				"x-stainless-arch": "x64",
				"x-stainless-helper-method": "stream",
				"x-stainless-lang": "js",
				"x-stainless-os": "Linux",
				"x-stainless-package-version": "0.60.0",
				"x-stainless-retry-count": "0",
				"x-stainless-runtime": "node",
				"x-stainless-runtime-version": "v24.9.0",
				"x-stainless-timeout": "600",
				// CRITICAL: Force the proxy to use this specific account
				"x-better-ccflare-account-id": account.id,
				// CRITICAL: Bypass session tracking for auto-refresh messages
				"x-better-ccflare-bypass-session": "true",
			});

			// Try sending with multiple models if needed
			let response: Response | null = null;
			let lastError: Error | null = null;
			let modelToTry = "claude-haiku-4-5-20251001"; // Default model
			const models = [
				"claude-haiku-4-5-20251001",
				"claude-3-5-haiku-20241022",
				"claude-3-haiku-20240307",
				"claude-3-5-sonnet-20241022",
				"claude-3-sonnet-20240229",
			];

			for (const model of models) {
				try {
					modelToTry = model; // Update the model being tried
					log.info(
						`Attempting auto-refresh for ${accountRow.name} with model: ${modelToTry} to endpoint: ${endpoint}`,
					);

					const requestBody = {
						model: modelToTry,
						max_tokens: 10,
						messages: [
							{
								role: "user",
								content: randomMessage,
							},
						],
					};

					log.debug(
						`Auto-refresh request payload: ${JSON.stringify(requestBody, null, 2)}`,
					);
					log.debug(
						`Auto-refresh headers: ${JSON.stringify(Object.fromEntries(headers.entries()), null, 2)}`,
					);

					response = await fetch(endpoint, {
						method: "POST",
						headers,
						body: JSON.stringify(requestBody),
					});

					log.debug(
						`Auto-refresh response status: ${response.status} ${response.statusText}`,
					);

					// If we get a successful response, break out of the loop
					if (response.ok || response.status !== 404) {
						break;
					}

					// If model not found (404), try next model
					if (response.status === 404) {
						log.debug(
							`Model ${modelToTry} not found for ${accountRow.name}, trying next model`,
						);
					}
				} catch (fetchError) {
					lastError = fetchError as Error;
					log.debug(
						`Network error with model ${modelToTry} for ${accountRow.name}:`,
						fetchError,
					);
				}
			}

			// If we couldn't get any successful response
			if (!response) {
				const errorMsg = lastError?.message || "All models failed";
				log.error(
					`Failed to send auto-refresh message to ${accountRow.name} with any model: ${errorMsg}`,
				);
				return false;
			}

			// Handle authentication errors specifically
			if (response.status === 401) {
				log.warn(
					`Authentication failed for account ${accountRow.name} - token expired, initiating OAuth reauthentication`,
				);

				// Try to parse the error response for more details
				let errorBody = "";
				try {
					errorBody = await response.text();
					log.debug(`Authentication error response: ${errorBody}`);
				} catch {
					log.debug(
						`Could not read error response body for ${accountRow.name}`,
					);
				}

				// Check if we should initiate OAuth reauthentication (only for Anthropic OAuth accounts)
				const currentFailures =
					this.consecutiveFailures.get(accountRow.id) || 0;

				// Initiate OAuth reauthentication immediately for expired tokens
				log.info(
					`Initiating automatic OAuth reauthentication for account ${accountRow.name} (failure count: ${currentFailures + 1})`,
				);

				const reauthSuccess = await this.initiateOAuthReauth(accountRow);

				if (reauthSuccess) {
					// Reset failure counter on successful reauthentication initiation
					this.consecutiveFailures.delete(accountRow.id);
					log.info(
						`OAuth reauthentication initiated successfully for account ${accountRow.name}`,
					);
				} else {
					// Track failures if reauthentication failed to start
					const newFailures = currentFailures + 1;
					this.consecutiveFailures.set(accountRow.id, newFailures);

					log.error(
						`Failed to initiate OAuth reauthentication for account ${accountRow.name} (${newFailures}/${this.FAILURE_THRESHOLD} failures)`,
					);

					// If failure threshold is reached, log a special message to alert admins
					if (newFailures >= this.FAILURE_THRESHOLD) {
						log.error(
							`Account ${accountRow.name} has failed ${newFailures} consecutive OAuth reauthentication attempts - manual intervention required! Please run: bun run cli --reauthenticate ${accountRow.name}`,
						);
					}
				}

				return false; // Return false since the dummy message failed, but reauthentication may be in progress
			}

			if (response.ok) {
				log.info(
					`Auto-refresh message sent successfully for account: ${accountRow.name}`,
				);

				// Log the response for debugging
				let responseText = "";
				try {
					responseText = await response.text();
					log.info(
						`Auto-refresh response for ${accountRow.name}: ${responseText}`,
					);
				} catch (e) {
					log.warn(`Could not read response body for ${accountRow.name}: ${e}`);
				}

				// Use the provider's parseRateLimit method to get unified rate limit info
				const rateLimitInfo = provider.parseRateLimit(response);

				// Update rate limit fields from unified headers
				if (rateLimitInfo.resetTime) {
					this.db.run(
						"UPDATE accounts SET rate_limit_reset = ?, rate_limited_until = NULL WHERE id = ?",
						[rateLimitInfo.resetTime, accountRow.id],
					);

					// Update our tracking with the NEW rate_limit_reset from the API
					this.lastRefreshResetTime.set(accountRow.id, rateLimitInfo.resetTime);

					log.info(
						`Updated rate_limit_reset for ${accountRow.name} to ${new Date(rateLimitInfo.resetTime).toISOString()}`,
					);
					log.info(
						`Cleared rate_limited_until for ${accountRow.name} as account has been refreshed`,
					);
				} else {
					// Even if no reset time is provided, clear rate_limited_until as the refresh was successful
					// Also make sure to clear any existing rate_limited_until value to ensure the account is not stuck
					this.db.run(
						"UPDATE accounts SET rate_limited_until = NULL WHERE id = ?",
						[accountRow.id],
					);
					log.info(
						`Cleared rate_limited_until for ${accountRow.name} as account has been refreshed (no new reset time)`,
					);
				}

				if (rateLimitInfo.statusHeader) {
					this.db.run(
						"UPDATE accounts SET rate_limit_status = ? WHERE id = ?",
						[rateLimitInfo.statusHeader, accountRow.id],
					);
					log.info(
						`Updated rate_limit_status for ${accountRow.name} to ${rateLimitInfo.statusHeader}`,
					);
				}

				if (rateLimitInfo.remaining !== undefined) {
					this.db.run(
						"UPDATE accounts SET rate_limit_remaining = ? WHERE id = ?",
						[rateLimitInfo.remaining, accountRow.id],
					);
					log.info(
						`Updated rate_limit_remaining for ${accountRow.name} to ${rateLimitInfo.remaining}`,
					);
				}

				// Fetch usage data from the OAuth usage endpoint to get 5h window info
				// Get the access token for this account
				const accessToken = await getValidAccessToken(
					account,
					this.proxyContext,
				);
				if (accessToken) {
					const usageData = await fetchUsageData(accessToken);
					if (usageData) {
						log.info(
							`Fetched usage data for ${accountRow.name}: 5h=${usageData.five_hour.utilization}%, 7d=${usageData.seven_day.utilization}%`,
						);
					} else {
						log.warn(
							`Failed to fetch usage data for ${accountRow.name} after auto-refresh`,
						);
					}
				}

				// Reset consecutive failure counter on successful refresh
				if (this.consecutiveFailures.has(accountRow.id)) {
					this.consecutiveFailures.delete(accountRow.id);
					log.debug(
						`Reset consecutive failure counter for account ${accountRow.name} after successful auto-refresh`,
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

			// Track consecutive failures for this account (for non-401 errors too)
			const currentFailures = this.consecutiveFailures.get(accountRow.id) || 0;
			const newFailures = currentFailures + 1;
			this.consecutiveFailures.set(accountRow.id, newFailures);

			log.warn(
				`Account ${accountRow.name} has failed ${newFailures} consecutive auto-refresh attempts (non-401 error). Threshold is ${this.FAILURE_THRESHOLD}.`,
			);

			// If failure threshold is reached, log a special message to alert admins
			if (newFailures >= this.FAILURE_THRESHOLD) {
				log.error(
					`Account ${accountRow.name} has failed ${newFailures} consecutive auto-refresh attempts - this account may need attention! Please check account status.`,
				);
			}

			return false;
		} catch (error) {
			if (error instanceof Error) {
				const errorMessage = `Error sending auto-refresh message to account ${accountRow.name}: ${error.name}: ${error.message}`;
				log.error(errorMessage);
				if (error.stack) {
					// Log the stack trace separately to ensure it's visible
					console.error(
						`Auto-refresh stack trace for ${accountRow.name}: ${error.stack}`,
					);
				}
			} else if (error !== undefined && error !== null) {
				log.error(
					`Error sending auto-refresh message to account ${accountRow.name}: ${JSON.stringify(error)}`,
				);
			} else {
				log.error(
					`Error sending auto-refresh message to account ${accountRow.name}: Unknown error (possibly undefined or null)`,
				);
			}

			// Track consecutive failures for this account (for exceptions too)
			const currentFailures = this.consecutiveFailures.get(accountRow.id) || 0;
			const newFailures = currentFailures + 1;
			this.consecutiveFailures.set(accountRow.id, newFailures);

			log.warn(
				`Account ${accountRow.name} has failed ${newFailures} consecutive auto-refresh attempts (exception). Threshold is ${this.FAILURE_THRESHOLD}.`,
			);

			// If failure threshold is reached, log a special message to alert admins
			if (newFailures >= this.FAILURE_THRESHOLD) {
				log.error(
					`Account ${accountRow.name} has failed ${newFailures} consecutive auto-refresh attempts - this account may need attention! Please check account status.`,
				);
			}

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

			// Remove entries from the maps that are not in the active set
			for (const accountId of this.lastRefreshResetTime.keys()) {
				if (!activeAccountIdSet.has(accountId)) {
					this.lastRefreshResetTime.delete(accountId);
					log.debug(
						`Removed tracking entry for account ${accountId} (no longer exists or auto-refresh disabled)`,
					);
				}
			}

			// Also clean up consecutive failures for non-active accounts
			for (const accountId of this.consecutiveFailures.keys()) {
				if (!activeAccountIdSet.has(accountId)) {
					this.consecutiveFailures.delete(accountId);
					log.debug(
						`Removed consecutive failure tracking for account ${accountId} (no longer exists or auto-refresh disabled)`,
					);
				}
			}
		} catch (error) {
			if (error instanceof Error) {
				const errorMessage = `Error cleaning up tracking map: ${error.name}: ${error.message}`;
				log.error(errorMessage);
				if (error.stack) {
					// Log the stack trace separately to ensure it's visible
					console.error(`Tracking map cleanup stack trace: ${error.stack}`);
				}
			} else if (error !== undefined && error !== null) {
				log.error(`Error cleaning up tracking map: ${JSON.stringify(error)}`);
			} else {
				log.error(
					"Error cleaning up tracking map: Unknown error (possibly undefined or null)",
				);
			}
			// Don't throw - this is a non-critical cleanup operation
		}
	}

	/**
	 * Determine if an account should be refreshed based on its reset time and tracking state
	 * @param account - The account to check
	 * @param now - The current timestamp
	 * @returns true if the account should be refreshed, false otherwise
	 */
	private shouldRefreshWindow(
		account: {
			id: string;
			name: string;
			provider: string;
			refresh_token: string;
			access_token: string | null;
			expires_at: number | null;
			rate_limit_reset: number | null;
			custom_endpoint: string | null;
		},
		now: number,
	): boolean {
		const lastResetTime = this.lastRefreshResetTime.get(account.id);

		// If we've never refreshed this account before, refresh it
		if (!lastResetTime) {
			log.info(`First-time refresh for account: ${account.name}`);
			return true;
		}

		// If no rate_limit_reset is available, skip
		if (!account.rate_limit_reset) {
			return false;
		}

		// Check if the reset time has passed - we need to refresh to get the next window's reset time
		const resetTimeHasPassed = account.rate_limit_reset <= now;
		if (resetTimeHasPassed) {
			log.info(
				`New window detected for account ${account.name}: reset time ${new Date(account.rate_limit_reset).toISOString()} has passed (now: ${new Date(now).toISOString()}), last refresh was at ${new Date(lastResetTime).toISOString()}`,
			);
			return true;
		}

		// Check if the database has a newer reset time than what we last refreshed
		// This handles the case where an external request updated the reset time
		const isNewerThanLastRefresh = account.rate_limit_reset > lastResetTime;
		if (isNewerThanLastRefresh) {
			log.info(
				`New window detected for account ${account.name}: current reset ${new Date(account.rate_limit_reset).toISOString()} > last refresh ${new Date(lastResetTime).toISOString()}`,
			);
			return true;
		}

		// Check if the reset time is very old (more than 24 hours) - this indicates a stale reset time that needs refresh
		const oneDayAgo = Date.now() - 24 * 60 * 60 * 1000;
		if (account.rate_limit_reset < oneDayAgo) {
			log.info(
				`Stale reset time detected for account ${account.name}: ${new Date(account.rate_limit_reset).toISOString()} is more than 24h old, forcing refresh`,
			);
			return true;
		}

		// The window hasn't renewed yet - skip
		log.debug(
			`No new window for account ${account.name}: current reset ${new Date(account.rate_limit_reset).toISOString()}, last refresh ${new Date(lastResetTime).toISOString()}, now ${new Date(now).toISOString()}`,
		);
		return false;
	}

	/**
	 * Determine if an account's OAuth token is expired or needs reauthentication
	 * @param account - The account to check
	 * @param now - The current timestamp
	 * @returns true if the token is expired and needs reauthentication, false otherwise
	 */
	private isTokenExpired(
		account: {
			id: string;
			name: string;
			provider: string;
			refresh_token: string;
			access_token: string | null;
			expires_at: number | null;
			rate_limit_reset: number | null;
			custom_endpoint: string | null;
		},
		now: number,
	): boolean {
		// If no expires_at is set, assume token is valid
		if (!account.expires_at) {
			log.debug(`Account ${account.name}: No expiration time set, assuming valid token`);
			return false;
		}

		// Check if token is expired (with 5-minute buffer to refresh before actual expiration)
		const expirationBuffer = 5 * 60 * 1000; // 5 minutes
		const isExpired = account.expires_at <= now + expirationBuffer;
		const minutesUntilExpiry = (account.expires_at - now) / (1000 * 60);
		const minutesUntilBuffer = (account.expires_at - (now + expirationBuffer)) / (1000 * 60);

		log.info(
			`Account ${account.name}: Token expires at ${new Date(account.expires_at).toISOString()}, ` +
			`currently ${new Date(now).toISOString()}, ` +
			`${minutesUntilExpiry.toFixed(1)} minutes until expiry, ` +
			`${minutesUntilBuffer.toFixed(1)} minutes until buffer expiry`
		);

		// Also log to console for immediate visibility
		console.log(
			`[${new Date().toISOString()}] Account ${account.name}: ` +
			`Token expires in ${minutesUntilExpiry.toFixed(1)}min, ` +
			`buffer expires in ${minutesUntilBuffer.toFixed(1)}min`
		);

		if (isExpired) {
			log.warn(
				`Token expired or expiring soon for account ${account.name}: ` +
				`expires at ${new Date(account.expires_at).toISOString()}, ` +
				`now ${new Date(now).toISOString()}, ` +
				`buffer: ${expirationBuffer / (1000 * 60)} minutes`
			);
		}

		return isExpired;
	}
}
