import { Config } from "@better-ccflare/config";
import { patterns, validateString } from "@better-ccflare/core";
import type { DatabaseOperations } from "@better-ccflare/database";
import {
	BadRequest,
	errorResponse,
	InternalServerError,
	jsonResponse,
} from "@better-ccflare/http-common";
import { Logger } from "@better-ccflare/logger";
import { createOAuthFlow } from "@better-ccflare/oauth-flow";

const log = new Logger("OAuthHandler");

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
			});

			if (!name) {
				return errorResponse(BadRequest("Valid account name is required"));
			}

			// Validate mode
			const mode = (validateString(body.mode, "mode", {
				allowedValues: ["max", "console"] as const,
			}) || "max") as "max" | "console";

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

			const config = new Config();
			const oauthFlow = await createOAuthFlow(dbOps, config);

			try {
				// Begin OAuth flow using consolidated logic
				const flowResult = await oauthFlow.begin({
					name,
					mode,
				});

				// Store custom endpoint in session for later use
				dbOps.createOAuthSession(
					flowResult.sessionId,
					name,
					flowResult.pkce.verifier,
					mode,
					customEndpoint,
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
		try {
			const body = await req.json();

			// Validate session ID
			const sessionId = validateString(body.sessionId, "sessionId", {
				required: true,
				pattern: patterns.uuid,
			});

			if (!sessionId) {
				return errorResponse(BadRequest("Session ID is required"));
			}

			// Validate code
			const code = validateString(body.code, "code", {
				required: true,
				minLength: 1,
			});

			if (!code) {
				return errorResponse(BadRequest("Authorization code is required"));
			}

			// Get stored PKCE verifier from database
			const oauthSession = dbOps.getOAuthSession(sessionId);
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
					mode: savedMode || "max", // Add mode to match BeginResult type
				};

				await oauthFlow.complete(
					{
						sessionId,
						code,
						name,
						customEndpoint: savedCustomEndpoint,
					},
					flowData,
				);

				// Clean up OAuth session from database
				dbOps.deleteOAuthSession(sessionId);

				return jsonResponse({
					success: true,
					message: `Account '${name}' added successfully!`,
					mode: savedMode === "max" ? "Claude Max" : "Claude Console",
				});
			} catch (error) {
				return errorResponse(
					error instanceof Error
						? error
						: new Error("Failed to complete OAuth flow"),
				);
			}
		} catch (error) {
			log.error("OAuth callback error:", error);
			return errorResponse(
				error instanceof Error
					? error
					: new Error("Failed to process OAuth callback"),
			);
		}
	};
}
