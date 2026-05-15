import type { DatabaseOperations } from "@better-ccflare/database";
import { NodeCryptoUtils } from "@better-ccflare/types";
import { extractApiKey } from "./extract-api-key";

export interface AuthenticationResult {
	isAuthenticated: boolean;
	apiKeyId?: string;
	apiKeyName?: string;
	error?: string;
}

/**
 * Authentication policy: which surfaces require an API key.
 *
 * The model is intentionally narrow. API keys gate UPSTREAM AI TRAFFIC only
 * (/v1/* and /messages/*). The management surface (/api/*, /health) is
 * unauthenticated — trust boundary is "can you reach the port." Operators are
 * expected to bind better-ccflare to a loopback address or put it behind a
 * reverse proxy that enforces authentication.
 */
type AuthRequirement = "public" | "api_key";

function policyFor(path: string): AuthRequirement {
	if (path === "/health") return "public";
	if (path === "/api" || path.startsWith("/api/")) return "public";
	if (path === "/v1" || path.startsWith("/v1/")) return "api_key";
	if (path === "/messages" || path.startsWith("/messages/")) return "api_key";
	// Everything else (dashboard HTML, static assets, client-side routes) is public.
	return "public";
}

export class AuthService {
	private crypto: NodeCryptoUtils;
	private dbOps: DatabaseOperations;

	constructor(dbOps: DatabaseOperations) {
		this.dbOps = dbOps;
		this.crypto = new NodeCryptoUtils();
	}

	/**
	 * Check if API authentication is enabled (has at least one active API key)
	 */
	async isAuthenticationEnabled(): Promise<boolean> {
		return (await this.dbOps.countActiveApiKeys()) > 0;
	}

	/**
	 * Validate API key from request header
	 */
	async validateApiKey(apiKey: string): Promise<AuthenticationResult> {
		if (!apiKey) {
			return {
				isAuthenticated: false,
				error: "API key required",
			};
		}

		// If no API keys are configured, authentication is disabled
		if (!(await this.isAuthenticationEnabled())) {
			return {
				isAuthenticated: true,
				error: undefined,
			};
		}

		// Get all active API keys
		const activeApiKeys = await this.dbOps.getActiveApiKeys();

		// Check each API key
		for (const keyRecord of activeApiKeys) {
			const isValid = await this.crypto.verifyApiKey(
				apiKey,
				keyRecord.hashedKey,
			);
			if (isValid) {
				// Update usage statistics
				this.dbOps.updateApiKeyUsage(keyRecord.id, Date.now());

				return {
					isAuthenticated: true,
					apiKeyId: keyRecord.id,
					apiKeyName: keyRecord.name,
				};
			}
		}

		return {
			isAuthenticated: false,
			error: "Invalid API key",
		};
	}

	extractApiKey(req: Request): string | null {
		return extractApiKey(req);
	}

	/**
	 * Authenticate a request against the auth policy.
	 *
	 * Public paths return authenticated without checking for a key. API-key
	 * paths require a valid key when at least one is configured; when none are
	 * configured, authentication is effectively disabled.
	 */
	async authenticateRequest(
		req: Request,
		path: string,
		_method: string,
	): Promise<AuthenticationResult> {
		if (policyFor(path) === "public") {
			return { isAuthenticated: true };
		}

		// API-key-gated path. If no keys are configured at all, let everything
		// through (matches single-user / first-run behavior).
		if (!(await this.isAuthenticationEnabled())) {
			return { isAuthenticated: true };
		}

		const apiKey = this.extractApiKey(req);
		if (!apiKey) {
			return {
				isAuthenticated: false,
				error:
					"API key required. Include it in the 'x-api-key' header or Authorization: Bearer <key>",
			};
		}

		return await this.validateApiKey(apiKey);
	}
}
