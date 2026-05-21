import crypto from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
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
	type AnyUsageData,
	fetchUsageData,
	getRepresentativeUtilization,
	getRepresentativeWindow,
	parseCodexUsageHeaders,
	type UsageData,
	usageCache,
} from "@better-ccflare/providers";
import {
	clearAccountRefreshCache,
	getUsageThrottleStatus,
	refreshCodexUsageForAccount,
	restartUsagePollingForAccount,
} from "@better-ccflare/proxy";
import type { FullUsageData, RateLimitReason } from "@better-ccflare/types";
import { requiresSessionDurationTracking } from "@better-ccflare/types";
import type { AccountResponse } from "../types";

const log = new Logger("AccountsHandler");

const RATE_LIMIT_REASONS = new Set<RateLimitReason>([
	"upstream_429_with_reset",
	// Kept for backwards-compat with DB rows written by ccflare ≤ v3.5.x;
	// new code emits `upstream_429_no_reset_probe_cooldown` instead.
	"upstream_429_no_reset_default_5h",
	"upstream_429_no_reset_probe_cooldown",
	"model_fallback_429",
	"all_models_exhausted_429",
]);

function toRateLimitReason(v: string | null): RateLimitReason | null {
	if (v === null) return null;
	return RATE_LIMIT_REASONS.has(v as RateLimitReason)
		? (v as RateLimitReason)
		: null;
}

function normalizeCodexUsageData(usage: UsageData): UsageData | null {
	const normalized: UsageData = {
		five_hour: { ...usage.five_hour },
		seven_day: { ...usage.seven_day },
	};
	if (
		normalized.five_hour.resets_at &&
		new Date(normalized.five_hour.resets_at).getTime() <= Date.now()
	) {
		normalized.five_hour = { utilization: 0, resets_at: null };
	}
	if (
		normalized.seven_day.resets_at &&
		new Date(normalized.seven_day.resets_at).getTime() <= Date.now()
	) {
		normalized.seven_day = { utilization: 0, resets_at: null };
	}
	return normalized.five_hour.resets_at !== null ||
		normalized.seven_day.resets_at !== null
		? normalized
		: null;
}

async function getCachedOrPersistedCodexUsage(
	db: ReturnType<DatabaseOperations["getAdapter"]>,
	accountId: string,
	accountName: string,
	cacheData: FullUsageData | null,
): Promise<FullUsageData | null> {
	if (cacheData) {
		const normalizedCache = normalizeCodexUsageData(cacheData as UsageData);
		if (normalizedCache) {
			return normalizedCache as FullUsageData;
		}
	}
	const rows = await db.query<{ json: string; timestamp: number | null }>(
		`SELECT rp.json, COALESCE(rp.timestamp, r.timestamp) as timestamp
		 FROM request_payloads rp
		 JOIN requests r ON rp.id = r.id
		 WHERE r.account_used = ?
		 ORDER BY r.timestamp DESC
		 LIMIT 20`,
		[accountId],
	);

	for (const row of rows) {
		if (!row.json || !row.timestamp) continue;

		try {
			const payload = JSON.parse(row.json) as {
				response?: { headers?: Record<string, string>; status?: number };
				meta?: { timestamp?: number };
			};
			const headerEntries = Object.entries(payload.response?.headers ?? {});
			if (headerEntries.length === 0) continue;

			const codexStatus = payload.response?.status;
			const payloadTimestamp = payload.meta?.timestamp ?? row.timestamp;
			const usage = parseCodexUsageHeaders(new Headers(headerEntries), {
				baseTimeMs: payloadTimestamp,
				allowRelativeResetAfter: true,
				defaultUtilization: codexStatus === 429 ? 100 : 0,
			});
			if (!usage) continue;

			const normalizedUsage = normalizeCodexUsageData(usage);
			if (!normalizedUsage) continue;

			usageCache.set(accountId, normalizedUsage);
			log.debug(`Recovered Codex usage from stored payload for ${accountName}`);
			return normalizedUsage as FullUsageData;
		} catch (error) {
			log.warn(
				`Failed to recover Codex usage from stored payload for ${accountName}:`,
				error instanceof Error ? error.message : String(error),
			);
		}
	}

	return null;
}

/**
 * Create an accounts list handler
 */
export function createAccountsListHandler(
	dbOps: DatabaseOperations,
	config: Config,
) {
	return async (): Promise<Response> => {
		const db = dbOps.getAdapter();
		const now = Date.now();
		const sessionDuration = 5 * 60 * 60 * 1000; // 5 hours

		const accounts = await db.query<{
			id: string;
			name: string;
			provider: string | null;
			request_count: number;
			total_requests: number;
			last_used: number | null;
			created_at: number;
			expires_at: number | null;
			rate_limited_until: number | null;
			rate_limited_reason: string | null;
			rate_limited_at: number | null;
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
			auto_pause_on_overage_enabled: 0 | 1;
			peak_hours_pause_enabled: 0 | 1;
			custom_endpoint: string | null;
			model_mappings: string | null;
			cross_region_mode: string | null;
			model_fallbacks: string | null;
			billing_type: string | null;
		}>(
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
						rate_limited_reason,
						rate_limited_at,
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
					COALESCE(auto_pause_on_overage_enabled, 0) as auto_pause_on_overage_enabled,
					COALESCE(peak_hours_pause_enabled, 0) as peak_hours_pause_enabled,

					model_mappings,
					cross_region_mode,
					model_fallbacks,
					billing_type,
					CASE
						WHEN expires_at > ? THEN 1
						ELSE 0
					END as token_valid,
					CASE
						WHEN rate_limited_until > ? THEN 1
						ELSE 0
					END as rate_limited,
					CASE
						WHEN session_start IS NOT NULL AND ? - session_start < ? THEN
							'Active: ' || session_request_count || ' reqs'
						ELSE '-'
					END as session_info
				FROM accounts
				ORDER BY priority DESC, request_count DESC
			`,
			[now, now, now, sessionDuration],
		);

		// Fetch session-window token stats only for providers with session-based limits
		const sessionStatsMap = await dbOps
			.getStatsRepository()
			.getSessionStats(
				accounts
					.filter((a) => requiresSessionDurationTracking(a.provider ?? ""))
					.map((a) => ({
						id: a.id,
						session_start: a.session_start ? Number(a.session_start) : null,
					})),
			)
			.catch(() => new Map());

		const response: AccountResponse[] = await Promise.all(
			accounts.map(async (account) => {
				let rateLimitStatus = "OK";

				// Use unified rate limit status if available
				if (account.rate_limit_status) {
					rateLimitStatus = account.rate_limit_status;
					const resetMs = Number(account.rate_limit_reset);
					if (resetMs && resetMs > now) {
						const minutesLeft = Math.ceil((resetMs - now) / 60000);
						rateLimitStatus = `${account.rate_limit_status} (${minutesLeft}m)`;
					}
				} else if (account.rate_limited && account.rate_limited_until) {
					// Fall back to legacy rate limit check
					const limitedMs = Number(account.rate_limited_until);
					if (limitedMs > now) {
						const minutesLeft = Math.ceil((limitedMs - now) / 60000);
						rateLimitStatus = `Rate limited (${minutesLeft}m)`;
					}
				}

				// Get usage data from cache for providers that expose account-page quota or credit data
				const cachedUsageData = usageCache.get(account.id);
				let usageData: FullUsageData | null =
					cachedUsageData as FullUsageData | null;
				if (account.provider === "codex") {
					usageData = await getCachedOrPersistedCodexUsage(
						db,
						account.id,
						account.name,
						usageData,
					);
				}
				let usageUtilization: number | null = null;
				let usageWindow: string | null = null;
				let fullUsageData: FullUsageData | null = null;
				let usageThrottledUntil: number | null = null;
				let usageThrottledWindows: string[] = [];

				if (
					(account.provider === "anthropic" || account.provider === "codex") &&
					usageData
				) {
					const isAnthropicStyleData =
						"five_hour" in usageData && "seven_day" in usageData;
					if (isAnthropicStyleData) {
						try {
							usageUtilization = getRepresentativeUtilization(
								usageData as UsageData,
							);
							usageWindow = getRepresentativeWindow(usageData as UsageData);
							fullUsageData = usageData as FullUsageData;
						} catch (error) {
							log.warn(
								`Failed to process ${account.provider} usage data for account ${account.id}:`,
								error instanceof Error ? error.message : String(error),
							);
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
				} else if (account.provider === "kilo" && usageData) {
					// Kilo usage data - type guard to check it's KiloUsageData
					const isKiloData = "remainingUsd" in usageData;
					if (isKiloData) {
						try {
							const {
								getRepresentativeKiloUtilization,
								getRepresentativeKiloWindow,
							} = require("@better-ccflare/providers");
							usageUtilization = getRepresentativeKiloUtilization(usageData);
							usageWindow = getRepresentativeKiloWindow(usageData);
							fullUsageData = usageData as FullUsageData;
						} catch (error) {
							log.warn(
								`Failed to process Kilo usage data for account ${account.name}:`,
								error,
							);
						}
					}
				} else if (account.provider === "alibaba-coding-plan" && usageData) {
					// Alibaba Coding Plan usage data - type guard to check it's AlibabaCodingPlanUsageData
					const isAlibabaData =
						"five_hour" in usageData && "weekly" in usageData;
					if (isAlibabaData) {
						try {
							const {
								getRepresentativeAlibabaCodingPlanUtilization,
								getRepresentativeAlibabaCodingPlanWindow,
							} = require("@better-ccflare/providers");
							usageUtilization =
								getRepresentativeAlibabaCodingPlanUtilization(usageData);
							usageWindow = getRepresentativeAlibabaCodingPlanWindow(usageData);
							fullUsageData = usageData as FullUsageData;
						} catch (error) {
							log.warn(
								`Failed to process Alibaba Coding Plan usage data for account ${account.name}:`,
								error,
							);
						}
					}
				}

				const usageThrottleSettings = {
					fiveHourEnabled: config.getUsageThrottlingFiveHourEnabled(),
					weeklyEnabled: config.getUsageThrottlingWeeklyEnabled(),
				};
				if (
					(usageThrottleSettings.fiveHourEnabled ||
						usageThrottleSettings.weeklyEnabled) &&
					fullUsageData
				) {
					const usageThrottleStatus = getUsageThrottleStatus(
						fullUsageData as AnyUsageData,
						usageThrottleSettings,
						now,
					);
					usageThrottledUntil = usageThrottleStatus.throttleUntil;
					usageThrottledWindows = usageThrottleStatus.throttledWindows;
				}

				// Parse model mappings for OpenAI-compatible, Anthropic-compatible, NanoGPT, and OpenRouter providers
				let modelMappings: { [key: string]: string } | null = null;
				if (account.model_mappings) {
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

				// Parse model fallbacks for all providers
				let modelFallbacks: { [key: string]: string } | null = null;
				if (account.model_fallbacks) {
					try {
						const parsed = JSON.parse(account.model_fallbacks);
						modelFallbacks = parsed.modelFallbacks || parsed || null;
					} catch {
						modelFallbacks = null;
					}
				}

				return {
					id: account.id,
					name: account.name,
					provider: account.provider || "anthropic",
					requestCount: Number(account.request_count) || 0,
					totalRequests: Number(account.total_requests) || 0,
					lastUsed: account.last_used
						? new Date(Number(account.last_used)).toISOString()
						: null,
					created: new Date(Number(account.created_at)).toISOString(),
					paused: account.paused === 1,
					priority: Number(account.priority) || 0,
					tokenStatus: account.token_valid ? "valid" : "expired",
					tokenExpiresAt: account.expires_at
						? new Date(Number(account.expires_at)).toISOString()
						: null,
					rateLimitStatus,
					rateLimitReset: account.rate_limit_reset
						? new Date(Number(account.rate_limit_reset)).toISOString()
						: null,
					rateLimitRemaining:
						account.rate_limit_remaining != null
							? Number(account.rate_limit_remaining)
							: null,
					rateLimitedUntil: account.rate_limited_until
						? Number(account.rate_limited_until)
						: null,
					rateLimitedReason: toRateLimitReason(account.rate_limited_reason),
					rateLimitedAt:
						account.rate_limited_at != null
							? Number(account.rate_limited_at)
							: null,
					sessionInfo: account.session_info || "",
					autoFallbackEnabled: account.auto_fallback_enabled === 1,
					autoRefreshEnabled: account.auto_refresh_enabled === 1,
					autoPauseOnOverageEnabled:
						account.auto_pause_on_overage_enabled === 1,
					peakHoursPauseEnabled: account.peak_hours_pause_enabled === 1,
					customEndpoint: account.custom_endpoint,
					modelMappings,
					usageUtilization,
					usageWindow,
					usageData: fullUsageData, // Full usage data for UI
					usageRateLimitedUntil: usageCache.getRateLimitedUntil(account.id),
					usageThrottledUntil,
					usageThrottledWindows,
					hasRefreshToken:
						!!account.refresh_token &&
						account.refresh_token !== account.access_token, // API-key providers store key in both fields
					crossRegionMode: account.cross_region_mode,
					modelFallbacks,
					billingType: account.billing_type,
					sessionStats: sessionStatsMap.get(account.id) ?? null,
				};
			}),
		);

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
			const db = dbOps.getAdapter();
			const account = await db.get<{ id: string }>(
				"SELECT id FROM accounts WHERE id = ?",
				[accountId],
			);

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
					"can only contain letters, numbers, spaces, hyphens, underscores, and dots",
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

				await dbOps.getAdapter().run(
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

			const result = await cliCommands.removeAccount(dbOps, accountName);

			if (!result.success) {
				return errorResponse(NotFound(result.message));
			}

			// Find the account ID to clean up usage cache (check before deletion)
			const db = dbOps.getAdapter();
			const account = await db.get<{ id: string }>(
				"SELECT id FROM accounts WHERE name = ?",
				[accountName],
			);

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
			const db = dbOps.getAdapter();
			const account = await db.get<{ name: string }>(
				"SELECT name FROM accounts WHERE id = ?",
				[accountId],
			);

			if (!account) {
				return errorResponse(NotFound("Account not found"));
			}

			const result = await cliCommands.pauseAccount(dbOps, account.name);

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
			const db = dbOps.getAdapter();
			const account = await db.get<{ name: string }>(
				"SELECT name FROM accounts WHERE id = ?",
				[accountId],
			);

			if (!account) {
				return errorResponse(NotFound("Account not found"));
			}

			const result = await cliCommands.resumeAccount(dbOps, account.name);

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
					"can only contain letters, numbers, spaces, hyphens, underscores, and dots",
				transform: sanitizers.trim,
			});

			if (!newName) {
				return errorResponse(BadRequest("New account name is required"));
			}

			// Check if account exists
			const db = dbOps.getAdapter();
			const account = await db.get<{ name: string }>(
				"SELECT name FROM accounts WHERE id = ?",
				[accountId],
			);

			if (!account) {
				return errorResponse(NotFound("Account not found"));
			}

			// Check if new name is already taken
			const existingAccount = await db.get<{ id: string }>(
				"SELECT id FROM accounts WHERE name = ? AND id != ?",
				[newName, accountId],
			);

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
					"can only contain letters, numbers, spaces, hyphens, underscores, and dots",
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

			// Validate model mappings
			let modelMappingsJson: string | null = null;
			if (body.modelMappings && typeof body.modelMappings === "object") {
				const validated = validateAndSanitizeModelMappings(body.modelMappings);
				if (validated) {
					modelMappingsJson = JSON.stringify(validated);
				}
			}

			// Create z.ai account directly in database
			const accountId = crypto.randomUUID();
			const now = Date.now();

			const db = dbOps.getAdapter();
			await db.run(
				`INSERT INTO accounts (
					id, name, provider, api_key, refresh_token, access_token,
					expires_at, created_at, request_count, total_requests, priority, custom_endpoint, model_mappings
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
					modelMappingsJson,
				],
			);

			log.info(
				`Successfully added z.ai account: ${name} (Priority ${priority})`,
			);

			// Get the created account for response
			const account = await db.get<{
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
			}>(
				`SELECT
					id, name, provider, request_count, total_requests,
					last_used, created_at, expires_at, refresh_token,
					COALESCE(paused, 0) as paused
				FROM accounts WHERE id = ?`,
				[accountId],
			);

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
					rateLimitedUntil: null,
					sessionInfo: "No active session",
					hasRefreshToken: false,
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
					"can only contain letters, numbers, spaces, hyphens, underscores, and dots",
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

			const db = dbOps.getAdapter();
			await db.run(
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
			const account = await db.get<{
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
			}>(
				`SELECT
					id, name, provider, request_count, total_requests,
					last_used, created_at, expires_at, refresh_token,
					COALESCE(paused, 0) as paused
				FROM accounts WHERE id = ?`,
				[accountId],
			);

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
					rateLimitedUntil: null,
					sessionInfo: "No active session",
					customEndpoint: customEndpoint,
					hasRefreshToken: false,
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
					"can only contain letters, numbers, spaces, hyphens, underscores, and dots",
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
			const db = dbOps.getAdapter();
			await db.run(
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
			const account = await db.get<{
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
			}>(
				`SELECT
					id, name, provider, request_count, total_requests,
					last_used, created_at, expires_at, refresh_token,
					COALESCE(paused, 0) as paused
				FROM accounts WHERE id = ?`,
				[accountId],
			);

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
					"can only contain letters, numbers, spaces, hyphens, underscores, and dots",
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
			const db = dbOps.getAdapter();
			await db.run(
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
			const account = await db.get<{
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
			}>(
				`SELECT
					id, name, provider, request_count, total_requests,
					last_used, created_at, expires_at, refresh_token,
					COALESCE(paused, 0) as paused
				FROM accounts WHERE id = ?`,
				[accountId],
			);

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
					rateLimitedUntil: null,
					sessionInfo: "No active session",
					hasRefreshToken: false,
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
					"can only contain letters, numbers, spaces, hyphens, underscores, and dots",
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
			const db = dbOps.getAdapter();
			await db.run(
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
			const account = await db.get<{
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
			}>(
				`SELECT
					id, name, provider, request_count, total_requests,
					last_used, created_at, expires_at, refresh_token,
					COALESCE(paused, 0) as paused
				FROM accounts WHERE id = ?`,
				[accountId],
			);
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
					rateLimitedUntil: null,
					sessionInfo: "No active session",
					hasRefreshToken: false,
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
					"can only contain letters, numbers, spaces, hyphens, underscores, and dots",
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
			const db = dbOps.getAdapter();
			await db.run(
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
			const account = await db.get<{
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
			}>(
				`SELECT
					id, name, provider, request_count, total_requests,
					last_used, created_at, expires_at, refresh_token,
					COALESCE(paused, 0) as paused
				FROM accounts WHERE id = ?`,
				[accountId],
			);

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
					rateLimitedUntil: null,
					sessionInfo: "No active session",
					hasRefreshToken: false,
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
 * Create an Ollama account add handler
 */
export function createOllamaAccountAddHandler(dbOps: DatabaseOperations) {
	return async (req: Request): Promise<Response> => {
		try {
			const body = await req.json();

			const name = validateString(body.name, "name", {
				required: true,
				minLength: 1,
				maxLength: 100,
				pattern: patterns.accountName,
				patternErrorMessage:
					"can only contain letters, numbers, spaces, hyphens, underscores, and dots",
				transform: sanitizers.trim,
			});

			if (!name) {
				return errorResponse(BadRequest("Account name is required"));
			}

			const priority =
				validateNumber(body.priority, "priority", {
					min: 0,
					max: 100,
					integer: true,
				}) || 0;

			const customEndpoint = validateString(
				body.customEndpoint || null,
				"customEndpoint",
				{
					required: false,
					transform: (value: string) => {
						if (!value) return "";
						const trimmed = value.trim();
						if (!trimmed) return "";
						try {
							new URL(trimmed);
							return trimmed;
						} catch {
							throw new Error("Invalid URL format");
						}
					},
				},
			);

			let modelMappings = null;
			if (body.modelMappings && typeof body.modelMappings === "object") {
				const validatedMappings = validateAndSanitizeModelMappings(
					body.modelMappings,
				);
				modelMappings = JSON.stringify(validatedMappings);
			}

			// Ollama doesn't require an API key; use a placeholder
			const apiKey = "ollama";

			const accountId = crypto.randomUUID();
			const now = Date.now();
			const db = dbOps.getAdapter();
			await db.run(
				`INSERT INTO accounts (
					id, name, provider, api_key, refresh_token, access_token,
					expires_at, created_at, request_count, total_requests, priority, custom_endpoint, model_mappings
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				[
					accountId,
					name,
					"ollama",
					apiKey,
					apiKey,
					apiKey,
					now + 365 * 24 * 60 * 60 * 1000,
					now,
					0,
					0,
					priority,
					customEndpoint || null,
					modelMappings,
				],
			);

			log.info(
				`Successfully added Ollama account: ${name} (Priority ${priority})`,
			);

			const account = await db.get<{
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
			}>(
				`SELECT
					id, name, provider, request_count, total_requests,
					last_used, created_at, expires_at, refresh_token,
					COALESCE(paused, 0) as paused
				FROM accounts WHERE id = ?`,
				[accountId],
			);

			if (!account) {
				return errorResponse(
					InternalServerError("Failed to retrieve created account"),
				);
			}

			return jsonResponse({
				message: `Ollama account '${name}' added successfully`,
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
					rateLimitedUntil: null,
					sessionInfo: "No active session",
					hasRefreshToken: false,
				},
			});
		} catch (error) {
			log.error("Ollama account creation error:", error);
			return errorResponse(
				error instanceof Error
					? error
					: new Error("Failed to create Ollama account"),
			);
		}
	};
}

export function createOllamaCloudAccountAddHandler(dbOps: DatabaseOperations) {
	return async (req: Request): Promise<Response> => {
		try {
			const body = await req.json();

			const name = validateString(body.name, "name", {
				required: true,
				minLength: 1,
				maxLength: 100,
				pattern: patterns.accountName,
				patternErrorMessage:
					"can only contain letters, numbers, spaces, hyphens, underscores, and dots",
				transform: sanitizers.trim,
			});

			if (!name) {
				return errorResponse(BadRequest("Account name is required"));
			}

			const apiKey = validateString(body.apiKey, "apiKey", {
				required: true,
				minLength: 1,
				transform: sanitizers.trim,
			});

			if (!apiKey) {
				return errorResponse(
					BadRequest("API key is required for Ollama Cloud"),
				);
			}

			const priority =
				validateNumber(body.priority, "priority", {
					min: 0,
					max: 100,
					integer: true,
				}) || 0;

			let modelMappings = null;
			if (body.modelMappings && typeof body.modelMappings === "object") {
				const validatedMappings = validateAndSanitizeModelMappings(
					body.modelMappings,
				);
				modelMappings = JSON.stringify(validatedMappings);
			}

			const accountId = crypto.randomUUID();
			const now = Date.now();
			const db = dbOps.getAdapter();
			await db.run(
				`INSERT INTO accounts (
					id, name, provider, api_key, refresh_token, access_token,
					expires_at, created_at, request_count, total_requests, priority, custom_endpoint, model_mappings
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				[
					accountId,
					name,
					"ollama-cloud",
					apiKey,
					apiKey,
					apiKey,
					now + 365 * 24 * 60 * 60 * 1000,
					now,
					0,
					0,
					priority,
					"https://ollama.com",
					modelMappings,
				],
			);

			log.info(
				`Successfully added Ollama Cloud account: ${name} (Priority ${priority})`,
			);

			const account = await db.get<{
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
			}>(
				`SELECT
					id, name, provider, request_count, total_requests,
					last_used, created_at, expires_at, refresh_token,
					COALESCE(paused, 0) as paused
				FROM accounts WHERE id = ?`,
				[accountId],
			);

			if (!account) {
				return errorResponse(
					InternalServerError("Failed to retrieve created account"),
				);
			}

			return jsonResponse({
				message: `Ollama Cloud account '${name}' added successfully`,
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
					rateLimitedUntil: null,
					sessionInfo: "No active session",
					hasRefreshToken: false,
				},
			});
		} catch (error) {
			log.error("Ollama Cloud account creation error:", error);
			return errorResponse(
				error instanceof Error
					? error
					: new Error("Failed to create Ollama Cloud account"),
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
			const db = dbOps.getAdapter();
			const account = await db.get<{ name: string; provider: string }>(
				"SELECT name, provider FROM accounts WHERE id = ?",
				[accountId],
			);

			if (!account) {
				return errorResponse(NotFound("Account not found"));
			}

			// Check if account supports session-based auto-fallback
			if (!["anthropic", "codex", "zai"].includes(account.provider)) {
				return errorResponse(
					BadRequest("Auto-fallback is only available for supported accounts"),
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
 * Create an account auto-pause-on-overage toggle handler
 */
export function createAccountAutoPauseOnOverageHandler(
	dbOps: DatabaseOperations,
) {
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
			const db = dbOps.getAdapter();
			const account = await db.get<{ name: string; provider: string }>(
				"SELECT name, provider FROM accounts WHERE id = ?",
				[accountId],
			);

			if (!account) {
				return errorResponse(NotFound("Account not found"));
			}

			// Check if account is Anthropic provider (only Anthropic accounts have overage detection)
			if (account.provider !== "anthropic") {
				return errorResponse(
					BadRequest(
						"Auto-pause on overage is only available for Anthropic accounts",
					),
				);
			}

			// Update auto-pause-on-overage setting
			dbOps.setAutoPauseOnOverageEnabled(accountId, enabled === 1);

			const action = enabled === 1 ? "enabled" : "disabled";

			return jsonResponse({
				success: true,
				message: `Auto-pause on overage ${action} for account '${account.name}'`,
				autoPauseOnOverageEnabled: enabled === 1,
			});
		} catch (error) {
			log.error("Account auto-pause-on-overage toggle error:", error);
			return errorResponse(
				error instanceof Error
					? error
					: new Error("Failed to toggle auto-pause-on-overage"),
			);
		}
	};
}

/**
 * Create an account peak-hours-pause toggle handler (Zai accounts only)
 */
export function createAccountPeakHoursPauseHandler(dbOps: DatabaseOperations) {
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
			const db = dbOps.getAdapter();
			const account = await db.get<{ name: string; provider: string }>(
				"SELECT name, provider FROM accounts WHERE id = ?",
				[accountId],
			);

			if (!account) {
				return errorResponse(NotFound("Account not found"));
			}

			// Only zai accounts support peak hours pause
			if (account.provider !== "zai") {
				return errorResponse(
					BadRequest("Peak hours pause is only available for Zai accounts"),
				);
			}

			// Update peak-hours-pause setting
			await dbOps.setPeakHoursPauseEnabled(accountId, enabled === 1);

			// Immediate resume when disabling — don't make users wait for scheduler
			if (enabled === 0) {
				await db.run(
					"UPDATE accounts SET paused = 0, pause_reason = NULL WHERE id = ? AND COALESCE(paused, 0) = 1 AND pause_reason = 'peak_hours'",
					[accountId],
				);
			}

			const action = enabled === 1 ? "enabled" : "disabled";

			return jsonResponse({
				success: true,
				message: `Peak hours pause ${action} for account '${account.name}'`,
				peakHoursPauseEnabled: enabled === 1,
			});
		} catch (error) {
			log.error("Account peak-hours-pause toggle error:", error);
			return errorResponse(
				error instanceof Error
					? error
					: new Error("Failed to toggle peak-hours-pause"),
			);
		}
	};
}

/**
 * Create an account billing type handler
 */
export function createAccountBillingTypeHandler(dbOps: DatabaseOperations) {
	return async (req: Request, accountId: string): Promise<Response> => {
		try {
			const body = await req.json();

			const billingType = validateString(body.billingType, "billingType", {
				required: true,
				allowedValues: ["plan", "api", "auto"],
			});

			if (billingType === undefined) {
				return errorResponse(
					BadRequest("billingType must be 'plan', 'api', or 'auto'"),
				);
			}

			// Check if account exists
			const db = dbOps.getAdapter();
			const account = await db.get<{ name: string; provider: string }>(
				"SELECT name, provider FROM accounts WHERE id = ?",
				[accountId],
			);

			if (!account) {
				return errorResponse(NotFound("Account not found"));
			}

			// Only allow custom billing type for compatible providers
			if (
				!["anthropic-compatible", "openai-compatible"].includes(
					account.provider,
				)
			) {
				return errorResponse(
					BadRequest(
						"Custom billing type is only available for anthropic-compatible and openai-compatible providers",
					),
				);
			}

			await dbOps.setAccountBillingType(
				accountId,
				billingType === "auto" ? null : billingType,
			);

			return jsonResponse({
				success: true,
				message: `Billing type set to '${billingType}' for account '${account.name}'`,
				billingType,
			});
		} catch (error) {
			log.error("Account billing type update error:", error);
			return errorResponse(
				error instanceof Error
					? error
					: new Error("Failed to update billing type"),
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
			const db = dbOps.getAdapter();
			const account = await db.get<{ name: string; provider: string }>(
				"SELECT name, provider FROM accounts WHERE id = ?",
				[accountId],
			);

			if (!account) {
				return errorResponse(NotFound("Account not found"));
			}

			// Check if account provider supports auto-refresh (session-window based providers)
			if (
				account.provider !== "anthropic" &&
				account.provider !== "codex" &&
				account.provider !== "zai"
			) {
				return errorResponse(
					BadRequest(
						"Auto-refresh is only available for Anthropic, Codex, and Zai accounts",
					),
				);
			}

			// Update auto-refresh setting
			await db.run(
				"UPDATE accounts SET auto_refresh_enabled = ? WHERE id = ?",
				[enabled, accountId],
			);

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
			await dbOps
				.getAdapter()
				.run("UPDATE accounts SET custom_endpoint = ? WHERE id = ?", [
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
			const db = dbOps.getAdapter();
			const account = await db.get<{
				provider: string;
				custom_endpoint: string | null;
			}>("SELECT provider, custom_endpoint FROM accounts WHERE id = ?", [
				accountId,
			]);

			if (!account) {
				return errorResponse(NotFound("Account not found"));
			}

			// Handle model mappings update
			const modelMappings = body.modelMappings || {};

			// Validate model mappings - values can be string or string[]
			if (typeof modelMappings !== "object" || Array.isArray(modelMappings)) {
				return errorResponse(BadRequest("Model mappings must be an object"));
			}

			for (const [_key, value] of Object.entries(modelMappings)) {
				if (typeof value === "string") {
					if (!value.trim()) {
						return errorResponse(
							BadRequest(
								`Model mapping value for key '${_key}' must not be empty`,
							),
						);
					}
				} else if (Array.isArray(value)) {
					if (value.length === 0) {
						return errorResponse(
							BadRequest(
								`Model mapping array for key '${_key}' must not be empty`,
							),
						);
					}
					for (const item of value) {
						if (typeof item !== "string" || !item.trim()) {
							return errorResponse(
								BadRequest(
									`All model mapping array values for key '${_key}' must be non-empty strings`,
								),
							);
						}
					}
				} else {
					return errorResponse(
						BadRequest(
							"Model mapping values must be strings or arrays of strings",
						),
					);
				}
			}

			// Build the new model mappings as a full replacement (not a merge).
			// This ensures that sending an empty {} correctly clears all mappings.
			const mergedModelMappings: Record<string, string | string[]> = {};

			for (const [modelType, modelValue] of Object.entries(modelMappings)) {
				if (typeof modelValue === "string") {
					if (modelValue.trim()) {
						mergedModelMappings[modelType] = modelValue.trim();
					}
				} else if (Array.isArray(modelValue)) {
					const trimmed = modelValue
						.map((v) => (typeof v === "string" ? v.trim() : ""))
						.filter(Boolean);
					if (trimmed.length > 0) {
						mergedModelMappings[modelType] =
							trimmed.length === 1 ? trimmed[0] : trimmed;
					}
				}
			}

			// Update the model_mappings field
			const finalModelMappings =
				Object.keys(mergedModelMappings).length > 0
					? JSON.stringify(mergedModelMappings)
					: null;

			await db.run("UPDATE accounts SET model_mappings = ? WHERE id = ?", [
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
 * Create an account model fallbacks update handler.
 * @deprecated Fallbacks are now merged into model_mappings as arrays.
 * This handler appends fallback models to existing model_mappings arrays.
 */
export function createAccountModelFallbacksUpdateHandler(
	dbOps: DatabaseOperations,
) {
	return async (req: Request, accountId: string): Promise<Response> => {
		try {
			const body = await req.json();

			const db = dbOps.getAdapter();
			const account = await db.get<{ id: string }>(
				"SELECT id FROM accounts WHERE id = ?",
				[accountId],
			);

			if (!account) {
				return errorResponse(NotFound("Account not found"));
			}

			// Validate fallbacks input
			const modelFallbacks = body.modelFallbacks || {};
			if (typeof modelFallbacks !== "object" || Array.isArray(modelFallbacks)) {
				return errorResponse(BadRequest("Model fallbacks must be an object"));
			}
			for (const [_key, value] of Object.entries(modelFallbacks)) {
				if (typeof value !== "string" || !value.trim()) {
					return errorResponse(
						BadRequest("All model fallback values must be non-empty strings"),
					);
				}
			}

			// Get existing model_mappings and merge fallbacks into them
			let existingMappings: Record<string, string | string[]> = {};
			const result = await db.get<{ model_mappings: string | null }>(
				"SELECT model_mappings FROM accounts WHERE id = ?",
				[accountId],
			);

			if (result?.model_mappings) {
				try {
					const parsed = JSON.parse(result.model_mappings);
					existingMappings = parsed.modelMappings || parsed || {};
				} catch {
					existingMappings = {};
				}
			}

			// Merge: for each fallback, append to existing mapping array
			for (const [modelType, fallbackValue] of Object.entries(modelFallbacks)) {
				const existing = existingMappings[modelType];
				const fallback = (fallbackValue as string).trim();

				if (typeof existing === "string") {
					// Promote single string to array with fallback appended
					existingMappings[modelType] = [existing, fallback];
				} else if (Array.isArray(existing)) {
					if (!existing.includes(fallback)) {
						existingMappings[modelType] = [...existing, fallback];
					}
				} else {
					existingMappings[modelType] = fallback;
				}
			}

			const finalMappings =
				Object.keys(existingMappings).length > 0
					? JSON.stringify(existingMappings)
					: null;

			await db.run(
				"UPDATE accounts SET model_mappings = ?, model_fallbacks = NULL WHERE id = ?",
				[finalMappings, accountId],
			);

			log.info(
				`Merged model fallbacks into model_mappings for account ${accountId}`,
			);

			return jsonResponse({
				success: true,
				message: "Model fallbacks merged into model mappings",
				modelMappings: existingMappings,
			});
		} catch (error) {
			log.error("Account model fallbacks update error:", error);
			return errorResponse(
				error instanceof Error
					? error
					: new Error("Failed to update model fallbacks"),
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
			const db = dbOps.getAdapter();
			const account = await db.get<{
				id: string;
				name: string;
				provider: string;
				access_token: string | null;
			}>("SELECT id, name, provider, access_token FROM accounts WHERE id = ?", [
				accountId,
			]);

			if (!account) {
				return errorResponse(NotFound("Account not found"));
			}

			const resetSuccess = dbOps.forceResetAccountRateLimit(accountId);
			if (!resetSuccess) {
				return errorResponse(
					new Error(
						`Failed to reset rate limit state for account '${account.name}'`,
					),
				);
			}
			clearAccountRefreshCache(accountId);

			// Trigger immediate poll if this server has a polling token provider for the account.
			let usagePollTriggered = await usageCache.refreshNow(accountId);

			// Best-effort fallback: use raw DB token for Anthropic OAuth accounts.
			// Only Anthropic accounts support direct usage fetch via fetchUsageData();
			// other providers (Zai, NanoGPT) use different endpoints handled by their own fetchers.
			// This bypasses token refresh, but is acceptable since this path only runs when
			// no active polling exists and the token is likely fresh from recent proxy requests.
			if (
				!usagePollTriggered &&
				account.provider === "anthropic" &&
				account.access_token
			) {
				const { data: usageData } = await fetchUsageData(account.access_token);
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
			const db = dbOps.getAdapter();
			const account = await db.get<{ name: string; provider: string }>(
				"SELECT name, provider FROM accounts WHERE id = ?",
				[accountId],
			);

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

/**
 * Check if an AWS profile exists in ~/.aws/credentials
 */
function checkAwsProfileExists(profile: string): boolean {
	try {
		const credentialsPath = join(homedir(), ".aws", "credentials");
		if (!existsSync(credentialsPath)) {
			return false;
		}
		const content = readFileSync(credentialsPath, "utf-8");
		// Match [profile] section header (handles default and named profiles)
		const profileRegex = new RegExp(`^\\[${profile}\\]`, "m");
		return profileRegex.test(content);
	} catch {
		return false;
	}
}

/**
 * Read region from ~/.aws/config for a given profile
 * AWS config format: [profile <name>] for named profiles, [default] for default
 */
function readAwsRegion(profile: string): string | null {
	try {
		const configPath = join(homedir(), ".aws", "config");
		if (!existsSync(configPath)) {
			return null;
		}
		const content = readFileSync(configPath, "utf-8");
		// In ~/.aws/config, the default profile is [default], named profiles are [profile <name>]
		const sectionHeader =
			profile === "default" ? "\\[default\\]" : `\\[profile ${profile}\\]`;
		const sectionRegex = new RegExp(`${sectionHeader}[\\s\\S]*?(?=\\[|$)`);
		const sectionMatch = content.match(sectionRegex);
		if (!sectionMatch) return null;
		const regionMatch = sectionMatch[0].match(/^region\s*=\s*(.+)$/m);
		return regionMatch ? regionMatch[1].trim() : null;
	} catch {
		return null;
	}
}

/**
 * Create an AWS profiles list handler
 * Returns all AWS profiles from ~/.aws/credentials with their regions
 */
export function createAwsProfilesListHandler() {
	return async (): Promise<Response> => {
		try {
			const credentialsPath = join(homedir(), ".aws", "credentials");

			// If credentials file doesn't exist, return empty array
			if (!existsSync(credentialsPath)) {
				log.debug("AWS credentials file not found");
				return jsonResponse([]);
			}

			// Read and parse credentials file
			const content = readFileSync(credentialsPath, "utf-8");
			const profiles: Array<{ name: string; region: string | null }> = [];

			// Match all profile sections [profile-name]
			const profileMatches = content.matchAll(/^\[([^\]]+)\]/gm);

			for (const match of profileMatches) {
				const profileName = match[1];
				// Try to read region from config
				const region = readAwsRegion(profileName);
				profiles.push({ name: profileName, region });
			}

			log.debug(`Found ${profiles.length} AWS profiles`);
			return jsonResponse(profiles);
		} catch (error) {
			log.error("Failed to list AWS profiles:", error);
			// Return empty array on error instead of failing
			return jsonResponse([]);
		}
	};
}

/**
 * Create a Bedrock account add handler
 */
export function createBedrockAccountAddHandler(dbOps: DatabaseOperations) {
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
					"can only contain letters, numbers, spaces, hyphens, underscores, and dots",
				transform: sanitizers.trim,
			});

			if (!name) {
				return errorResponse(BadRequest("Account name is required"));
			}

			// Validate profile
			const profile = validateString(body.profile, "profile", {
				required: true,
				minLength: 1,
				transform: sanitizers.trim,
			});

			if (!profile) {
				return errorResponse(BadRequest("AWS profile is required"));
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

			// Validate cross_region_mode
			const crossRegionMode = body.cross_region_mode ?? "geographic";
			if (
				crossRegionMode !== "geographic" &&
				crossRegionMode !== "global" &&
				crossRegionMode !== "regional"
			) {
				return errorResponse(
					BadRequest(
						"cross_region_mode must be one of: geographic, global, regional",
					),
				);
			}

			// Validate custom model (optional)
			const customModel = body.customModel
				? validateString(body.customModel, "customModel", {
						required: false,
						minLength: 1,
						maxLength: 200,
						transform: sanitizers.trim,
					})
				: undefined;

			// Build model_mappings JSON if custom model specified
			let modelMappings: string | null = null;
			if (customModel) {
				modelMappings = JSON.stringify({ custom: customModel });
			}

			// Check if AWS profile exists
			if (!checkAwsProfileExists(profile)) {
				return errorResponse(
					BadRequest(
						`AWS profile '${profile}' not found. Check ~/.aws/credentials or run: aws configure --profile ${profile}`,
					),
				);
			}

			// Store profile and region in custom_endpoint as "bedrock:profile:region"
			const bedrockConfig = `bedrock:${profile}:${region}`;

			// Create Bedrock account directly in database
			const accountId = crypto.randomUUID();
			const now = Date.now();
			const oneYearFromNow = now + 365 * 24 * 60 * 60 * 1000; // 1 year expiry
			const db = dbOps.getAdapter();
			await db.run(
				`INSERT INTO accounts (
					id, name, provider, api_key, refresh_token, access_token,
					expires_at, created_at, request_count, total_requests, priority, custom_endpoint, cross_region_mode, model_mappings
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				[
					accountId,
					name,
					"bedrock",
					null, // No API key - uses AWS credentials
					"", // Empty refresh token
					null, // No access token
					oneYearFromNow, // Set expiry to 1 year from now
					now,
					0,
					0,
					priority,
					bedrockConfig,
					crossRegionMode,
					modelMappings,
				],
			);

			log.info(
				`Successfully added Bedrock account: ${name} (Profile: ${profile}, Region: ${region}, CrossRegionMode: ${crossRegionMode}, Priority ${priority}${customModel ? `, CustomModel: ${customModel}` : ""})`,
			);

			// Get the created account for response
			const account = await db.get<{
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
			}>(
				`SELECT
					id, name, provider, request_count, total_requests,
					last_used, created_at, expires_at, refresh_token,
					COALESCE(paused, 0) as paused
				FROM accounts WHERE id = ?`,
				[accountId],
			);

			if (!account) {
				return errorResponse(
					InternalServerError("Failed to retrieve created account"),
				);
			}

			return jsonResponse({
				message: `Bedrock account '${name}' added successfully`,
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
					mode: "bedrock",
					paused: account.paused === 1,
					cross_region_mode: crossRegionMode,
				},
			});
		} catch (error) {
			log.error("Failed to add Bedrock account:", error);
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

/**
 * Create a Kilo Gateway account add handler
 */
export function createKiloAccountAddHandler(dbOps: DatabaseOperations) {
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
					"can only contain letters, numbers, spaces, hyphens, underscores, and dots",
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

			// Validate and sanitize model mappings if provided
			let validatedModelMappings = null;
			if (body.modelMappings && typeof body.modelMappings === "object") {
				try {
					const sanitized = validateAndSanitizeModelMappings(
						body.modelMappings,
					);
					if (sanitized && Object.keys(sanitized).length > 0) {
						validatedModelMappings = JSON.stringify(sanitized);
					}
				} catch (err) {
					return errorResponse(
						BadRequest(
							`Invalid model mappings: ${err instanceof Error ? err.message : String(err)}`,
						),
					);
				}
			}

			// Create Kilo account in database
			const accountId = crypto.randomUUID();
			const now = Date.now();
			const db = dbOps.getAdapter();
			await db.run(
				`INSERT INTO accounts (
					id, name, provider, api_key, refresh_token, access_token,
					expires_at, created_at, request_count, total_requests, priority, custom_endpoint, model_mappings
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				[
					accountId,
					name,
					"kilo",
					apiKey,
					null,
					null,
					now + 365 * 24 * 60 * 60 * 1000,
					now,
					0,
					0,
					priority,
					null,
					validatedModelMappings,
				],
			);

			log.info(
				`Successfully added Kilo Gateway account: ${name} (Priority ${priority})`,
			);

			const account = await db.get<{
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
			}>(
				`SELECT
					id, name, provider, request_count, total_requests,
					last_used, created_at, expires_at, refresh_token,
					COALESCE(paused, 0) as paused
				FROM accounts WHERE id = ?`,
				[accountId],
			);

			if (!account) {
				return errorResponse(
					InternalServerError("Failed to retrieve created account"),
				);
			}

			return jsonResponse({
				message: `Kilo Gateway account '${name}' added successfully`,
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
					rateLimitedUntil: null,
					sessionInfo: "No active session",
					hasRefreshToken: false,
				},
			});
		} catch (error) {
			log.error("Kilo Gateway account creation error:", error);
			return errorResponse(
				error instanceof Error
					? error
					: new Error("Failed to create Kilo Gateway account"),
			);
		}
	};
}

/**
 * Create an Alibaba Coding Plan account add handler
 */
export function createAlibabaCodingPlanAccountAddHandler(
	dbOps: DatabaseOperations,
) {
	return async (req: Request): Promise<Response> => {
		try {
			const body = await req.json();

			const name = validateString(body.name, "name", {
				required: true,
				minLength: 1,
				maxLength: 100,
				pattern: patterns.accountName,
				patternErrorMessage:
					"can only contain letters, numbers, spaces, hyphens, underscores, and dots",
				transform: sanitizers.trim,
			});

			if (!name) {
				return errorResponse(BadRequest("Account name is required"));
			}

			const apiKey = validateString(body.apiKey, "apiKey", {
				required: true,
				minLength: 1,
			});

			if (!apiKey) {
				return errorResponse(BadRequest("API key is required"));
			}

			const priority =
				validateNumber(body.priority, "priority", {
					min: 0,
					max: 100,
					integer: true,
				}) || 0;

			let validatedModelMappings = null;
			if (body.modelMappings && typeof body.modelMappings === "object") {
				try {
					const sanitized = validateAndSanitizeModelMappings(
						body.modelMappings,
					);
					if (sanitized && Object.keys(sanitized).length > 0) {
						validatedModelMappings = JSON.stringify(sanitized);
					}
				} catch (err) {
					return errorResponse(
						BadRequest(
							`Invalid model mappings: ${err instanceof Error ? err.message : String(err)}`,
						),
					);
				}
			}

			const accountId = crypto.randomUUID();
			const now = Date.now();
			const db = dbOps.getAdapter();
			await db.run(
				`INSERT INTO accounts (
					id, name, provider, api_key, refresh_token, access_token,
					expires_at, created_at, request_count, total_requests, priority, custom_endpoint, model_mappings
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				[
					accountId,
					name,
					"alibaba-coding-plan",
					apiKey,
					apiKey,
					apiKey,
					now + 365 * 24 * 60 * 60 * 1000,
					now,
					0,
					0,
					priority,
					null,
					validatedModelMappings,
				],
			);

			log.info(
				`Successfully added Alibaba Coding Plan account: ${name} (Priority ${priority})`,
			);

			const account = await db.get<{
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
			}>(
				`SELECT
					id, name, provider, request_count, total_requests,
					last_used, created_at, expires_at, refresh_token,
					COALESCE(paused, 0) as paused
				FROM accounts WHERE id = ?`,
				[accountId],
			);

			if (!account) {
				return errorResponse(
					InternalServerError("Failed to retrieve created account"),
				);
			}

			return jsonResponse({
				message: `Alibaba Coding Plan account '${name}' added successfully`,
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
					rateLimitedUntil: null,
					sessionInfo: "No active session",
					hasRefreshToken: false,
				},
			});
		} catch (error) {
			log.error("Alibaba Coding Plan account creation error:", error);
			return errorResponse(
				error instanceof Error
					? error
					: new Error("Failed to create Alibaba Coding Plan account"),
			);
		}
	};
}

/**
 * Create an OpenRouter account add handler
 */
export function createOpenRouterAccountAddHandler(dbOps: DatabaseOperations) {
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
					"can only contain letters, numbers, spaces, hyphens, underscores, and dots",
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

			// Create OpenRouter account in database
			const accountId = crypto.randomUUID();
			const now = Date.now();
			const db = dbOps.getAdapter();
			await db.run(
				`INSERT INTO accounts (
					id, name, provider, api_key, refresh_token, access_token,
					expires_at, created_at, request_count, total_requests, priority, custom_endpoint, model_mappings
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				[
					accountId,
					name,
					"openrouter",
					apiKey,
					null,
					null,
					now + 365 * 24 * 60 * 60 * 1000,
					now,
					0,
					0,
					priority,
					null,
					modelMappings,
				],
			);

			log.info(
				`Successfully added OpenRouter account: ${name} (Priority ${priority})`,
			);

			const account = await db.get<{
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
			}>(
				`SELECT
					id, name, provider, request_count, total_requests,
					last_used, created_at, expires_at, refresh_token,
					COALESCE(paused, 0) as paused
				FROM accounts WHERE id = ?`,
				[accountId],
			);

			if (!account) {
				return errorResponse(
					InternalServerError("Failed to retrieve created account"),
				);
			}

			return jsonResponse({
				message: `OpenRouter account '${name}' added successfully`,
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
					rateLimitedUntil: null,
					sessionInfo: "No active session",
					hasRefreshToken: false,
				},
			});
		} catch (error) {
			log.error("OpenRouter account creation error:", error);
			if (error instanceof ValidationError) {
				return errorResponse(BadRequest(error.message));
			}
			return errorResponse(
				error instanceof Error
					? error
					: new Error("Failed to create OpenRouter account"),
			);
		}
	};
}

/**
 * Force an immediate usage data refresh for an OAuth account.
 *
 * For Anthropic accounts this restarts the free `/api/oauth/usage` polling
 * loop. For Codex accounts there is no free usage endpoint, so this sends a
 * minimal real `/responses` request (capped via `max_output_tokens: 1` and
 * abort-after-headers) and parses the `x-codex-*` headers off the response.
 */
export function createAccountRefreshUsageHandler(dbOps: DatabaseOperations) {
	return async (_req: Request, accountId: string): Promise<Response> => {
		try {
			const account = await dbOps.getAccount(accountId);

			if (!account) {
				return errorResponse(NotFound("Account not found"));
			}

			if (account.provider !== "anthropic" && account.provider !== "codex") {
				return errorResponse(
					BadRequest(
						"Usage refresh is only available for Anthropic OAuth and Codex accounts",
					),
				);
			}

			if (!account.access_token && !account.refresh_token) {
				return errorResponse(
					BadRequest(
						`Account '${account.name}' has no tokens - please re-authenticate`,
					),
				);
			}

			if (account.provider === "codex") {
				const outcome = await refreshCodexUsageForAccount(accountId);
				log.info(
					`Codex usage refresh requested for account '${account.name}' (success: ${outcome.success})`,
				);
				return jsonResponse({
					success: outcome.success,
					message: outcome.message,
					pollingRestarted: false,
				});
			}

			clearAccountRefreshCache(accountId);
			const pollingRestarted = await restartUsagePollingForAccount(accountId);
			const cacheRefreshed = await usageCache.refreshNow(accountId);

			log.info(
				`Usage refresh requested for account '${account.name}' (polling restarted: ${pollingRestarted}, cache refreshed: ${cacheRefreshed})`,
			);

			return jsonResponse({
				success: true,
				message: pollingRestarted
					? `Usage polling restarted for account '${account.name}'. Fresh usage data is now available.`
					: cacheRefreshed
						? `Usage cache refreshed for account '${account.name}'.`
						: `Polling could not be restarted for account '${account.name}' — usage data may not update.`,
				pollingRestarted,
				cacheRefreshed,
			});
		} catch (error) {
			log.error("Account refresh usage error:", error);
			return errorResponse(
				error instanceof Error
					? error
					: new Error("Failed to refresh usage data"),
			);
		}
	};
}
