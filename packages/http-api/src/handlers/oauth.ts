import crypto from "node:crypto";
import { Config } from "@better-ccflare/config";
import {
	patterns,
	validatePriority,
	validateString,
} from "@better-ccflare/core";
import type { DatabaseOperations } from "@better-ccflare/database";
import {
	BadRequest,
	errorResponse,
	InternalServerError,
	jsonResponse,
	NotFound,
} from "@better-ccflare/http-common";
import { Logger } from "@better-ccflare/logger";
import { createOAuthFlow } from "@better-ccflare/oauth-flow";
import {
	initiateCodexDeviceFlow,
	pollCodexForToken,
} from "@better-ccflare/providers/codex";
import {
	initiateDeviceFlow as initiateQwenDeviceFlow,
	pollForToken as pollQwenForToken,
} from "@better-ccflare/providers/qwen";

const log = new Logger("OAuthHandler");

// In-memory session store for Qwen device flow
type QwenSession =
	| { status: "pending"; accountName: string }
	| { status: "complete"; accountName: string }
	| { status: "error"; accountName: string; error: string };

const qwenSessions = new Map<string, QwenSession>();

function normalizeQwenBaseUrl(url: string): string {
	let normalized = url.trim();
	if (!normalized.startsWith("http")) {
		normalized = `https://${normalized}`;
	}
	if (!normalized.endsWith("/v1")) {
		normalized = `${normalized}/v1`;
	}
	return normalized;
}

/**
 * Create a Qwen device flow initialization handler.
 * Returns { authUrl, userCode, sessionId } immediately, then polls in background.
 */
export function createQwenDeviceFlowInitHandler(dbOps: DatabaseOperations) {
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
			});

			if (!name) {
				return errorResponse(BadRequest("Valid account name is required"));
			}

			const priority = validatePriority(body.priority ?? 0, "priority");

			let deviceFlow: Awaited<ReturnType<typeof initiateQwenDeviceFlow>>;
			try {
				deviceFlow = await initiateQwenDeviceFlow();
			} catch (err) {
				log.error("Qwen device flow initiation failed:", err);
				return errorResponse(
					InternalServerError(
						`Failed to initiate Qwen device flow: ${(err as Error).message}`,
					),
				);
			}

			const sessionId = crypto.randomUUID();
			qwenSessions.set(sessionId, { status: "pending", accountName: name });

			// Poll in background — do not await
			(async () => {
				try {
					const tokens = await pollQwenForToken(
						deviceFlow.deviceCode,
						deviceFlow.pkce,
						deviceFlow.interval,
						60,
					);

					const accountId = crypto.randomUUID();
					const now = Date.now();
					const resourceUrl = tokens.resource_url
						? normalizeQwenBaseUrl(tokens.resource_url)
						: null;

					await dbOps.getAdapter().run(
						`INSERT INTO accounts (
							id, name, provider, api_key, refresh_token, access_token,
							expires_at, created_at, request_count, total_requests, priority,
							custom_endpoint, model_mappings, model_fallbacks
						) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?, ?, ?)`,
						[
							accountId,
							name,
							"qwen",
							null,
							tokens.refresh_token,
							tokens.access_token,
							now + tokens.expires_in * 1000,
							now,
							priority,
							resourceUrl,
							null,
							null,
						],
					);

					qwenSessions.set(sessionId, {
						status: "complete",
						accountName: name,
					});
					log.info(`Qwen account '${name}' added via web device flow`);

					// Clean up session after 10 minutes
					setTimeout(() => qwenSessions.delete(sessionId), 10 * 60 * 1000);
				} catch (err) {
					log.error(`Qwen device flow polling failed for '${name}':`, err);
					qwenSessions.set(sessionId, {
						status: "error",
						accountName: name,
						error: (err as Error).message,
					});
					setTimeout(() => qwenSessions.delete(sessionId), 10 * 60 * 1000);
				}
			})();

			return jsonResponse({
				success: true,
				sessionId,
				authUrl:
					deviceFlow.verificationUriComplete || deviceFlow.verificationUri,
				userCode: deviceFlow.userCode,
			});
		} catch (error) {
			log.error("Qwen device flow init error:", error);
			return errorResponse(
				error instanceof Error
					? error
					: new Error("Failed to initialize Qwen device flow"),
			);
		}
	};
}

/**
 * Create a Qwen device flow status handler.
 * Returns { status, error? } for the given sessionId.
 */
export function createQwenDeviceFlowStatusHandler() {
	return (sessionId: string): Response => {
		const session = qwenSessions.get(sessionId);
		if (!session) {
			return errorResponse(NotFound("Session not found or expired"));
		}
		if (session.status === "error") {
			return jsonResponse({ status: "error", error: session.error });
		}
		return jsonResponse({ status: session.status });
	};
}

/**
 * Create a Qwen re-authentication handler.
 * Re-runs the device flow for an existing account, updating tokens in-place.
 * Returns { authUrl, userCode, sessionId } immediately, then polls in background.
 */
export function createQwenReauthHandler(dbOps: DatabaseOperations) {
	return async (req: Request): Promise<Response> => {
		try {
			const body = await req.json();

			const accountId = validateString(body.accountId, "accountId", {
				required: true,
				minLength: 1,
				maxLength: 100,
			});

			if (!accountId) {
				return errorResponse(BadRequest("Valid accountId is required"));
			}

			// Look up the account
			const account = await dbOps.getAdapter().get<{
				id: string;
				name: string;
				provider: string;
				custom_endpoint: string | null;
			}>(
				"SELECT id, name, provider, custom_endpoint FROM accounts WHERE id = ?",
				[accountId],
			);

			if (!account) {
				return errorResponse(NotFound("Account not found"));
			}

			if (account.provider !== "qwen") {
				return errorResponse(
					BadRequest(
						"Re-authentication via device flow is only supported for Qwen accounts",
					),
				);
			}

			let deviceFlow: Awaited<ReturnType<typeof initiateQwenDeviceFlow>>;
			try {
				deviceFlow = await initiateQwenDeviceFlow();
			} catch (err) {
				log.error("Qwen reauth device flow initiation failed:", err);
				return errorResponse(
					InternalServerError(
						`Failed to initiate Qwen device flow: ${(err as Error).message}`,
					),
				);
			}

			const sessionId = crypto.randomUUID();
			qwenSessions.set(sessionId, {
				status: "pending",
				accountName: account.name,
			});

			// Poll in background — do not await
			(async () => {
				try {
					const tokens = await pollQwenForToken(
						deviceFlow.deviceCode,
						deviceFlow.pkce,
						deviceFlow.interval,
						60,
					);

					const resourceUrl = tokens.resource_url
						? normalizeQwenBaseUrl(tokens.resource_url)
						: account.custom_endpoint;

					await dbOps.getAdapter().run(
						`UPDATE accounts SET
							refresh_token = ?,
							access_token = ?,
							expires_at = ?,
							custom_endpoint = ?
						WHERE id = ?`,
						[
							tokens.refresh_token,
							tokens.access_token,
							Date.now() + tokens.expires_in * 1000,
							resourceUrl,
							account.id,
						],
					);

					qwenSessions.set(sessionId, {
						status: "complete",
						accountName: account.name,
					});
					log.info(
						`Qwen account '${account.name}' re-authenticated via web device flow`,
					);

					setTimeout(() => qwenSessions.delete(sessionId), 10 * 60 * 1000);
				} catch (err) {
					log.error(`Qwen reauth polling failed for '${account.name}':`, err);
					qwenSessions.set(sessionId, {
						status: "error",
						accountName: account.name,
						error: (err as Error).message,
					});
					setTimeout(() => qwenSessions.delete(sessionId), 10 * 60 * 1000);
				}
			})();

			return jsonResponse({
				success: true,
				sessionId,
				authUrl:
					deviceFlow.verificationUriComplete || deviceFlow.verificationUri,
				userCode: deviceFlow.userCode,
			});
		} catch (error) {
			log.error("Qwen reauth error:", error);
			return errorResponse(
				error instanceof Error
					? error
					: new Error("Failed to initialize Qwen re-authentication"),
			);
		}
	};
}

// In-memory session store for Codex device flow
type CodexSession =
	| { status: "pending"; accountName: string }
	| { status: "complete"; accountName: string }
	| { status: "error"; accountName: string; error: string };

const codexSessions = new Map<string, CodexSession>();

/**
 * Create a Codex device flow initialization handler.
 * Returns { verificationUrl, userCode, sessionId } immediately, then polls in background.
 */
export function createCodexDeviceFlowInitHandler(dbOps: DatabaseOperations) {
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
			});

			if (!name) {
				return errorResponse(BadRequest("Valid account name is required"));
			}

			const priority = validatePriority(body.priority ?? 0, "priority");

			let deviceFlow: Awaited<ReturnType<typeof initiateCodexDeviceFlow>>;
			try {
				deviceFlow = await initiateCodexDeviceFlow();
			} catch (err) {
				log.error("Codex device flow initiation failed:", err);
				return errorResponse(
					InternalServerError(
						`Failed to initiate Codex device flow: ${(err as Error).message}`,
					),
				);
			}

			const sessionId = crypto.randomUUID();
			codexSessions.set(sessionId, { status: "pending", accountName: name });

			// Poll in background — do not await
			(async () => {
				try {
					const tokens = await pollCodexForToken(
						deviceFlow.deviceAuthId,
						deviceFlow.userCode,
						deviceFlow.interval,
						180,
					);

					const accountId = crypto.randomUUID();
					const now = Date.now();

					await dbOps.getAdapter().run(
						`INSERT INTO accounts (
							id, name, provider, api_key, refresh_token, access_token,
							expires_at, created_at, request_count, total_requests, priority,
							custom_endpoint, model_mappings, model_fallbacks
						) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?, ?, ?)`,
						[
							accountId,
							name,
							"codex",
							null,
							tokens.refresh_token,
							tokens.access_token,
							now + tokens.expires_in * 1000,
							now,
							priority,
							null,
							null,
							null,
						],
					);

					codexSessions.set(sessionId, {
						status: "complete",
						accountName: name,
					});
					log.info(`Codex account '${name}' added via web device flow`);

					setTimeout(() => codexSessions.delete(sessionId), 10 * 60 * 1000);
				} catch (err) {
					log.error(`Codex device flow polling failed for '${name}':`, err);
					codexSessions.set(sessionId, {
						status: "error",
						accountName: name,
						error: (err as Error).message,
					});
					setTimeout(() => codexSessions.delete(sessionId), 10 * 60 * 1000);
				}
			})();

			return jsonResponse({
				success: true,
				sessionId,
				verificationUrl: deviceFlow.verificationUrl,
				userCode: deviceFlow.userCode,
			});
		} catch (error) {
			log.error("Codex device flow init error:", error);
			return errorResponse(
				error instanceof Error
					? error
					: new Error("Failed to initialize Codex device flow"),
			);
		}
	};
}

/**
 * Create a Codex re-authentication handler.
 * Re-runs the device flow for an existing Codex account, updating tokens in-place.
 * Returns { verificationUrl, userCode, sessionId } immediately, then polls in background.
 */
export function createCodexReauthHandler(dbOps: DatabaseOperations) {
	return async (req: Request): Promise<Response> => {
		try {
			const body = await req.json();

			const accountId = validateString(body.accountId, "accountId", {
				required: true,
				minLength: 1,
				maxLength: 100,
			});

			if (!accountId) {
				return errorResponse(BadRequest("Valid accountId is required"));
			}

			// Look up the account
			const account = await dbOps.getAdapter().get<{
				id: string;
				name: string;
				provider: string;
			}>("SELECT id, name, provider FROM accounts WHERE id = ?", [accountId]);

			if (!account) {
				return errorResponse(NotFound("Account not found"));
			}

			if (account.provider !== "codex") {
				return errorResponse(
					BadRequest(
						"Re-authentication via device flow is only supported for Codex accounts",
					),
				);
			}

			let deviceFlow: Awaited<ReturnType<typeof initiateCodexDeviceFlow>>;
			try {
				deviceFlow = await initiateCodexDeviceFlow();
			} catch (err) {
				log.error("Codex reauth device flow initiation failed:", err);
				return errorResponse(
					InternalServerError(
						`Failed to initiate Codex device flow: ${(err as Error).message}`,
					),
				);
			}

			const sessionId = crypto.randomUUID();
			codexSessions.set(sessionId, {
				status: "pending",
				accountName: account.name,
			});

			// Poll in background — do not await
			(async () => {
				try {
					const tokens = await pollCodexForToken(
						deviceFlow.deviceAuthId,
						deviceFlow.userCode,
						deviceFlow.interval,
						180,
					);

					await dbOps.getAdapter().run(
						`UPDATE accounts SET
							refresh_token = ?,
							access_token = ?,
							expires_at = ?
						WHERE id = ?`,
						[
							tokens.refresh_token,
							tokens.access_token,
							Date.now() + tokens.expires_in * 1000,
							account.id,
						],
					);

					codexSessions.set(sessionId, {
						status: "complete",
						accountName: account.name,
					});
					log.info(
						`Codex account '${account.name}' re-authenticated via web device flow`,
					);

					setTimeout(() => codexSessions.delete(sessionId), 10 * 60 * 1000);
				} catch (err) {
					log.error(`Codex reauth polling failed for '${account.name}':`, err);
					codexSessions.set(sessionId, {
						status: "error",
						accountName: account.name,
						error: (err as Error).message,
					});
					setTimeout(() => codexSessions.delete(sessionId), 10 * 60 * 1000);
				}
			})();

			return jsonResponse({
				success: true,
				sessionId,
				verificationUrl: deviceFlow.verificationUrl,
				userCode: deviceFlow.userCode,
			});
		} catch (error) {
			log.error("Codex reauth error:", error);
			return errorResponse(
				error instanceof Error
					? error
					: new Error("Failed to initialize Codex re-authentication"),
			);
		}
	};
}

/**
 * Create a Codex device flow status handler.
 * Returns { status, error? } for the given sessionId.
 */
export function createCodexDeviceFlowStatusHandler() {
	return (sessionId: string): Response => {
		const session = codexSessions.get(sessionId);
		if (!session) {
			return errorResponse(NotFound("Session not found or expired"));
		}
		if (session.status === "error") {
			return jsonResponse({ status: "error", error: session.error });
		}
		return jsonResponse({ status: session.status });
	};
}

/**
 * Create an Anthropic re-authentication init handler.
 * Starts an OAuth flow for an existing Anthropic (claude-oauth) account.
 * Returns { authUrl, sessionId } immediately.
 */
export function createAnthropicReauthInitHandler(
	dbOps: DatabaseOperations,
	config: Config,
) {
	return async (req: Request): Promise<Response> => {
		try {
			const body = await req.json();

			const accountId = validateString(body.accountId, "accountId", {
				required: true,
				minLength: 1,
				maxLength: 100,
			});

			if (!accountId) {
				return errorResponse(BadRequest("Valid accountId is required"));
			}

			// Look up the account
			const account = await dbOps.getAdapter().get<{
				id: string;
				name: string;
				provider: string;
				refresh_token: string | null;
			}>(
				"SELECT id, name, provider, refresh_token FROM accounts WHERE id = ?",
				[accountId],
			);

			if (!account) {
				return errorResponse(NotFound("Account not found"));
			}

			if (account.provider !== "anthropic") {
				return errorResponse(
					BadRequest(
						"Re-authentication is only supported for Anthropic OAuth accounts",
					),
				);
			}

			const oauthFlow = await createOAuthFlow(dbOps, config);

			try {
				const flowResult = await oauthFlow.begin({
					name: account.name,
					mode: "claude-oauth",
					skipAccountCheck: true,
				});

				// Store session; use accountName field so callback can look it up by name
				dbOps.createOAuthSession(
					flowResult.sessionId,
					account.name,
					flowResult.pkce.verifier,
					"claude-oauth",
					undefined, // customEndpoint
					0, // priority — reauth preserves existing account's priority via UPDATE, this is unused
					10, // ttlMinutes
				);

				return jsonResponse({
					success: true,
					authUrl: flowResult.authUrl,
					sessionId: flowResult.sessionId,
				});
			} catch (error) {
				return errorResponse(InternalServerError((error as Error).message));
			}
		} catch (error) {
			log.error("Anthropic reauth init error:", error);
			return errorResponse(
				error instanceof Error
					? error
					: new Error("Failed to initialize Anthropic re-authentication"),
			);
		}
	};
}

/**
 * Create an Anthropic re-authentication callback handler.
 * Exchanges the authorization code and UPDATEs existing account tokens in place.
 */
export function createAnthropicReauthCallbackHandler(
	dbOps: DatabaseOperations,
	config: Config,
) {
	return async (req: Request): Promise<Response> => {
		if (req.method !== "POST") {
			return errorResponse(
				BadRequest("Only POST requests are supported for OAuth callback"),
			);
		}

		try {
			const body = await req.json();

			const sessionId = validateString(body.sessionId, "sessionId", {
				required: true,
				pattern: patterns.uuid,
			});
			if (!sessionId) {
				return errorResponse(BadRequest("Valid sessionId is required"));
			}

			const code = validateString(body.code, "code", {
				required: true,
				minLength: 1,
			});
			if (!code) {
				return errorResponse(BadRequest("Valid code is required"));
			}

			// Get stored session
			const oauthSession = await dbOps.getOAuthSession(sessionId);
			if (!oauthSession) {
				return errorResponse(
					BadRequest("OAuth session expired or invalid. Please try again."),
				);
			}

			const { accountName: name, verifier } = oauthSession;

			// Look up the account by name to get its id for the UPDATE
			const account = await dbOps
				.getAdapter()
				.get<{ id: string }>("SELECT id FROM accounts WHERE name = ?", [name]);
			if (!account) {
				return errorResponse(
					BadRequest(`Account '${name}' not found. It may have been deleted.`),
				);
			}

			try {
				const oauthFlow = await createOAuthFlow(dbOps, config);

				const oauthProvider = await import("@better-ccflare/providers").then(
					(m) => m.getOAuthProvider("anthropic"),
				);
				if (!oauthProvider) {
					throw new Error("OAuth provider not found");
				}
				const runtime = config.getRuntime();
				const oauthConfig = oauthProvider.getOAuthConfig("claude-oauth");
				oauthConfig.clientId = runtime.clientId;

				const flowData = {
					sessionId,
					authUrl: "",
					pkce: { verifier, challenge: "" },
					oauthConfig,
					mode: "claude-oauth" as const,
				};

				log.debug(`Completing Anthropic reauth for account '${name}'`);

				await oauthFlow.completeReauth(
					{ sessionId, code, name, id: account.id },
					flowData,
				);

				dbOps.deleteOAuthSession(sessionId);

				log.info(`Successfully re-authenticated Anthropic account '${name}'`);

				return jsonResponse({
					success: true,
					message: `Account '${name}' re-authenticated successfully!`,
				});
			} catch (error) {
				log.error(
					`Anthropic reauth callback failed for account '${name}':`,
					error,
				);
				return errorResponse(
					error instanceof Error
						? error
						: new Error("Failed to complete Anthropic re-authentication"),
				);
			}
		} catch (error) {
			log.error("Anthropic reauth callback validation error:", error);
			return errorResponse(
				error instanceof Error
					? error
					: new Error("Failed to process Anthropic reauth callback"),
			);
		}
	};
}

/**
 * Create an OAuth initialization handler
 */
export function createOAuthInitHandler(dbOps: DatabaseOperations) {
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
			});

			if (!name) {
				return errorResponse(BadRequest("Valid account name is required"));
			}

			// Validate mode (with backward compatibility for deprecated "max" mode)
			let mode = (validateString(body.mode, "mode", {
				allowedValues: ["claude-oauth", "console", "max"] as const,
			}) || "claude-oauth") as "claude-oauth" | "console" | "max";

			// Handle deprecated "max" mode with warning
			if (mode === "max") {
				log.warn(
					'Deprecated mode "max" detected, treating as "claude-oauth". Please update to use "claude-oauth" instead.',
				);
				mode = "claude-oauth";
			}

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

			// Validate priority (0-100, defaults to 0)
			const priority = validatePriority(body.priority ?? 0, "priority");

			const config = new Config();
			const oauthFlow = await createOAuthFlow(dbOps, config);

			try {
				// Begin OAuth flow using consolidated logic
				const flowResult = await oauthFlow.begin({
					name,
					mode,
				});

				// Store custom endpoint and priority in session so the callback
				// can forward them to oauthFlow.complete() when creating the account.
				dbOps.createOAuthSession(
					flowResult.sessionId,
					name,
					flowResult.pkce.verifier,
					mode,
					customEndpoint,
					priority,
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
		} catch (error) {
			log.error("OAuth init error:", error);
			return errorResponse(
				error instanceof Error
					? error
					: new Error("Failed to initialize OAuth"),
			);
		}
	};
}

/**
 * Create an OAuth callback handler
 */
export function createOAuthCallbackHandler(dbOps: DatabaseOperations) {
	return async (req: Request): Promise<Response> => {
		// Validate HTTP method - only POST is supported
		if (req.method !== "POST") {
			return errorResponse(
				BadRequest("Only POST requests are supported for OAuth callback"),
			);
		}

		try {
			const body = await req.json();

			// Validate session ID - validateString throws ValidationError if invalid
			const sessionId = validateString(body.sessionId, "sessionId", {
				required: true,
				pattern: patterns.uuid,
			})!;

			// Validate code - validateString throws ValidationError if invalid
			const code = validateString(body.code, "code", {
				required: true,
				minLength: 1,
			})!;

			// Get stored PKCE verifier from database
			const oauthSession = await dbOps.getOAuthSession(sessionId);
			if (!oauthSession) {
				return errorResponse(
					BadRequest("OAuth session expired or invalid. Please try again."),
				);
			}

			const {
				accountName: name,
				verifier,
				mode: savedMode,
				customEndpoint: savedCustomEndpoint,
				priority: savedPriority,
			} = oauthSession;

			try {
				// Create OAuth flow instance
				const config = new Config();
				const oauthFlow = await createOAuthFlow(dbOps, config);

				// We need to reconstruct the flow data since we can't pass the full BeginResult through HTTP
				// The OAuth flow will handle the token exchange and account creation
				const oauthProvider = await import("@better-ccflare/providers").then(
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
					mode: savedMode || "claude-oauth", // Add mode to match BeginResult type
				};

				log.debug(
					`Completing OAuth flow for account '${name}' in ${savedMode} mode`,
				);

				await oauthFlow.complete(
					{
						sessionId,
						code,
						name,
						priority: savedPriority,
						customEndpoint: savedCustomEndpoint,
					},
					flowData,
				);

				// Clean up OAuth session from database
				dbOps.deleteOAuthSession(sessionId);

				log.info(`Successfully added account '${name}' via OAuth`);

				return jsonResponse({
					success: true,
					message: `Account '${name}' added successfully!`,
					mode:
						savedMode === "claude-oauth"
							? "Claude CLI OAuth"
							: "Claude Console",
				});
			} catch (error) {
				log.error(`OAuth flow completion failed for account '${name}':`, error);
				return errorResponse(
					error instanceof Error
						? error
						: new Error("Failed to complete OAuth flow"),
				);
			}
		} catch (error) {
			log.error("OAuth callback validation error:", error);
			// Return the validation error as-is to show the specific error message
			return errorResponse(
				error instanceof Error
					? error
					: new Error("Failed to process OAuth callback"),
			);
		}
	};
}
