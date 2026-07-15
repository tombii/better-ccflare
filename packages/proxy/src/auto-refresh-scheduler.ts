import {
	authFailureEvents,
	CLAUDE_MODEL_IDS,
	getClientVersion,
	registerHeartbeat,
	requestEvents,
} from "@better-ccflare/core";
import type { BunSqlAdapter } from "@better-ccflare/database";
import { Logger } from "@better-ccflare/logger";
import { fetchUsageData, getProvider } from "@better-ccflare/providers";
import type { Account } from "@better-ccflare/types";
import { TOKEN_SAFETY_WINDOW_MS } from "./constants";
import { extractAuthFailureReason, getValidAccessToken } from "./handlers";
import type { ProxyContext } from "./proxy";

const log = new Logger("AutoRefreshScheduler");

function isZaiPeakHour(ts = Date.now()): boolean {
	const d = new Date(ts);
	const sgtHour = (d.getUTCHours() + d.getUTCMinutes() / 60 + 8) % 24;
	return sgtHour >= 14 && sgtHour < 18;
}

/**
 * Auto-refresh scheduler that monitors accounts with auto-refresh enabled
 * and sends dummy messages when their usage window resets
 */
export class AutoRefreshScheduler {
	private db: BunSqlAdapter;
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
	// Timestamp (ms) of the last probe sent to a failure_threshold-paused account.
	// Re-probing is throttled to once per FAILURE_PROBE_COOLDOWN_MS so a genuinely
	// dead endpoint isn't hit every 60s (#199), while still letting the account
	// self-recover automatically instead of getting stuck in API ERROR (#262).
	private lastFailureProbeAt: Map<string, number> = new Map();
	private readonly FAILURE_PROBE_COOLDOWN_MS = 10 * 60 * 1000; // 10 minutes

	constructor(db: BunSqlAdapter, proxyContext: ProxyContext) {
		this.db = db;
		this.proxyContext = proxyContext;
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
		this.lastFailureProbeAt.clear();
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

			// Periodically clean up the tracking map - remove entries for accounts that no longer exist
			// or have auto-refresh disabled
			await this.cleanupTracking();

			await this.checkPeakHoursPause();

			// Get all accounts with auto-refresh enabled that have reset windows OR need immediate refresh
			const accounts = await this.db.query<{
				id: string;
				name: string;
				provider: string;
				refresh_token: string;
				access_token: string | null;
				expires_at: number | null;
				rate_limit_reset: number | null;
				custom_endpoint: string | null;
				paused: number;
				auto_pause_on_overage_enabled: number;
				pause_reason: string | null;
			}>(
				`
				SELECT
					id, name, provider, refresh_token, access_token,
					expires_at, rate_limit_reset, custom_endpoint,
					COALESCE(paused, 0) as paused,
					COALESCE(auto_pause_on_overage_enabled, 0) as auto_pause_on_overage_enabled,
					pause_reason
				FROM accounts
				WHERE
					auto_refresh_enabled = 1
					AND provider IN ('anthropic', 'codex', 'zai')
					AND COALESCE(requires_reauth, 0) = 0
					AND (
						(rate_limit_reset IS NOT NULL AND rate_limit_reset <= ?)
						OR rate_limit_reset IS NULL
						OR rate_limit_reset < (? - 24 * 60 * 60 * 1000)
					)
					-- Skip accounts that are still inside an active per-account cooldown.
					-- ccflare already knows upstream will reject us until rate_limited_until,
					-- so probing during that window is a guaranteed-fail call that wastes
					-- quota, re-applies the same cooldown, and pollutes the request log
					-- with synthetic 503s (issue #199, bug 1).
					AND (
						rate_limited_until IS NULL OR rate_limited_until <= ?
					)
					-- Probe a paused account only if it can be auto-resumed. Overage pauses
					-- (auto_pause_on_overage_enabled=1) resume on window reset. failure_threshold
					-- pauses (set by this scheduler after FAILURE_THRESHOLD consecutive refresh
					-- failures) MUST be re-probed on a cooldown so they can self-recover —
					-- otherwise they're stuck in API ERROR until a human clicks Force Refresh
					-- (issue #262). The per-account re-probe cooldown is enforced in
					-- shouldRefreshAccount. Manual and peak_hours pauses are left alone.
					-- These criteria MUST stay in sync with the resume guard in sendDummyMessage.
					AND (
						COALESCE(paused, 0) = 0
						OR (
							COALESCE(auto_pause_on_overage_enabled, 0) = 1
							AND (pause_reason IS NULL OR pause_reason = 'overage')
						)
						OR pause_reason = 'failure_threshold'
					)
			`,
				[now, now, now],
			);

			log.debug(
				`Auto-refresh check found ${accounts.length} account(s) to consider`,
			);

			if (accounts.length === 0) {
				return;
			}

			// Log accounts being considered
			accounts.forEach((account) => {
				log.debug(
					`Considering account: ${account.name}, reset_time: ${account.rate_limit_reset ? new Date(Number(account.rate_limit_reset)).toISOString() : "null"}`,
				);
			});

			// Filter accounts: only refresh if this is a NEW window
			// We detect a new window by comparing the current rate_limit_reset with the one we stored when we last refreshed
			const accountsToRefresh = accounts.filter((account) =>
				this.shouldRefreshAccount(account, now),
			);

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

			// Proactively refresh OpenAI-compatible OAuth tokens expiring within the safety window
			await this.checkAndRefreshOpenAICompatibleOAuthTokens();

			// Proactively refresh Codex OAuth tokens expiring within the safety window
			await this.checkAndRefreshCodexTokens();
		} catch (error) {
			if (error instanceof Error) {
				const errorMessage = `Error in auto-refresh check: ${error.name}: ${error.message}`;
				log.error(errorMessage);
				if (error.stack) {
					// Log the stack trace separately to ensure it's visible
					log.error(`Auto-refresh stack trace: ${error.stack}`);
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
		paused: number;
		auto_pause_on_overage_enabled: number;
		pause_reason: string | null;
	}): Promise<boolean> {
		try {
			log.info(`Sending auto-refresh message to account: ${accountRow.name}`);

			// Record the probe timestamp for failure_threshold accounts so the
			// cooldown in shouldRefreshAccount suppresses re-probes for the next
			// FAILURE_PROBE_COOLDOWN_MS (#262).
			if (accountRow.pause_reason === "failure_threshold") {
				this.lastFailureProbeAt.set(accountRow.id, Date.now());
			}

			const provider = getProvider(accountRow.provider);
			if (!provider) {
				log.error(
					`No provider found for ${accountRow.provider} (account: ${accountRow.name})`,
				);
				return false;
			}

			log.info(
				`Current token expires at: ${accountRow.expires_at ? new Date(Number(accountRow.expires_at)).toISOString() : "null"}`,
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
				expires_at: accountRow.expires_at
					? Number(accountRow.expires_at)
					: null,
				request_count: 0,
				total_requests: 0,
				last_used: null,
				created_at: 0,
				rate_limited_until: null,
				rate_limited_reason: null,
				rate_limited_at: null,
				session_start: null,
				session_request_count: 0,
				paused: false,
				requires_reauth: false,
				rate_limit_reset: accountRow.rate_limit_reset
					? Number(accountRow.rate_limit_reset)
					: null,
				rate_limit_status: null,
				rate_limit_remaining: null,
				priority: 0,
				auto_fallback_enabled: false,
				auto_refresh_enabled: true,
				auto_pause_on_overage_enabled: false,
				peak_hours_pause_enabled: false,
				custom_endpoint: accountRow.custom_endpoint,
				model_mappings: null,
				cross_region_mode: null,
				model_fallbacks: null,
				billing_type: null,
				pause_reason: null,
				refresh_token_issued_at: null,
				consecutive_rate_limits: 0,
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
				"user-agent": `claude-cli/${getClientVersion()} (external, cli)`,
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
				// Tag the request as a synthetic auto-refresh probe so downstream
				// pipeline layers can distinguish it from real user traffic
				// (cache-body-store skips staging for these, request logging
				// and pool-exhausted 503 metrics filter them out — issue #199,
				// bug 2). Mirrors the existing x-better-ccflare-keepalive
				// pattern used by cache-keepalive-scheduler.ts.
				"x-better-ccflare-auto-refresh": "true",
			});

			// Try sending with multiple models if needed
			let response: Response | null = null;
			let lastError: Error | null = null;
			let modelToTry: string = CLAUDE_MODEL_IDS.HAIKU_4_5; // Default model
			const models = [
				CLAUDE_MODEL_IDS.HAIKU_4_5,
				CLAUDE_MODEL_IDS.SONNET_4_5,
				CLAUDE_MODEL_IDS.SONNET_4,
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
						signal: AbortSignal.timeout(30000),
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
				log.error(
					`❌ AUTHENTICATION FAILED: Account "${accountRow.name}" needs manual reauthentication`,
				);

				log.error(
					`⚠️  Token refresh failed for account "${accountRow.name}" - both access token and refresh token are invalid`,
				);

				log.error(
					`🔧 MANUAL ACTION REQUIRED: Please run the following command to reauthenticate:`,
				);
				log.error(`   bun run cli --reauthenticate "${accountRow.name}"`);

				log.error(
					`📋 Alternative: You can also reauthenticate through the web dashboard at http://localhost:${this.proxyContext.runtime.port}/`,
				);

				// Mark account as needing attention in database (disable auto-refresh to prevent repeated failures)
				await this.db.run(
					`UPDATE accounts SET auto_refresh_enabled = 0, expires_at = 0 WHERE id = ?`,
					[accountRow.id],
				);

				log.error(
					`🚫 Auto-refresh has been DISABLED for account "${accountRow.name}" until reauthentication is completed`,
				);
				log.error(
					`💡 Re-enable auto-refresh after reauthentication with: bun run cli --auto-refresh "${accountRow.name}"`,
				);

				return false;
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
					await this.db.run(
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
					await this.db.run(
						"UPDATE accounts SET rate_limited_until = NULL WHERE id = ?",
						[accountRow.id],
					);
					log.info(
						`Cleared rate_limited_until for ${accountRow.name} as account has been refreshed (no new reset time)`,
					);
				}

				if (rateLimitInfo.statusHeader) {
					await this.db.run(
						"UPDATE accounts SET rate_limit_status = ? WHERE id = ?",
						[rateLimitInfo.statusHeader, accountRow.id],
					);
					log.info(
						`Updated rate_limit_status for ${accountRow.name} to ${rateLimitInfo.statusHeader}`,
					);
				}

				if (rateLimitInfo.remaining !== undefined) {
					await this.db.run(
						"UPDATE accounts SET rate_limit_remaining = ? WHERE id = ?",
						[rateLimitInfo.remaining, accountRow.id],
					);
					log.info(
						`Updated rate_limit_remaining for ${accountRow.name} to ${rateLimitInfo.remaining}`,
					);
				}

				// Auto-resume on a successful probe. failure_threshold-paused accounts
				// (set by this scheduler after repeated refresh failures) resume as soon
				// as a probe succeeds — the endpoint works again (#262). Overage-paused
				// accounts resume when the window resets. Manual and peak_hours pauses are
				// never auto-resumed.
				if (
					accountRow.paused === 1 &&
					accountRow.pause_reason === "failure_threshold"
				) {
					log.info(
						`Auto-resuming account '${accountRow.name}' — failure_threshold cleared after successful probe`,
					);
					await this.db.run(
						"UPDATE accounts SET paused = 0, pause_reason = NULL WHERE id = ?",
						[accountRow.id],
					);
					this.lastFailureProbeAt.delete(accountRow.id);
				} else if (
					accountRow.auto_pause_on_overage_enabled === 1 &&
					accountRow.paused === 1 &&
					(!accountRow.pause_reason || accountRow.pause_reason === "overage")
				) {
					log.debug(
						`Auto-resuming account '${accountRow.name}' after window reset (auto-pause-on-overage enabled)`,
					);
					await this.db.run(
						"UPDATE accounts SET paused = 0, pause_reason = NULL WHERE id = ?",
						[accountRow.id],
					);
				}

				if (accountRow.provider === "anthropic") {
					// Fetch usage data from the OAuth usage endpoint to get 5h window info
					// Get the access token for this account
					const accessToken = await getValidAccessToken(
						account,
						this.proxyContext,
					);
					if (accessToken) {
						const { data: usageData } = await fetchUsageData(accessToken);
						if (usageData) {
							log.info(
								`Fetched usage data for ${accountRow.name}: 5h=${usageData.five_hour?.utilization ?? "?"}%, 7d=${usageData.seven_day?.utilization ?? "?"}%`,
							);
							this.proxyContext.dbOps
								.recordUsageSnapshot(accountRow.id, usageData, Date.now())
								.catch((err) =>
									log.warn(
										`Failed to record usage snapshot for ${accountRow.name}: ${err}`,
									),
								);
						} else {
							log.warn(
								`Failed to fetch usage data for ${accountRow.name} after auto-refresh`,
							);
						}
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
			await this.recordRefreshFailure(
				accountRow.id,
				accountRow.name,
				"(non-401 error)",
			);

			return false;
		} catch (error) {
			if (error instanceof Error) {
				const errorMessage = `Error sending auto-refresh message to account ${accountRow.name}: ${error.name}: ${error.message}`;
				log.error(errorMessage);
				if (error.stack) {
					// Log the stack trace separately to ensure it's visible
					log.error(
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
			await this.recordRefreshFailure(
				accountRow.id,
				accountRow.name,
				"(exception)",
			);

			return false;
		}
	}

	/**
	 * Records a consecutive auto-refresh failure for an account. When the
	 * FAILURE_THRESHOLD is reached the account is paused in the database so
	 * that the request router skips it until an operator resumes it.
	 */
	private async recordRefreshFailure(
		accountId: string,
		accountName: string,
		context: string,
	): Promise<void> {
		const currentFailures = this.consecutiveFailures.get(accountId) || 0;
		const newFailures = currentFailures + 1;
		this.consecutiveFailures.set(accountId, newFailures);

		log.warn(
			`Account ${accountName} has failed ${newFailures} consecutive auto-refresh attempts ${context}. Threshold is ${this.FAILURE_THRESHOLD}.`,
		);

		if (newFailures >= this.FAILURE_THRESHOLD) {
			log.error(
				`Account ${accountName} has failed ${newFailures} consecutive auto-refresh attempts — pausing account to prevent routing to a broken endpoint.`,
			);
			try {
				await this.db.run(
					`UPDATE accounts SET paused = 1, pause_reason = 'failure_threshold' WHERE id = ?`,
					[accountId],
				);
				// Clear the counter so subsequent scheduler cycles don't fire redundant DB
				// writes and log entries — the account is already paused.
				this.consecutiveFailures.delete(accountId);
				log.error(
					`Account "${accountName}" has been PAUSED. Resume with: bun run cli --resume "${accountName}"`,
				);
			} catch (dbErr) {
				log.error(`Failed to pause account ${accountName} in database:`, dbErr);
			}
		}
	}

	/**
	 * Proactively refresh OpenAI-compatible OAuth access tokens that are expiring within the safety window.
	 * Unlike Anthropic accounts (which use dummy messages to reset rate-limit windows),
	 * these providers only need the OAuth token refreshed — no dummy message required.
	 */
	private async checkAndRefreshOpenAICompatibleOAuthTokens(): Promise<void> {
		if (!this.db) return;

		const now = Date.now();
		const expiryThreshold = now + TOKEN_SAFETY_WINDOW_MS;

		const accounts = await this.db.query<{
			id: string;
			name: string;
			provider: string;
			refresh_token: string;
			access_token: string | null;
			expires_at: number | null;
			custom_endpoint: string | null;
		}>(
			`
			SELECT id, name, provider, refresh_token, access_token, expires_at, custom_endpoint
			FROM accounts
			WHERE
				provider IN ('qwen', 'xai')
				AND refresh_token IS NOT NULL
				-- Never probe an account already flagged for manual re-auth: its
				-- refresh token is known dead, so the probe is a guaranteed fail and
				-- recovery is only the manual re-auth clear-site.
				AND COALESCE(requires_reauth, 0) = 0
				AND (
					access_token IS NULL
					OR expires_at IS NULL
					OR expires_at <= ?
				)
		`,
			[expiryThreshold],
		);

		if (accounts.length === 0) return;

		log.info(
			`Proactive OpenAI-compatible OAuth token refresh: ${accounts.length} account(s) need refresh`,
		);

		for (const row of accounts) {
			// Skip if a refresh is already in-flight for this account (deduplication)
			if (this.proxyContext.refreshInFlight.has(row.id)) {
				log.debug(
					`Skipping proactive ${row.provider} refresh for ${row.name} — refresh already in-flight`,
				);
				continue;
			}

			try {
				log.info(`Refreshing ${row.provider} token for account: ${row.name}`);

				const provider = getProvider(row.provider);
				if (!provider) {
					log.error(
						`No provider found for ${row.provider} (account: ${row.name})`,
					);
					continue;
				}

				const account: Account = {
					id: row.id,
					name: row.name,
					provider: row.provider,
					api_key: null,
					refresh_token: row.refresh_token,
					access_token: row.access_token,
					expires_at: row.expires_at,
					request_count: 0,
					total_requests: 0,
					last_used: null,
					created_at: 0,
					rate_limited_until: null,
					rate_limited_reason: null,
					rate_limited_at: null,
					session_start: null,
					session_request_count: 0,
					paused: false,
					requires_reauth: false,
					rate_limit_reset: null,
					rate_limit_status: null,
					rate_limit_remaining: null,
					priority: 0,
					auto_fallback_enabled: false,
					auto_refresh_enabled: true,
					auto_pause_on_overage_enabled: false,
					peak_hours_pause_enabled: false,
					custom_endpoint: row.custom_endpoint,
					model_mappings: null,
					cross_region_mode: null,
					model_fallbacks: null,
					billing_type: null,
					pause_reason: null,
					refresh_token_issued_at: null,
					consecutive_rate_limits: 0,
				};

				// Use refreshAccessTokenSafe to get deduplication and backoff handling
				const refreshPromise = provider
					.refreshToken(account, this.proxyContext.runtime.clientId)
					.then(async (result) => {
						const newRefreshToken = result.refreshToken ?? row.refresh_token;
						await this.db.run(
							`UPDATE accounts SET access_token = ?, expires_at = ?, refresh_token = ?, refresh_token_issued_at = ? WHERE id = ?`,
							[
								result.accessToken,
								result.expiresAt,
								newRefreshToken,
								Date.now(),
								row.id,
							],
						);
						log.info(
							`${row.provider} token refreshed for ${row.name}, expires at ${new Date(result.expiresAt).toISOString()}`,
						);
						return result.accessToken;
					})
					.finally(() => {
						this.proxyContext.refreshInFlight.delete(row.id);
					});

				this.proxyContext.refreshInFlight.set(row.id, refreshPromise);
				await refreshPromise;
			} catch (error) {
				log.error(
					`Failed to proactively refresh ${row.provider} token for ${row.name}:`,
					error,
				);
				await this.flagIfDefinitiveAuthFailure(error, row);
			}
		}
	}

	/**
	 * Proactively refresh Codex OAuth access tokens that are expiring within the safety window.
	 * Codex uses rotating refresh tokens, so each refresh returns a new refresh token.
	 */
	private async checkAndRefreshCodexTokens(): Promise<void> {
		if (!this.db) return;

		const now = Date.now();
		const expiryThreshold = now + TOKEN_SAFETY_WINDOW_MS;

		const accounts = await this.db.query<{
			id: string;
			name: string;
			provider: string;
			refresh_token: string;
			access_token: string | null;
			expires_at: number | null;
			custom_endpoint: string | null;
		}>(
			`
			SELECT id, name, provider, refresh_token, access_token, expires_at, custom_endpoint
			FROM accounts
			WHERE
				provider = 'codex'
				AND refresh_token IS NOT NULL
				-- Never probe an account already flagged for manual re-auth: its
				-- refresh token is known dead, so the probe is a guaranteed fail and
				-- recovery is only the manual re-auth clear-site.
				AND COALESCE(requires_reauth, 0) = 0
				AND (
					access_token IS NULL
					OR expires_at IS NULL
					OR expires_at <= ?
				)
		`,
			[expiryThreshold],
		);

		if (accounts.length === 0) return;

		log.info(
			`Proactive Codex token refresh: ${accounts.length} account(s) need refresh`,
		);

		for (const row of accounts) {
			// Skip if a refresh is already in-flight for this account (deduplication)
			if (this.proxyContext.refreshInFlight.has(row.id)) {
				log.debug(
					`Skipping proactive Codex refresh for ${row.name} — refresh already in-flight`,
				);
				continue;
			}

			try {
				log.info(`Refreshing Codex token for account: ${row.name}`);

				const provider = getProvider(row.provider);
				if (!provider) {
					log.error(`No provider found for codex (account: ${row.name})`);
					continue;
				}

				const account: Account = {
					id: row.id,
					name: row.name,
					provider: row.provider,
					api_key: null,
					refresh_token: row.refresh_token,
					access_token: row.access_token,
					expires_at: row.expires_at,
					request_count: 0,
					total_requests: 0,
					last_used: null,
					created_at: 0,
					rate_limited_until: null,
					rate_limited_reason: null,
					rate_limited_at: null,
					session_start: null,
					session_request_count: 0,
					paused: false,
					requires_reauth: false,
					rate_limit_reset: null,
					rate_limit_status: null,
					rate_limit_remaining: null,
					priority: 0,
					auto_fallback_enabled: false,
					auto_refresh_enabled: true,
					auto_pause_on_overage_enabled: false,
					peak_hours_pause_enabled: false,
					custom_endpoint: row.custom_endpoint,
					model_mappings: null,
					cross_region_mode: null,
					model_fallbacks: null,
					billing_type: null,
					pause_reason: null,
					refresh_token_issued_at: null,
					consecutive_rate_limits: 0,
				};

				// Register in refreshInFlight so concurrent request-triggered refreshes join this one
				const refreshPromise = provider
					.refreshToken(account, this.proxyContext.runtime.clientId)
					.then(async (result) => {
						const newRefreshToken = result.refreshToken ?? row.refresh_token;
						await this.db.run(
							`UPDATE accounts SET access_token = ?, expires_at = ?, refresh_token = ?, refresh_token_issued_at = ? WHERE id = ?`,
							[
								result.accessToken,
								result.expiresAt,
								newRefreshToken,
								Date.now(),
								row.id,
							],
						);
						log.info(
							`Codex token refreshed for ${row.name}, expires at ${new Date(result.expiresAt).toISOString()}`,
						);
						return result.accessToken;
					})
					.finally(() => {
						this.proxyContext.refreshInFlight.delete(row.id);
					});

				this.proxyContext.refreshInFlight.set(row.id, refreshPromise);
				await refreshPromise;
			} catch (error) {
				log.error(
					`Failed to proactively refresh Codex token for ${row.name}:`,
					error,
				);
				await this.flagIfDefinitiveAuthFailure(error, row);
			}
		}
	}

	/**
	 * Persist requires_reauth and emit an auth-failure alert when a proactive
	 * refresh fails with a DEFINITIVE dead-refresh-token signal (invalid_grant /
	 * invalid_refresh_token / refresh_token_reused).
	 *
	 * These proactive paths refresh via provider.refreshToken() directly, bypassing
	 * the token-manager funnel, so without this a qwen/xai/codex token that dies
	 * while only the scheduler touches it would evaporate silently — logged but
	 * never flagged, never pulled from routing, never alerted. Transient failures
	 * (network / 5xx / timeout) do not carry these codes and are left untouched so
	 * the account keeps retrying.
	 */
	private async flagIfDefinitiveAuthFailure(
		error: unknown,
		row: { id: string; name: string; provider: string },
	): Promise<void> {
		const message = error instanceof Error ? error.message : String(error);
		const reason = extractAuthFailureReason(message, row.name);
		if (!reason) return;

		try {
			await this.db.run(
				`UPDATE accounts SET requires_reauth = 1 WHERE id = ?`,
				[row.id],
			);
			log.error(
				`Account ${row.name} requires re-authentication — proactive ${row.provider} refresh returned ${reason}`,
			);
		} catch (writeError) {
			log.error(
				`Failed to persist requires_reauth for ${row.name}:`,
				writeError,
			);
		}

		// Emit regardless of the write outcome — the alert is the operator's only
		// signal that the account is dead, and it is fire-and-forget.
		authFailureEvents.emit("event", {
			accountId: row.id,
			accountName: row.name,
			provider: row.provider,
			reason,
		});
	}

	/**
	 * Clean up the tracking map by removing entries for accounts that no longer exist
	 * or have auto-refresh disabled
	 */
	private async cleanupTracking(): Promise<void> {
		try {
			// Check if database is available
			if (!this.db) {
				log.warn("Database not available for cleanup tracking");
				return;
			}

			// Get all account IDs that have auto-refresh enabled
			const rows = await this.db.query<{ id: string }>(
				`SELECT id FROM accounts WHERE auto_refresh_enabled = 1 AND provider IN ('anthropic', 'codex', 'zai')`,
			);

			const activeAccountIds = rows.map((row) => row.id);
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

			// Clean up failure-probe cooldown timestamps for non-active accounts
			for (const accountId of this.lastFailureProbeAt.keys()) {
				if (!activeAccountIdSet.has(accountId)) {
					this.lastFailureProbeAt.delete(accountId);
					log.debug(
						`Removed failure-probe cooldown tracking for account ${accountId} (no longer exists or auto-refresh disabled)`,
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
	 * Pause or resume zai accounts based on per-account peak_hours_pause_enabled flag.
	 * Only touches accounts that have opted in to peak hours auto-pause.
	 */
	private async checkPeakHoursPause(): Promise<void> {
		const inPeak = isZaiPeakHour();

		const zaiAccounts = await this.db.query<{
			id: string;
			name: string;
			paused: number;
			pause_reason: string | null;
			peak_hours_pause_enabled: number;
		}>(
			`SELECT id, name, COALESCE(paused, 0) as paused, pause_reason, COALESCE(peak_hours_pause_enabled, 0) as peak_hours_pause_enabled
			 FROM accounts WHERE provider = 'zai' AND peak_hours_pause_enabled = 1`,
		);

		for (const account of zaiAccounts) {
			if (inPeak && !account.paused) {
				// Pause account during peak hours
				// SQL-level guard prevents race: if another actor paused the account
				// with a different reason between SELECT and UPDATE, skip it
				await this.db.run(
					"UPDATE accounts SET paused = 1, pause_reason = 'peak_hours' WHERE id = ? AND COALESCE(paused, 0) = 0",
					[account.id],
				);
				log.info(`Peak hours pause: paused zai account '${account.name}'`);
			} else if (
				!inPeak &&
				account.paused &&
				account.pause_reason === "peak_hours"
			) {
				// Resume account after peak hours (only if we paused it)
				// SQL-level guard prevents race condition: if manual-pause API changed pause_reason
				// between SELECT and UPDATE, this UPDATE will not affect that account
				await this.db.run(
					"UPDATE accounts SET paused = 0, pause_reason = NULL WHERE id = ? AND pause_reason = 'peak_hours'",
					[account.id],
				);
				log.info(`Peak hours resume: resumed zai account '${account.name}'`);
			}
		}
	}

	/**
	 * Determine if an account should be refreshed based on its reset time and tracking state
	 * @param account - The account to check
	 * @param now - The current timestamp
	 * @returns true if the account should be refreshed, false otherwise
	 */
	private shouldRefreshAccount(
		account: {
			id: string;
			name: string;
			provider: string;
			refresh_token: string;
			access_token: string | null;
			expires_at: number | null;
			rate_limit_reset: number | null;
			custom_endpoint: string | null;
			paused: number;
			pause_reason: string | null;
		},
		now: number,
	): boolean {
		// Throttle re-probes of failure_threshold-paused accounts to once per
		// cooldown — avoids burning quota on a dead endpoint every 60s (#199)
		// while still letting it recover automatically (#262).
		if (account.pause_reason === "failure_threshold") {
			const lastProbe = this.lastFailureProbeAt.get(account.id);
			if (lastProbe && now - lastProbe < this.FAILURE_PROBE_COOLDOWN_MS) {
				log.debug(
					`Skipping failure_threshold probe for account ${account.name} — last probe ${Math.round((now - lastProbe) / 1000)}s ago, cooldown ${this.FAILURE_PROBE_COOLDOWN_MS / 1000}s`,
				);
				return false;
			}
			// Cooldown elapsed (or no prior probe) — probe immediately. We're
			// checking endpoint liveness, not whether a new usage window opened,
			// so bypass the normal rate_limit_reset window logic (which would
			// suppress re-probes while a prior window is still active).
			return true;
		}

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
				`New window detected for account ${account.name}: reset time ${new Date(Number(account.rate_limit_reset)).toISOString()} has passed (now: ${new Date(now).toISOString()}), last refresh was at ${new Date(lastResetTime).toISOString()}`,
			);
			return true;
		}

		// Check if the database has a newer reset time than what we last refreshed
		// This handles the case where an external request updated the reset time
		const isNewerThanLastRefresh = account.rate_limit_reset > lastResetTime;
		if (isNewerThanLastRefresh) {
			log.info(
				`New window detected for account ${account.name}: current reset ${new Date(Number(account.rate_limit_reset)).toISOString()} > last refresh ${new Date(lastResetTime).toISOString()}`,
			);
			return true;
		}

		// Check if the reset time is very old (more than 24 hours) - this indicates a stale reset time that needs refresh
		const oneDayAgo = Date.now() - 24 * 60 * 60 * 1000;
		if (account.rate_limit_reset < oneDayAgo) {
			log.info(
				`Stale reset time detected for account ${account.name}: ${new Date(Number(account.rate_limit_reset)).toISOString()} is more than 24h old, forcing refresh`,
			);
			return true;
		}

		// The window hasn't renewed yet - skip
		log.debug(
			`No new window for account ${account.name}: current reset ${new Date(Number(account.rate_limit_reset)).toISOString()}, last refresh ${new Date(lastResetTime).toISOString()}, now ${new Date(now).toISOString()}`,
		);
		return false;
	}
}
