import type { Database } from "bun:sqlite";
import * as cliCommands from "@better-ccflare/cli-commands";
import type { Config } from "@better-ccflare/config";
import {
	patterns,
	sanitizers,
	validateAndSanitizeModelMappings,
	validateNumber,
	validatePriority,
	validateString,
} from "@better-ccflare/core";
import type { DatabaseOperations } from "@better-ccflare/database";
import { ValidationError } from "@better-ccflare/errors";
import {
	BadRequest,
	errorResponse,
	InternalServerError,
	jsonResponse,
	NotFound,
} from "@better-ccflare/http-common";
import { Logger } from "@better-ccflare/logger";
import {
	fetchUsageData,
	getRepresentativeUtilization,
	getRepresentativeWindow,
	type UsageData,
	usageCache,
} from "@better-ccflare/providers";
import { clearAccountRefreshCache } from "@better-ccflare/proxy";
import type { FullUsageData } from "@better-ccflare/types";
import type { AccountResponse } from "../types";

const log = new Logger("AccountsHandler");

/**
 * Create an accounts list handler
 */
export function createAccountsListHandler(db: Database) {
	return async (): Promise<Response> => {
		const now = Date.now();
		const sessionDuration = 5 * 60 * 60 * 1000; // 5 hours

		const accounts = db
			.query(
				`
				SELECT
					id,
					name,
					provider,
					request_count,
					total_requests,
					last_used,
					created_at,
					expires_at,
					rate_limited_until,
					rate_limit_reset,
					rate_limit_status,
					rate_limit_remaining,
					session_start,
					session_request_count,
					refresh_token,
					access_token,
					COALESCE(paused, 0) as paused,
					COALESCE(priority, 0) as priority,
					COALESCE(auto_fallback_enabled, 0) as auto_fallback_enabled,
					COALESCE(auto_refresh_enabled, 0) as auto_refresh_enabled,
					custom_endpoint,
					model_mappings,
					CASE
						WHEN expires_at > ?1 THEN 1
						ELSE 0
					END as token_valid,
					CASE
						WHEN rate_limited_until > ?2 THEN 1
						ELSE 0
					END as rate_limited,
					CASE
						WHEN session_start IS NOT NULL AND ?3 - session_start < ?4 THEN
							'Active: ' || session_request_count || ' reqs'
						ELSE '-'
					END as session_info
				FROM accounts
				ORDER BY priority DESC, request_count DESC
				`,
			)
			.all(now, now, now, sessionDuration) as Array<{
			id: string;
			name: string;
			provider: string | null;
			request_count: number;
			total_requests: number;
			last_used: number | null;
			created_at: number;
			expires_at: number | null;
			rate_limited_until: number | null;
			rate_limit_reset: number | null;
			rate_limit_status: string | null;
			rate_limit_remaining: number | null;
			session_start: number | null;
			session_request_count: number;
			refresh_token: string;
			access_token: string | null;
			paused: 0 | 1;
			priority: number;
			token_valid: 0 | 1;
			rate_limited: 0 | 1;
			session_info: string | null;
			auto_fallback_enabled: 0 | 1;
			auto_refresh_enabled: 0 | 1;
			custom_endpoint: string | null;
			model_mappings: string | null;
		}>;

		// Fetch usage data for all Claude CLI OAuth accounts (those with refresh tokens)
		// API key accounts don't have usage tracking available
		const oauthAccounts = accounts.filter(
			(acc) =>
				acc.provider === "anthropic" &&
				acc.access_token &&
				acc.refresh_token &&
				acc.refresh_token !== acc.access_token, // Exclude API key accounts where they're the same
		);

		// Fetch usage data in parallel for all OAuth accounts that don't have fresh cache data
		// Cache is considered stale after 90 seconds (aligned with auto-refresh scheduler polling)
		const CACHE_FRESHNESS_THRESHOLD_MS = 90000;
		await Promise.all(
			oauthAccounts.map(async (account) => {
				// Check if we already have cached data and if it's still fresh
				const cacheAge = usageCache.getAge(account.id);
				const isCacheFresh =
					cacheAge !== null && cacheAge < CACHE_FRESHNESS_THRESHOLD_MS;

				if (!isCacheFresh && account.access_token) {
					// Fetch usage data if cache is stale or missing
					try {
						const usageData = await fetchUsageData(account.access_token);
						if (usageData) {
							// Update the cache using the public set method
							usageCache.set(account.id, usageData);
							log.debug(
								`Fetched usage data for ${account.name}: 5h=${usageData.five_hour.utilization}%, 7d=${usageData.seven_day.utilization}%`,
							);
						}
					} catch (error) {
						log.warn(
							`Failed to fetch usage data for account ${account.name}:`,
							error,
						);
					}
				}
			}),
		);

		const response: AccountResponse[] = accounts.map((account) => {
			let rateLimitStatus = "OK";

			// Use unified rate limit status if available
			if (account.rate_limit_status) {
				rateLimitStatus = account.rate_limit_status;
				if (account.rate_limit_reset && account.rate_limit_reset > now) {
					const minutesLeft = Math.ceil(
						(account.rate_limit_reset - now) / 60000,
					);
					rateLimitStatus = `${account.rate_limit_status} (${minutesLeft}m)`;
				}
			} else if (
				account.rate_limited &&
				account.rate_limited_until &&
				account.rate_limited_until > now
			) {
				// Fall back to legacy rate limit check
				const minutesLeft = Math.ceil(
					(account.rate_limited_until - now) / 60000,
				);
				rateLimitStatus = `Rate limited (${minutesLeft}m)`;
			}

			// Get usage data from cache for Anthropic and NanoGPT accounts
			const usageData = usageCache.get(account.id);
			let usageUtilization: number | null = null;
			let usageWindow: string | null = null;
			let fullUsageData: FullUsageData | null = null;

			if (account.provider === "anthropic" && usageData) {
				// Anthropic usage data - type guard to check it's UsageData
				const isAnthropicData =
					"five_hour" in usageData && "seven_day" in usageData;
				if (isAnthropicData) {
					try {
						usageUtilization = getRepresentativeUtilization(
							usageData as UsageData,
						);
						usageWindow = getRepresentativeWindow(usageData as UsageData);
						fullUsageData = usageData as FullUsageData;
					} catch (error) {
						// Log error but don't fail the entire accounts page
						log.warn(
							`Failed to process usage data for account ${account.id}:`,
							error instanceof Error ? error.message : String(error),
						);
						// Keep null values for usage if processing fails
					}
				}
			} else if (account.provider === "nanogpt" && usageData) {
				// NanoGPT usage data - type guard to check it's NanoGPTUsageData
				const isNanoGPTData =
					"active" in usageData &&
					"daily" in usageData &&
					"monthly" in usageData;
				if (isNanoGPTData) {
					try {
						const {
							getRepresentativeNanoGPTUtilization,
							getRepresentativeNanoGPTWindow,
						} = require("@better-ccflare/providers");
						usageUtilization = getRepresentativeNanoGPTUtilization(usageData);
						usageWindow = getRepresentativeNanoGPTWindow(usageData);
						fullUsageData = usageData as FullUsageData;
					} catch (error) {
						log.warn(
							`Failed to process NanoGPT usage data for account ${account.name}:`,
							error,
						);
					}
				}
			} else if (account.provider === "zai" && usageData) {
				// Zai usage data - type guard to check it's ZaiUsageData
				const isZaiData =
					"time_limit" in usageData || "tokens_limit" in usageData;
				if (isZaiData) {
					try {
						const {
							getRepresentativeZaiUtilization,
							getRepresentativeZaiWindow,
						} = require("@better-ccflare/providers");
						usageUtilization = getRepresentativeZaiUtilization(usageData);
						usageWindow = getRepresentativeZaiWindow(usageData);
						fullUsageData = usageData as FullUsageData;
					} catch (error) {
						log.warn(
							`Failed to process Zai usage data for account ${account.name}:`,
							error,
						);
					}
				}
			}

			// Parse model mappings for OpenAI-compatible, Anthropic-compatible, and NanoGPT providers
			let modelMappings: { [key: string]: string } | null = null;
			if (
				(account.provider === "openai-compatible" ||
					account.provider === "anthropic-compatible" ||
					account.provider === "nanogpt") &&
				account.model_mappings
			) {
				try {
					const parsed = JSON.parse(account.model_mappings);
					// Handle both formats: direct mappings or wrapped in modelMappings
					modelMappings = parsed.modelMappings || parsed || null;
				} catch {
					// If parsing fails, ignore model mappings
					modelMappings = null;
				}
			} else if (
				account.provider === "openai-compatible" &&
				account.custom_endpoint
			) {
				// Also try parsing from custom_endpoint for backwards compatibility
				try {
					const parsed = JSON.parse(account.custom_endpoint);
					if (parsed.modelMappings) {
						modelMappings = parsed.modelMappings;
					}
				} catch {
					// If parsing fails, ignore model mappings
					modelMappings = null;
				}
			}

			return {
				id: account.id,
				name: account.name,
				provider: account.provider || "anthropic",
				requestCount: account.request_count,
				totalRequests: account.total_requests,
				lastUsed: account.last_used
					? new Date(account.last_used).toISOString()
					: null,
				created: new Date(account.created_at).toISOString(),
				paused: account.paused === 1,
				priority: account.priority,
				tokenStatus: account.token_valid ? "valid" : "expired",
				tokenExpiresAt: account.expires_at
					? new Date(account.expires_at).toISOString()
					: null,
				rateLimitStatus,
				rateLimitReset: account.rate_limit_reset
					? new Date(account.rate_limit_reset).toISOString()
					: null,
				rateLimitRemaining: account.rate_limit_remaining,
				sessionInfo: account.session_info || "",
				autoFallbackEnabled: account.auto_fallback_enabled === 1,
				autoRefreshEnabled: account.auto_refresh_enabled === 1,
				customEndpoint: account.custom_endpoint,
				modelMappings,
				usageUtilization,
				usageWindow,
				usageData: fullUsageData, // Full usage data for UI
				hasRefreshToken: !!account.refresh_token, // OAuth accounts have refresh tokens
			};
		});

		return jsonResponse(response);
	};
}

/**
 * Create an account priority update handler
 */
export function createAccountPriorityUpdateHandler(dbOps: DatabaseOperations) {
	return async (req: Request, accountId: string): Promise<Response> => {
		try {
			const body = await req.json();

			// Validate priority input using the centralized validation function
			// Check if priority is provided (required)
			if (body.priority === undefined || body.priority === null) {
				return errorResponse(BadRequest("Priority is required"));
			}
			const priority = validatePriority(body.priority, "priority");

			// Check if account exists
			const db = dbOps.getDatabase();
			const account = db
				.query<{ id: string }, [string]>("SELECT id FROM accounts WHERE id = ?")
				.get(accountId);

			if (!account) {
				return errorResponse(NotFound("Account not found"));
			}

			dbOps.updateAccountPriority(accountId, priority);

			return jsonResponse({ success: true, priority });
		} catch (_error) {
			return errorResponse(
				InternalServerError("Failed to update account priority"),
			);
		}
	};
}

/**
 * Create an account add handler (manual token addition)
 * This is primarily used for adding accounts with existing tokens
 * For OAuth flow, use the OAuth handlers
 */
export function createAccountAddHandler(
	dbOps: DatabaseOperations,
	_config: Config,
) {
	return async (req: Request): Promise<Response> => {
		try {
			const body = await req.json();

			// Validate account name
			const name = validateString(body.name, "name", {
				required: true,
				minLength: 1,
				maxLength: 100,
				pattern: patterns.accountName,
				patternErrorMessage:
					"can only contain letters, numbers, spaces, hyphens, and underscores",
				transform: sanitizers.trim,
			});

			if (!name) {
				return errorResponse(BadRequest("Account name is required"));
			}

			// Validate tokens
			const accessToken = validateString(body.accessToken, "accessToken", {
				required: true,
				minLength: 1,
			});

			const refreshToken = validateString(body.refreshToken, "refreshToken", {
				required: true,
				minLength: 1,
			});

			if (!accessToken || !refreshToken) {
				return errorResponse(
					BadRequest("Access token and refresh token are required"),
				);
			}

			// Validate provider
			const provider =
				validateString(body.provider, "provider", {
					allowedValues: ["anthropic"] as const,
				}) || "anthropic";

			// Validate priority
			const priority =
				validateNumber(body.priority, "priority", {
					min: 0,
					max: 100,
					integer: true,
				}) || 0;

			// Validate custom endpoint
			// TODO: Support custom endpoints for Claude API (console) accounts for enterprise users
			// This is needed for enterprises that have their own Anthropic API deployments
			const customEndpoint = validateString(
				body.customEndpoint || null,
				"customEndpoint",
				{
					required: false,
					transform: (value: string) => {
						if (!value) return "";
						const trimmed = value.trim();
						if (!trimmed) return "";
						// Validate URL format
						try {
							new URL(trimmed);
							return trimmed;
						} catch {
							throw new Error("Invalid URL format");
						}
					},
				},
			);

			try {
				// Add account directly to database
				const accountId = crypto.randomUUID();
				const now = Date.now();

				dbOps.getDatabase().run(
					`INSERT INTO accounts (
						id, name, provider, refresh_token, access_token,
						created_at, request_count, total_requests, priority, custom_endpoint
					) VALUES (?, ?, ?, ?, ?, ?, 0, 0, ?, ?)`,
					[
						accountId,
						name,
						provider,
						refreshToken,
						accessToken,
						now,
						priority,
						customEndpoint || null,
					],
				);

				return jsonResponse({
					success: true,
					message: `Account ${name} added successfully`,
					priority,
					accountId,
				});
			} catch (error) {
				if (
					error instanceof Error &&
					error.message.includes("already exists")
				) {
					return errorResponse(BadRequest(error.message));
				}
				return errorResponse(InternalServerError((error as Error).message));
			}
		} catch (error) {
			log.error("Account add error:", error);
			return errorResponse(
				error instanceof Error ? error : new Error("Failed to add account"),
			);
		}
	};
}

/**
 * Create an account remove handler
 */
export function createAccountRemoveHandler(dbOps: DatabaseOperations) {
	return async (req: Request, accountName: string): Promise<Response> => {
		try {
			// Parse and validate confirmation
			const body = await req.json();

			// Validate confirmation string
			const confirm = validateString(body.confirm, "confirm", {
				required: true,
			});

			if (confirm !== accountName) {
				return errorResponse(
					BadRequest("Confirmation string does not match account name", {
						confirmationRequired: true,
					}),
				);
			}

			const result = cliCommands.removeAccount(dbOps, accountName);

			if (!result.success) {
				return errorResponse(NotFound(result.message));
			}

			// Find the account ID to clean up usage cache (check before deletion)
			const db = dbOps.getDatabase();
			const account = db
				.query<{ id: string }, [string]>(
					"SELECT id FROM accounts WHERE name = ?",
				)
				.get(accountName);

			if (account) {
				// Clear usage cache for removed account to prevent memory leaks
				usageCache.delete(account.id);
			}

			return jsonResponse({
				success: true,
				message: result.message,
			});
		} catch (error) {
			return errorResponse(
				error instanceof Error ? error : new Error("Failed to remove account"),
			);
		}
	};
}

/**
 * Create an account pause handler
 */
export function createAccountPauseHandler(dbOps: DatabaseOperations) {
	return async (_req: Request, accountId: string): Promise<Response> => {
		try {
			// Get account name by ID
			const db = dbOps.getDatabase();
			const account = db
				.query<{ name: string }, [string]>(
					"SELECT name FROM accounts WHERE id = ?",
				)
				.get(accountId);

			if (!account) {
				return errorResponse(NotFound("Account not found"));
			}

			const result = cliCommands.pauseAccount(dbOps, account.name);

			if (!result.success) {
				return errorResponse(BadRequest(result.message));
			}

			return jsonResponse({
				success: true,
				message: result.message,
			});
		} catch (error) {
			return errorResponse(
				error instanceof Error ? error : new Error("Failed to pause account"),
			);
		}
	};
}

/**
 * Create an account resume handler
 */
export function createAccountResumeHandler(dbOps: DatabaseOperations) {
	return async (_req: Request, accountId: string): Promise<Response> => {
		try {
			// Get account name by ID
			const db = dbOps.getDatabase();
			const account = db
				.query<{ name: string }, [string]>(
					"SELECT name FROM accounts WHERE id = ?",
				)
				.get(accountId);

			if (!account) {
				return errorResponse(NotFound("Account not found"));
			}

			const result = cliCommands.resumeAccount(dbOps, account.name);

			if (!result.success) {
				return errorResponse(BadRequest(result.message));
			}

			return jsonResponse({
				success: true,
				message: result.message,
			});
		} catch (error) {
			return errorResponse(
				error instanceof Error ? error : new Error("Failed to resume account"),
			);
		}
	};
}

/**
 * Create an account rename handler
 */
export function createAccountRenameHandler(dbOps: DatabaseOperations) {
	return async (req: Request, accountId: string): Promise<Response> => {
		try {
			const body = await req.json();

			// Validate new name
			const newName = validateString(body.name, "name", {
				required: true,
				minLength: 1,
				maxLength: 100,
				pattern: patterns.accountName,
				patternErrorMessage:
					"can only contain letters, numbers, spaces, hyphens, and underscores",
				transform: sanitizers.trim,
			});

			if (!newName) {
				return errorResponse(BadRequest("New account name is required"));
			}

			// Check if account exists
			const db = dbOps.getDatabase();
			const account = db
				.query<{ name: string }, [string]>(
					"SELECT name FROM accounts WHERE id = ?",
				)
				.get(accountId);

			if (!account) {
				return errorResponse(NotFound("Account not found"));
			}

			// Check if new name is already taken
			const existingAccount = db
				.query<{ id: string }, [string, string]>(
					"SELECT id FROM accounts WHERE name = ? AND id != ?",
				)
				.get(newName, accountId);

			if (existingAccount) {
				return errorResponse(
					BadRequest(`Account name '${newName}' is already taken`),
				);
			}

			// Rename the account
			dbOps.renameAccount(accountId, newName);

			return jsonResponse({
				success: true,
				message: `Account renamed from '${account.name}' to '${newName}'`,
				newName,
			});
		} catch (error) {
			log.error("Account rename error:", error);
			return errorResponse(
				error instanceof Error ? error : new Error("Failed to rename account"),
			);
		}
	};
}

/**
 * Create a z.ai account add handler
 */
export function createZaiAccountAddHandler(dbOps: DatabaseOperations) {
	return async (req: Request): Promise<Response> => {
		try {
			const body = await req.json();

			// Validate account name
			const name = validateString(body.name, "name", {
				required: true,
				minLength: 1,
				maxLength: 100,
				pattern: patterns.accountName,
				patternErrorMessage:
					"can only contain letters, numbers, spaces, hyphens, and underscores",
				transform: sanitizers.trim,
			});

			if (!name) {
				return errorResponse(BadRequest("Account name is required"));
			}

			// Validate API key
			const apiKey = validateString(body.apiKey, "apiKey", {
				required: true,
				minLength: 1,
			});

			if (!apiKey) {
				return errorResponse(BadRequest("API key is required"));
			}

			// Validate priority
			const priority =
				validateNumber(body.priority, "priority", {
					min: 0,
					max: 100,
					integer: true,
				}) || 0;

			// Validate custom endpoint
			const customEndpoint = validateString(
				body.customEndpoint || null,
				"customEndpoint",
				{
					required: false,
					transform: (value: string) => {
						if (!value) return "";
						const trimmed = value.trim();
						if (!trimmed) return "";
						// Validate URL format
						try {
							new URL(trimmed);
							return trimmed;
						} catch {
							throw new Error("Invalid URL format");
						}
					},
				},
			);

			// Create z.ai account directly in database
			const accountId = crypto.randomUUID();
			const now = Date.now();

			const db = dbOps.getDatabase();
			db.run(
				`INSERT INTO accounts (
					id, name, provider, api_key, refresh_token, access_token,
					expires_at, created_at, request_count, total_requests, priority, custom_endpoint
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				[
					accountId,
					name,
					"zai",
					apiKey,
					apiKey, // Use API key as refresh token for consistency with CLI
					apiKey, // Use API key as access token
					now + 365 * 24 * 60 * 60 * 1000, // 1 year from now
					now,
					0,
					0,
					priority,
					customEndpoint || null,
				],
			);

			log.info(
				`Successfully added z.ai account: ${name} (Priority ${priority})`,
			);

			// Get the created account for response
			const account = db
				.query<
					{
						id: string;
						name: string;
						provider: string;
						request_count: number;
						total_requests: number;
						last_used: number | null;
						created_at: number;
						expires_at: number;
						refresh_token: string;
						paused: number;
					},
					[string]
				>(
					`SELECT
						id, name, provider, request_count, total_requests,
						last_used, created_at, expires_at, refresh_token,
						COALESCE(paused, 0) as paused
					FROM accounts WHERE id = ?`,
				)
				.get(accountId);

			if (!account) {
				return errorResponse(
					InternalServerError("Failed to retrieve created account"),
				);
			}

			return jsonResponse({
				message: `z.ai account '${name}' added successfully`,
				account: {
					id: account.id,
					name: account.name,
					provider: account.provider,
					requestCount: account.request_count,
					totalRequests: account.total_requests,
					lastUsed: account.last_used
						? new Date(account.last_used).toISOString()
						: null,
					created: new Date(account.created_at).toISOString(),
					paused: account.paused === 1,
					priority: priority,
					tokenStatus: "valid" as const,
					tokenExpiresAt: new Date(account.expires_at).toISOString(),
					rateLimitStatus: "OK",
					rateLimitReset: null,
					rateLimitRemaining: null,
					sessionInfo: "No active session",
					hasRefreshToken: !!account.refresh_token, // OAuth accounts have refresh tokens
				},
			});
		} catch (error) {
			log.error("z.ai account creation error:", error);
			return errorResponse(
				error instanceof Error
					? error
					: new Error("Failed to create z.ai account"),
			);
		}
	};
}

/**
 * Create an OpenAI-compatible account add handler
 */
export function createOpenAIAccountAddHandler(dbOps: DatabaseOperations) {
	return async (req: Request): Promise<Response> => {
		try {
			const body = await req.json();

			// Validate account name
			const name = validateString(body.name, "name", {
				required: true,
				minLength: 1,
				maxLength: 100,
				pattern: patterns.accountName,
				patternErrorMessage:
					"can only contain letters, numbers, spaces, hyphens, and underscores",
				transform: sanitizers.trim,
			});

			if (!name) {
				return errorResponse(BadRequest("Account name is required"));
			}

			// Validate API key
			const apiKey = validateString(body.apiKey, "apiKey", {
				required: true,
				minLength: 1,
			});

			if (!apiKey) {
				return errorResponse(BadRequest("API key is required"));
			}

			// Validate custom endpoint (required for OpenAI-compatible)
			const customEndpoint = validateString(
				body.customEndpoint,
				"customEndpoint",
				{
					required: true,
					transform: (value: string) => {
						const trimmed = value.trim();
						// Validate URL format
						try {
							new URL(trimmed);
							return trimmed;
						} catch {
							throw new Error("Invalid URL format");
						}
					},
				},
			);

			if (!customEndpoint) {
				return errorResponse(BadRequest("Endpoint URL is required"));
			}

			// Validate priority
			const priority =
				validateNumber(body.priority, "priority", {
					min: 0,
					max: 100,
					integer: true,
				}) || 0;

			// Handle model mappings
			const modelMappings = body.modelMappings || {};
			const finalModelMappings =
				Object.keys(modelMappings).length > 0
					? JSON.stringify(modelMappings)
					: null;

			// Create account
			const accountId = crypto.randomUUID();
			const now = Date.now();

			const db = dbOps.getDatabase();
			db.run(
				`INSERT INTO accounts (
					id, name, provider, api_key, refresh_token, access_token,
					expires_at, created_at, request_count, total_requests, priority, custom_endpoint, model_mappings
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				[
					accountId,
					name,
					"openai-compatible",
					apiKey,
					apiKey, // Use API key as refresh token for consistency
					apiKey, // Use API key as access token
					now + 365 * 24 * 60 * 60 * 1000, // 1 year from now
					now,
					0,
					0,
					priority,
					customEndpoint,
					finalModelMappings,
				],
			);

			log.info(
				`Successfully added OpenAI-compatible account: ${name} (Endpoint: ${customEndpoint}, Priority ${priority})`,
			);

			// Get the created account for response
			const account = db
				.query<
					{
						id: string;
						name: string;
						provider: string;
						request_count: number;
						total_requests: number;
						last_used: number | null;
						created_at: number;
						expires_at: number;
						refresh_token: string;
						paused: number;
					},
					[string]
				>(
					`SELECT
						id, name, provider, request_count, total_requests,
						last_used, created_at, expires_at, refresh_token,
						COALESCE(paused, 0) as paused
					FROM accounts WHERE id = ?`,
				)
				.get(accountId);

			if (!account) {
				throw new Error("Failed to retrieve created account");
			}

			return jsonResponse({
				message: `OpenAI-compatible account '${name}' added successfully`,
				account: {
					id: account.id,
					name: account.name,
					provider: account.provider,
					requestCount: account.request_count,
					totalRequests: account.total_requests,
					lastUsed: account.last_used
						? new Date(account.last_used).toISOString()
						: null,
					created: new Date(account.created_at).toISOString(),
					paused: account.paused === 1,
					priority: priority,
					tokenStatus: "valid" as const,
					tokenExpiresAt: new Date(account.expires_at).toISOString(),
					rateLimitStatus: "OK",
					rateLimitReset: null,
					rateLimitRemaining: null,
					sessionInfo: "No active session",
					customEndpoint: customEndpoint,
					hasRefreshToken: !!account.refresh_token, // OAuth accounts have refresh tokens
				},
			});
		} catch (error) {
			log.error("OpenAI-compatible account creation error:", error);
			return errorResponse(
				error instanceof Error
					? error
					: new Error("Failed to create OpenAI-compatible account"),
			);
		}
	};
}

/**
 * Create a Minimax account add handler
 */
export function createVertexAIAccountAddHandler(dbOps: DatabaseOperations) {
	return async (req: Request): Promise<Response> => {
		try {
			const body = await req.json();

			// Validate account name
			const name = validateString(body.name, "name", {
				required: true,
				minLength: 1,
				maxLength: 100,
				pattern: patterns.accountName,
				patternErrorMessage:
					"can only contain letters, numbers, spaces, hyphens, and underscores",
				transform: sanitizers.trim,
			});

			if (!name) {
				return errorResponse(BadRequest("Account name is required"));
			}

			// Validate project ID
			const projectId = validateString(body.projectId, "projectId", {
				required: true,
				minLength: 1,
				transform: sanitizers.trim,
			});

			if (!projectId) {
				return errorResponse(BadRequest("Project ID is required"));
			}

			// Validate region
			const region = validateString(body.region, "region", {
				required: true,
				minLength: 1,
				transform: sanitizers.trim,
			});

			if (!region) {
				return errorResponse(BadRequest("Region is required"));
			}

			// Validate priority
			const priority = validatePriority(body.priority);

			// Store project ID and region in custom_endpoint as JSON
			const vertexConfig = JSON.stringify({
				projectId,
				region,
			});

			// Create Vertex AI account directly in database
			const accountId = crypto.randomUUID();
			const now = Date.now();
			const db = dbOps.getDatabase();
			db.run(
				`INSERT INTO accounts (
					id, name, provider, api_key, refresh_token, access_token,
					expires_at, created_at, request_count, total_requests, priority, custom_endpoint
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				[
					accountId,
					name,
					"vertex-ai",
					null, // No API key - uses Google Cloud credentials
					"", // Empty refresh token
					null, // Access token will be fetched on first use
					null, // Expiry will be set on first token refresh
					now,
					0,
					0,
					priority,
					vertexConfig,
				],
			);

			log.info(
				`Successfully added Vertex AI account: ${name} (Project: ${projectId}, Region: ${region}, Priority ${priority})`,
			);

			// Get the created account for response
			const account = db
				.query<
					{
						id: string;
						name: string;
						provider: string;
						request_count: number;
						total_requests: number;
						last_used: number | null;
						created_at: number;
						expires_at: number | null;
						refresh_token: string;
						paused: number;
					},
					[string]
				>(
					`SELECT
						id, name, provider, request_count, total_requests,
						last_used, created_at, expires_at, refresh_token,
						COALESCE(paused, 0) as paused
					FROM accounts WHERE id = ?`,
				)
				.get(accountId);

			if (!account) {
				return errorResponse(
					InternalServerError("Failed to retrieve created account"),
				);
			}

			return jsonResponse({
				message: `Vertex AI account '${name}' added successfully`,
				account: {
					id: account.id,
					name: account.name,
					provider: account.provider,
					request_count: account.request_count,
					total_requests: account.total_requests,
					last_used: account.last_used,
					created_at: new Date(account.created_at),
					expires_at: account.expires_at ? new Date(account.expires_at) : null,
					tokenStatus: "valid",
					mode: "vertex-ai",
					paused: account.paused === 1,
				},
			});
		} catch (error) {
			log.error("Failed to add Vertex AI account:", error);
			if (error instanceof ValidationError) {
				return errorResponse(BadRequest(error.message));
			}
			return errorResponse(
				InternalServerError(
					error instanceof Error ? error.message : "Failed to add account",
				),
			);
		}
	};
}

export function createMinimaxAccountAddHandler(dbOps: DatabaseOperations) {
	return async (req: Request): Promise<Response> => {
		try {
			const body = await req.json();

			// Validate account name
			const name = validateString(body.name, "name", {
				required: true,
				minLength: 1,
				maxLength: 100,
				pattern: patterns.accountName,
				patternErrorMessage:
					"can only contain letters, numbers, spaces, hyphens, and underscores",
				transform: sanitizers.trim,
			});

			if (!name) {
				return errorResponse(BadRequest("Account name is required"));
			}

			// Validate API key
			const apiKey = validateString(body.apiKey, "apiKey", {
				required: true,
				minLength: 1,
			});

			if (!apiKey) {
				return errorResponse(BadRequest("API key is required"));
			}

			// Validate priority
			const priority =
				validateNumber(body.priority, "priority", {
					min: 0,
					max: 100,
					integer: true,
				}) || 0;

			// Create Minimax account directly in database
			const accountId = crypto.randomUUID();
			const now = Date.now();
			const db = dbOps.getDatabase();
			db.run(
				`INSERT INTO accounts (
					id, name, provider, api_key, refresh_token, access_token,
					expires_at, created_at, request_count, total_requests, priority, custom_endpoint
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				[
					accountId,
					name,
					"minimax",
					apiKey,
					apiKey, // Use API key as refresh token for consistency with CLI
					apiKey, // Use API key as access token
					now + 365 * 24 * 60 * 60 * 1000, // 1 year from now
					now,
					0,
					0,
					priority,
					null, // No custom endpoint for Minimax
				],
			);

			log.info(
				`Successfully added Minimax account: ${name} (Priority ${priority})`,
			);

			// Get the created account for response
			const account = db
				.query<
					{
						id: string;
						name: string;
						provider: string;
						request_count: number;
						total_requests: number;
						last_used: number | null;
						created_at: number;
						expires_at: number;
						refresh_token: string;
						paused: number;
					},
					[string]
				>(
					`SELECT
						id, name, provider, request_count, total_requests,
						last_used, created_at, expires_at, refresh_token,
						COALESCE(paused, 0) as paused
					FROM accounts WHERE id = ?`,
				)
				.get(accountId);

			if (!account) {
				return errorResponse(
					InternalServerError("Failed to retrieve created account"),
				);
			}

			return jsonResponse({
				message: `Minimax account '${name}' added successfully`,
				account: {
					id: account.id,
					name: account.name,
					provider: account.provider,
					requestCount: account.request_count,
					totalRequests: account.total_requests,
					lastUsed: account.last_used
						? new Date(account.last_used).toISOString()
						: null,
					created: new Date(account.created_at).toISOString(),
					paused: account.paused === 1,
					priority: priority,
					tokenStatus: "valid" as const,
					tokenExpiresAt: new Date(account.expires_at).toISOString(),
					rateLimitStatus: "OK",
					rateLimitReset: null,
					rateLimitRemaining: null,
					sessionInfo: "No active session",
					hasRefreshToken: !!account.refresh_token, // OAuth accounts have refresh tokens
				},
			});
		} catch (error) {
			log.error("Minimax account creation error:", error);
			return errorResponse(
				error instanceof Error
					? error
					: new Error("Failed to create Minimax account"),
			);
		}
	};
}

/**
 * Create a NanoGPT account add handler
 */
export function createNanoGPTAccountAddHandler(dbOps: DatabaseOperations) {
	return async (req: Request): Promise<Response> => {
		try {
			const body = await req.json();
			// Validate account name
			const name = validateString(body.name, "name", {
				required: true,
				minLength: 1,
				maxLength: 100,
				pattern: patterns.accountName,
				patternErrorMessage:
					"can only contain letters, numbers, spaces, hyphens, and underscores",
				transform: sanitizers.trim,
			});
			if (!name) {
				return errorResponse(BadRequest("Account name is required"));
			}
			// Validate API key
			const apiKey = validateString(body.apiKey, "apiKey", {
				required: true,
				minLength: 1,
			});
			if (!apiKey) {
				return errorResponse(BadRequest("API key is required"));
			}
			// Validate priority
			const priority =
				validateNumber(body.priority, "priority", {
					min: 0,
					max: 100,
					integer: true,
				}) || 0;
			// Validate custom endpoint (optional for NanoGPT)
			const customEndpoint = validateString(
				body.customEndpoint || null,
				"customEndpoint",
				{
					required: false,
					transform: (value: string) => {
						if (!value) return "";
						const trimmed = value.trim();
						if (!trimmed) return "";
						// Validate URL format
						try {
							new URL(trimmed);
							return trimmed;
						} catch {
							throw new ValidationError("Invalid URL format");
						}
					},
				},
			);
			// Validate and sanitize model mappings (optional)
			let modelMappings = null;
			if (body.modelMappings) {
				if (typeof body.modelMappings !== "object") {
					throw new ValidationError("Model mappings must be an object");
				}
				try {
					const validatedMappings = validateAndSanitizeModelMappings(
						body.modelMappings,
					);
					// Only store if there are actual mappings (non-empty object)
					if (validatedMappings && Object.keys(validatedMappings).length > 0) {
						modelMappings = JSON.stringify(validatedMappings);
					}
				} catch (error) {
					if (error instanceof ValidationError) {
						throw error;
					}
					throw new ValidationError("Invalid model mappings format");
				}
			}
			// Create NanoGPT account directly in database
			const accountId = crypto.randomUUID();
			const now = Date.now();
			const db = dbOps.getDatabase();
			db.run(
				`INSERT INTO accounts (
					id, name, provider, api_key, refresh_token, access_token,
					expires_at, created_at, request_count, total_requests, priority, custom_endpoint, model_mappings
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				[
					accountId,
					name,
					"nanogpt",
					apiKey,
					apiKey, // Use API key as refresh token for consistency with CLI
					apiKey, // Use API key as access token
					now + 365 * 24 * 60 * 60 * 1000, // 1 year from now
					now,
					0,
					0,
					priority,
					customEndpoint || null,
					modelMappings,
				],
			);
			log.info(
				`Successfully added NanoGPT account: ${name} (Priority ${priority})`,
			);
			// Get the created account for response
			const account = db
				.query<
					{
						id: string;
						name: string;
						provider: string;
						request_count: number;
						total_requests: number;
						last_used: number | null;
						created_at: number;
						expires_at: number;
						refresh_token: string;
						paused: number;
					},
					[string]
				>(
					`SELECT
						id, name, provider, request_count, total_requests,
						last_used, created_at, expires_at, refresh_token,
						COALESCE(paused, 0) as paused
					FROM accounts WHERE id = ?`,
				)
				.get(accountId);
			if (!account) {
				return errorResponse(
					InternalServerError("Failed to retrieve created account"),
				);
			}
			return jsonResponse({
				message: `NanoGPT account '${name}' added successfully`,
				account: {
					id: account.id,
					name: account.name,
					provider: account.provider,
					requestCount: account.request_count,
					totalRequests: account.total_requests,
					lastUsed: account.last_used
						? new Date(account.last_used).toISOString()
						: null,
					created: new Date(account.created_at).toISOString(),
					paused: account.paused === 1,
					priority: priority,
					tokenStatus: "valid" as const,
					tokenExpiresAt: new Date(account.expires_at).toISOString(),
					rateLimitStatus: "OK",
					rateLimitReset: null,
					rateLimitRemaining: null,
					sessionInfo: "No active session",
					hasRefreshToken: !!account.refresh_token, // OAuth accounts have refresh tokens
				},
			});
		} catch (error) {
			log.error("NanoGPT account creation error:", error);
			if (error instanceof ValidationError) {
				return errorResponse(BadRequest(error.message));
			}
			return errorResponse(
				error instanceof Error
					? error
					: new Error("Failed to create NanoGPT account"),
			);
		}
	};
}

/**
 * Create an Anthropic-compatible account add handler
 */
export function createAnthropicCompatibleAccountAddHandler(
	dbOps: DatabaseOperations,
) {
	return async (req: Request): Promise<Response> => {
		try {
			const body = await req.json();

			// Validate account name
			const name = validateString(body.name, "name", {
				required: true,
				minLength: 1,
				maxLength: 100,
				pattern: patterns.accountName,
				patternErrorMessage:
					"can only contain letters, numbers, spaces, hyphens, and underscores",
				transform: sanitizers.trim,
			});

			if (!name) {
				return errorResponse(BadRequest("Account name is required"));
			}

			// Validate API key
			const apiKey = validateString(body.apiKey, "apiKey", {
				required: true,
				minLength: 1,
			});

			if (!apiKey) {
				return errorResponse(BadRequest("API key is required"));
			}

			// Validate priority
			const priority =
				validateNumber(body.priority, "priority", {
					min: 0,
					max: 100,
					integer: true,
				}) || 0;

			// Validate custom endpoint (optional for Anthropic-compatible)
			const customEndpoint = validateString(
				body.customEndpoint || null,
				"customEndpoint",
				{
					required: false,
					transform: (value: string) => {
						if (!value) return "";
						const trimmed = value.trim();
						if (!trimmed) return "";
						// Validate URL format
						try {
							new URL(trimmed);
							return trimmed;
						} catch {
							throw new Error("Invalid URL format");
						}
					},
				},
			);

			// Validate and sanitize model mappings (optional)
			let modelMappings = null;
			if (body.modelMappings && typeof body.modelMappings === "object") {
				const validatedMappings = validateAndSanitizeModelMappings(
					body.modelMappings,
				);
				modelMappings = JSON.stringify(validatedMappings);
			}

			// Create Anthropic-compatible account directly in database
			const accountId = crypto.randomUUID();
			const now = Date.now();
			const db = dbOps.getDatabase();
			db.run(
				`INSERT INTO accounts (
					id, name, provider, api_key, refresh_token, access_token,
					expires_at, created_at, request_count, total_requests, priority, custom_endpoint, model_mappings
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				[
					accountId,
					name,
					"anthropic-compatible",
					apiKey,
					apiKey, // Use API key as refresh token for consistency with CLI
					apiKey, // Use API key as access token
					now + 365 * 24 * 60 * 60 * 1000, // 1 year from now
					now,
					0,
					0,
					priority,
					customEndpoint || null,
					modelMappings,
				],
			);

			log.info(
				`Successfully added Anthropic-compatible account: ${name} (Priority ${priority})`,
			);

			// Get the created account for response
			const account = db
				.query<
					{
						id: string;
						name: string;
						provider: string;
						request_count: number;
						total_requests: number;
						last_used: number | null;
						created_at: number;
						expires_at: number;
						refresh_token: string;
						paused: number;
					},
					[string]
				>(
					`SELECT
						id, name, provider, request_count, total_requests,
						last_used, created_at, expires_at, refresh_token,
						COALESCE(paused, 0) as paused
					FROM accounts WHERE id = ?`,
				)
				.get(accountId);

			if (!account) {
				return errorResponse(
					InternalServerError("Failed to retrieve created account"),
				);
			}

			return jsonResponse({
				message: `Anthropic-compatible account '${name}' added successfully`,
				account: {
					id: account.id,
					name: account.name,
					provider: account.provider,
					requestCount: account.request_count,
					totalRequests: account.total_requests,
					lastUsed: account.last_used
						? new Date(account.last_used).toISOString()
						: null,
					created: new Date(account.created_at).toISOString(),
					paused: account.paused === 1,
					priority: priority,
					tokenStatus: "valid" as const,
					tokenExpiresAt: new Date(account.expires_at).toISOString(),
					rateLimitStatus: "OK",
					rateLimitReset: null,
					rateLimitRemaining: null,
					sessionInfo: "No active session",
					hasRefreshToken: !!account.refresh_token, // OAuth accounts have refresh tokens
				},
			});
		} catch (error) {
			log.error("Anthropic-compatible account creation error:", error);
			return errorResponse(
				error instanceof Error
					? error
					: new Error("Failed to create Anthropic-compatible account"),
			);
		}
	};
}

/**
 * Create an account auto-fallback toggle handler
 */
export function createAccountAutoFallbackHandler(dbOps: DatabaseOperations) {
	return async (req: Request, accountId: string): Promise<Response> => {
		try {
			const body = await req.json();

			// Validate enabled parameter
			const enabled = validateNumber(body.enabled, "enabled", {
				required: true,
				allowedValues: [0, 1] as const,
			});

			if (enabled === undefined) {
				return errorResponse(BadRequest("Enabled field is required (0 or 1)"));
			}

			// Check if account exists
			const db = dbOps.getDatabase();
			const account = db
				.query<{ name: string; provider: string }, [string]>(
					"SELECT name, provider FROM accounts WHERE id = ?",
				)
				.get(accountId);

			if (!account) {
				return errorResponse(NotFound("Account not found"));
			}

			// Check if account is Anthropic provider (only Anthropic accounts have rate limit windows)
			if (account.provider !== "anthropic") {
				return errorResponse(
					BadRequest("Auto-fallback is only available for Anthropic accounts"),
				);
			}

			// Update auto-fallback setting
			dbOps.setAutoFallbackEnabled(accountId, enabled === 1);

			const action = enabled === 1 ? "enabled" : "disabled";

			return jsonResponse({
				success: true,
				message: `Auto-fallback ${action} for account '${account.name}'`,
				autoFallbackEnabled: enabled === 1,
			});
		} catch (error) {
			log.error("Account auto-fallback toggle error:", error);
			return errorResponse(
				error instanceof Error
					? error
					: new Error("Failed to toggle auto-fallback"),
			);
		}
	};
}

/**
 * Create an account auto-refresh toggle handler
 */
export function createAccountAutoRefreshHandler(dbOps: DatabaseOperations) {
	return async (req: Request, accountId: string): Promise<Response> => {
		try {
			const body = await req.json();

			// Validate enabled parameter
			const enabled = validateNumber(body.enabled, "enabled", {
				required: true,
				allowedValues: [0, 1] as const,
			});

			if (enabled === undefined) {
				return errorResponse(BadRequest("Enabled field is required (0 or 1)"));
			}

			// Check if account exists
			const db = dbOps.getDatabase();
			const account = db
				.query<{ name: string; provider: string }, [string]>(
					"SELECT name, provider FROM accounts WHERE id = ?",
				)
				.get(accountId);

			if (!account) {
				return errorResponse(NotFound("Account not found"));
			}

			// Check if account is Anthropic provider (only Anthropic accounts have rate limit windows)
			if (account.provider !== "anthropic") {
				return errorResponse(
					BadRequest("Auto-refresh is only available for Anthropic accounts"),
				);
			}

			// Update auto-refresh setting
			db.run("UPDATE accounts SET auto_refresh_enabled = ? WHERE id = ?", [
				enabled,
				accountId,
			]);

			const action = enabled === 1 ? "enabled" : "disabled";

			return jsonResponse({
				success: true,
				message: `Auto-refresh ${action} for account '${account.name}'`,
				autoRefreshEnabled: enabled === 1,
			});
		} catch (error) {
			log.error("Account auto-refresh toggle error:", error);
			return errorResponse(
				error instanceof Error
					? error
					: new Error("Failed to toggle auto-refresh"),
			);
		}
	};
}

/**
 * Create an account custom endpoint update handler
 */
export function createAccountCustomEndpointUpdateHandler(
	dbOps: DatabaseOperations,
) {
	return async (req: Request, accountId: string): Promise<Response> => {
		try {
			const body = await req.json();

			// Validate custom endpoint
			const customEndpoint = validateString(
				body.customEndpoint,
				"customEndpoint",
				{
					required: false,
					transform: (value: string) => {
						if (!value) return "";
						const trimmed = value.trim();
						if (!trimmed) return "";
						// Validate URL format
						try {
							new URL(trimmed);
							return trimmed;
						} catch {
							throw new Error("Invalid URL format");
						}
					},
				},
			);

			// Update account custom endpoint
			const db = dbOps.getDatabase();
			db.run("UPDATE accounts SET custom_endpoint = ? WHERE id = ?", [
				customEndpoint || null,
				accountId,
			]);

			log.info(`Updated custom endpoint for account ${accountId}`);

			return jsonResponse({
				success: true,
				message: "Custom endpoint updated successfully",
			});
		} catch (error) {
			log.error("Account custom endpoint update error:", error);
			return errorResponse(
				error instanceof Error
					? error
					: new Error("Failed to update custom endpoint"),
			);
		}
	};
}

/**
 * Create an account model mappings update handler
 */
export function createAccountModelMappingsUpdateHandler(
	dbOps: DatabaseOperations,
) {
	return async (req: Request, accountId: string): Promise<Response> => {
		try {
			const body = await req.json();

			// Get account to verify it supports model mappings
			const db = dbOps.getDatabase();
			const account = db
				.query<{ provider: string; custom_endpoint: string | null }, [string]>(
					"SELECT provider, custom_endpoint FROM accounts WHERE id = ?",
				)
				.get(accountId);

			if (!account) {
				return errorResponse(NotFound("Account not found"));
			}

			if (
				account.provider !== "openai-compatible" &&
				account.provider !== "anthropic-compatible" &&
				account.provider !== "nanogpt"
			) {
				return errorResponse(
					BadRequest(
						"Model mappings are only available for OpenAI-compatible, Anthropic-compatible, and NanoGPT accounts",
					),
				);
			}

			// Handle model mappings update
			const modelMappings: { [key: string]: string } = (body.modelMappings ||
				{}) as { [key: string]: string };

			// Validate model mappings
			if (typeof modelMappings !== "object" || Array.isArray(modelMappings)) {
				return errorResponse(BadRequest("Model mappings must be an object"));
			}

			// Ensure modelMappings is a record with string values
			if (modelMappings) {
				for (const [_key, value] of Object.entries(modelMappings)) {
					if (typeof value !== "string") {
						return errorResponse(
							BadRequest("All model mapping values must be strings"),
						);
					}
				}
			}

			// Get existing model mappings from the dedicated field
			let existingModelMappings: { [key: string]: string } = {};
			const result = db
				.query<{ model_mappings: string | null }, [string]>(
					"SELECT model_mappings FROM accounts WHERE id = ?",
				)
				.get(accountId);
			const existingModelMappingsStr = result?.model_mappings || null;

			if (existingModelMappingsStr) {
				try {
					const parsed = JSON.parse(existingModelMappingsStr);
					// Handle both formats: direct mappings or wrapped in modelMappings
					existingModelMappings = parsed.modelMappings || parsed || {};
				} catch {
					// If parsing fails, ignore existing mappings
					existingModelMappings = {};
				}
			}

			// Merge new model mappings with existing ones
			const mergedModelMappings = { ...existingModelMappings };

			// Update or remove model mappings based on the input
			for (const [modelType, modelValue] of Object.entries(modelMappings)) {
				if (!modelValue || modelValue.trim() === "") {
					// Remove the mapping if value is empty
					delete mergedModelMappings[modelType];
				} else {
					// Update the mapping
					mergedModelMappings[modelType] = modelValue.trim();
				}
			}

			// Update the model_mappings field
			const finalModelMappings =
				Object.keys(mergedModelMappings).length > 0
					? JSON.stringify(mergedModelMappings)
					: null;

			db.run("UPDATE accounts SET model_mappings = ? WHERE id = ?", [
				finalModelMappings,
				accountId,
			]);

			log.info(`Updated model mappings for account ${accountId}`);

			return jsonResponse({
				success: true,
				message: "Model mappings updated successfully",
				modelMappings: mergedModelMappings,
			});
		} catch (error) {
			log.error("Account model mappings update error:", error);
			return errorResponse(
				error instanceof Error
					? error
					: new Error("Failed to update model mappings"),
			);
		}
	};
}

/**
 * Create an account force-reset rate limit handler
 * Clears rate limit lock fields and triggers immediate usage refresh when possible.
 */
export function createAccountForceResetRateLimitHandler(
	dbOps: DatabaseOperations,
) {
	return async (_req: Request, accountId: string): Promise<Response> => {
		try {
			const db = dbOps.getDatabase();
			const account = db
				.query<
					{
						id: string;
						name: string;
						provider: string;
						access_token: string | null;
					},
					[string]
				>("SELECT id, name, provider, access_token FROM accounts WHERE id = ?")
				.get(accountId);

			if (!account) {
				return errorResponse(NotFound("Account not found"));
			}

			dbOps.forceResetAccountRateLimit(accountId);
			clearAccountRefreshCache(accountId);

			// Trigger immediate poll if this server has a polling token provider for the account.
			let usagePollTriggered = await usageCache.refreshNow(accountId);

			// Fallback for Anthropic OAuth accounts when polling is not configured in-process.
			if (
				!usagePollTriggered &&
				account.provider === "anthropic" &&
				account.access_token
			) {
				const usageData = await fetchUsageData(account.access_token);
				if (usageData) {
					usageCache.set(account.id, usageData);
					usagePollTriggered = true;
				}
			}

			log.info(
				`Force-reset rate limit for account '${account.name}' (usage poll triggered: ${usagePollTriggered})`,
			);

			return jsonResponse({
				success: true,
				message: `Rate limit state cleared for account '${account.name}'`,
				usagePollTriggered,
			});
		} catch (error) {
			log.error("Account force-reset rate limit error:", error);
			return errorResponse(
				error instanceof Error
					? error
					: new Error("Failed to force reset account rate limit"),
			);
		}
	};
}

/**
 * Create an account reload handler
 * Clears refresh cache for an account after re-authentication
 */
export function createAccountReloadHandler(dbOps: DatabaseOperations) {
	return async (_req: Request, accountId: string): Promise<Response> => {
		try {
			// Check if account exists
			const db = dbOps.getDatabase();
			const account = db
				.query<{ name: string; provider: string }, [string]>(
					"SELECT name, provider FROM accounts WHERE id = ?",
				)
				.get(accountId);

			if (!account) {
				return errorResponse(NotFound("Account not found"));
			}

			// Check if account is Anthropic provider (only OAuth accounts need token reload)
			if (account.provider !== "anthropic") {
				return errorResponse(
					BadRequest("Token reload is only available for Anthropic accounts"),
				);
			}

			// Clear refresh cache for this account
			clearAccountRefreshCache(accountId);

			// Clear usage cache for this account to prevent memory leaks
			usageCache.delete(accountId);

			log.info(`Token reload triggered for account '${account.name}'`);

			return jsonResponse({
				success: true,
				message: `Token reload triggered for account '${account.name}'. The next request will use the updated tokens from the database.`,
			});
		} catch (error) {
			log.error("Account reload error:", error);
			return errorResponse(
				error instanceof Error
					? error
					: new Error("Failed to reload account tokens"),
			);
		}
	};
}
