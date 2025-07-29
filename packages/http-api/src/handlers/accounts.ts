import type { Database } from "bun:sqlite";
import * as cliCommands from "@claudeflare/cli-commands";
import { Config } from "@claudeflare/config";
import {
	patterns,
	sanitizers,
	validateNumber,
	validateString,
} from "@claudeflare/core";
import type { DatabaseOperations } from "@claudeflare/database";
import {
	BadRequest,
	errorResponse,
	InternalServerError,
	jsonResponse,
	NotFound,
} from "@claudeflare/http-common";
import { createOAuthFlow } from "@claudeflare/oauth-flow";
import type { AccountResponse } from "../types";

/**
 * Create an accounts list handler
 */
export function createAccountsListHandler(db: Database) {
	return (): Response => {
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
					rate_limited_until,
					rate_limit_reset,
					rate_limit_status,
					rate_limit_remaining,
					session_start,
					session_request_count,
					COALESCE(account_tier, 1) as account_tier,
					COALESCE(paused, 0) as paused,
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
				ORDER BY request_count DESC
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
			rate_limited_until: number | null;
			rate_limit_reset: number | null;
			rate_limit_status: string | null;
			rate_limit_remaining: number | null;
			session_start: number | null;
			session_request_count: number;
			account_tier: number;
			paused: 0 | 1;
			token_valid: 0 | 1;
			rate_limited: 0 | 1;
			session_info: string | null;
		}>;

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
				tier: account.account_tier,
				paused: account.paused === 1,
				tokenStatus: account.token_valid ? "valid" : "expired",
				rateLimitStatus,
				rateLimitReset: account.rate_limit_reset
					? new Date(account.rate_limit_reset).toISOString()
					: null,
				rateLimitRemaining: account.rate_limit_remaining,
				sessionInfo: account.session_info || "",
			};
		});

		return jsonResponse(response);
	};
}

/**
 * Create an account tier update handler
 */
export function createAccountTierUpdateHandler(dbOps: DatabaseOperations) {
	return async (req: Request, accountId: string): Promise<Response> => {
		try {
			const body = await req.json();

			// Validate tier input
			const tier = validateNumber(body.tier, "tier", {
				required: true,
				allowedValues: [1, 5, 20] as const,
			});

			if (tier === undefined) {
				return errorResponse(BadRequest("Tier is required"));
			}

			dbOps.updateAccountTier(accountId, tier);

			return jsonResponse({ success: true, tier });
		} catch (_error) {
			return errorResponse(
				InternalServerError("Failed to update account tier"),
			);
		}
	};
}

// Session ID generation for OAuth flow
function _generateSessionId(): string {
	return crypto.randomUUID();
}

/**
 * Create an account add handler
 */
export function createAccountAddHandler(dbOps: DatabaseOperations) {
	return async (req: Request): Promise<Response> => {
		try {
			const body = await req.json();

			// Validate step
			const step =
				validateString(body.step, "step", {
					allowedValues: ["init", "callback"] as const,
				}) || "init";

			// Validate account name
			const name = validateString(body.name, "name", {
				required: true,
				minLength: 1,
				maxLength: 100,
				pattern: patterns.accountName,
				transform: sanitizers.trim,
			});

			if (!name) {
				return errorResponse(BadRequest("Account name is required"));
			}

			// Validate mode
			const mode = (validateString(body.mode, "mode", {
				allowedValues: ["max", "console"] as const,
			}) || "max") as "max" | "console";

			// Validate tier
			const tier =
				validateNumber(body.tier, "tier", {
					allowedValues: [1, 5, 20] as const,
				}) || 1;

			// Validate code for callback step
			const code = validateString(body.code, "code", {
				required: step === "callback",
				minLength: step === "callback" ? 1 : undefined,
			});

			// Step 1: Initialize OAuth flow
			if (step === "init") {
				const config = new Config();
				const oauthFlow = await createOAuthFlow(dbOps, config);

				try {
					// Begin OAuth flow using consolidated logic
					const flowResult = await oauthFlow.begin({
						name,
						mode,
					});

					// Store tier in session for later use
					dbOps.createOAuthSession(
						flowResult.sessionId,
						name,
						flowResult.pkce.verifier,
						mode,
						tier,
						10, // 10 minute TTL
					);

					return jsonResponse({
						success: true,
						authUrl: flowResult.authUrl,
						sessionId: flowResult.sessionId,
						step: "authorize",
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
			}

			// Step 2: Handle OAuth callback
			if (step === "callback") {
				// Validate session ID
				const sessionId = validateString(body.sessionId, "sessionId", {
					required: true,
					pattern: patterns.uuid,
				});

				if (!sessionId) {
					return errorResponse(BadRequest("Session ID is required"));
				}

				// Get stored PKCE verifier from database
				const oauthSession = dbOps.getOAuthSession(sessionId);
				if (!oauthSession) {
					return errorResponse(
						BadRequest("OAuth session expired or invalid. Please try again."),
					);
				}

				// Verify account name matches
				if (oauthSession.accountName !== name) {
					return errorResponse(
						BadRequest("Session does not match the account name"),
					);
				}

				const { verifier, mode: savedMode, tier: savedTier } = oauthSession;

				// Ensure code is provided
				if (!code) {
					return errorResponse(BadRequest("Authorization code is required"));
				}

				try {
					// Create OAuth flow instance
					const config = new Config();
					const oauthFlow = await createOAuthFlow(dbOps, config);

					// We need to reconstruct the flow data since we can't pass the full BeginResult through HTTP
					// The OAuth flow will handle the token exchange and account creation
					const oauthProvider = await import("@claudeflare/providers").then(
						(m) => m.getOAuthProvider("anthropic"),
					);
					if (!oauthProvider) {
						throw new Error("OAuth provider not found");
					}
					const runtime = config.getRuntime();
					const oauthConfig = oauthProvider.getOAuthConfig(savedMode);
					oauthConfig.clientId = runtime.clientId;
					
					const flowData = {
						sessionId,
						authUrl: "", // Not needed for complete
						pkce: { verifier, challenge: "" }, // Only verifier is needed
						oauthConfig,
					};

					await oauthFlow.complete(
						{ sessionId, code, tier: savedTier, name },
						flowData,
					);

					// Clean up OAuth session from database
					dbOps.deleteOAuthSession(sessionId);

					return jsonResponse({
						success: true,
						message: `Account '${name}' added successfully!`,
						mode: savedMode === "max" ? "Claude Max" : "Claude Console",
						tier: savedTier,
					});
				} catch (error) {
					return errorResponse(
						error instanceof Error
							? error
							: new Error("Failed to complete OAuth flow"),
					);
				}
			}

			return errorResponse(BadRequest("Invalid step"));
		} catch (error) {
			console.error("Account add error:", error);
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
