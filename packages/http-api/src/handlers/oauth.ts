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
	return async (req: Request, url?: URL): Promise<Response> => {
		try {
			// Handle both GET (browser) and POST (API) requests
			let sessionId: string;
			let code: string;

			if (req.method === "GET") {
				// Browser redirect - extract params from URL query string
				if (!url) {
					return errorResponse(BadRequest("URL required for GET requests"));
				}

				sessionId =
					validateString(url.searchParams.get("state"), "state", {
						required: true,
						pattern: patterns.uuid,
					}) ||
					url.searchParams.get("sessionId") ||
					"";

				code =
					validateString(url.searchParams.get("code"), "code", {
						required: true,
						minLength: 1,
					}) || "";
			} else {
				// API request - extract from JSON body
				const body = await req.json();

				sessionId =
					validateString(body.sessionId, "sessionId", {
						required: true,
						pattern: patterns.uuid,
					}) || "";

				code =
					validateString(body.code, "code", {
						required: true,
						minLength: 1,
					}) || "";
			}

			if (!sessionId) {
				return errorResponse(BadRequest("Session ID is required"));
			}

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
					mode: savedMode || "claude-oauth", // Add mode to match BeginResult type
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

				const successMessage = `Account '${name}' re-authenticated successfully!`;
				const modeDescription =
					savedMode === "claude-oauth" ? "Claude CLI OAuth" : "Claude Console";

				// Return HTML for browser requests, JSON for API requests
				if (req.method === "GET") {
					const html = `
<!DOCTYPE html>
<html>
<head>
	<title>Authentication Successful</title>
	<style>
		body { font-family: system-ui, sans-serif; text-align: center; padding: 2rem; }
		.success { color: #16a34a; font-size: 1.5rem; margin: 1rem 0; }
		.info { color: #6b7280; margin: 0.5rem 0; }
		.close { margin-top: 2rem; }
	</style>
</head>
<body>
	<h1>✅ Authentication Successful</h1>
	<div class="success">${successMessage}</div>
	<div class="info">Type: ${modeDescription}</div>
	<div class="info">You can now close this window and return to the application.</div>
	<div class="close">
		<button onclick="window.close()">Close Window</button>
	</div>
	<script>
		// Auto-close after 3 seconds
		setTimeout(() => window.close(), 3000);
	</script>
</body>
</html>`;
					return new Response(html, {
						headers: { "Content-Type": "text/html" },
					});
				} else {
					return jsonResponse({
						success: true,
						message: successMessage,
						mode: modeDescription,
					});
				}
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
