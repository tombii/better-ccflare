import type { DatabaseOperations } from "@better-ccflare/database";
import {
	type ApiKey,
	type ApiKeyRole,
	NodeCryptoUtils,
} from "@better-ccflare/types";

export interface AuthenticationResult {
	isAuthenticated: boolean;
	apiKey?: ApiKey;
	apiKeyId?: string;
	apiKeyName?: string;
	role?: ApiKeyRole;
	error?: string;
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
	isAuthenticationEnabled(): boolean {
		return this.dbOps.countActiveApiKeys() > 0;
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
		if (!this.isAuthenticationEnabled()) {
			return {
				isAuthenticated: true,
				error: undefined,
			};
		}

		// Get all active API keys
		const activeApiKeys = this.dbOps.getActiveApiKeys();

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
					apiKey: keyRecord,
					apiKeyId: keyRecord.id,
					apiKeyName: keyRecord.name,
					role: keyRecord.role,
				};
			}
		}

		return {
			isAuthenticated: false,
			error: "Invalid API key",
		};
	}

	/**
	 * Authorize endpoint access based on API key role
	 */
	async authorizeEndpoint(
		apiKey: ApiKey,
		path: string,
		_method: string,
	): Promise<{ authorized: boolean; reason?: string }> {
		// Admin keys have full access
		if (apiKey.role === "admin") {
			return { authorized: true };
		}

		// API-only keys: Only allow /v1/* and /messages/* (proxy endpoints)
		const isProxyEndpoint =
			path.startsWith("/v1/") || path.startsWith("/messages/");

		if (!isProxyEndpoint) {
			return {
				authorized: false,
				reason: "Unauthorized: This API key does not have dashboard access",
			};
		}

		return { authorized: true };
	}

	/**
	 * Extract API key from request headers
	 */
	extractApiKey(req: Request): string | null {
		// Check x-api-key header first (Anthropic format)
		const apiKey = req.headers.get("x-api-key");
		if (apiKey) {
			return apiKey;
		}

		// Check Authorization header with Bearer token
		const authHeader = req.headers.get("authorization");
		if (authHeader) {
			const parts = authHeader.trim().split(/\s+/);
			if (parts.length === 2 && parts[0].toLowerCase() === "bearer") {
				return parts[1];
			}
		}

		return null;
	}

	/**
	 * Check if a path should be exempt from authentication
	 */
	isPathExempt(path: string, method: string): boolean {
		// Health endpoint is always exempt
		if (path === "/health") {
			return true;
		}

		// OAuth endpoints are exempt (needed for account setup)
		if (path.startsWith("/api/oauth")) {
			return true;
		}

		// API key management: Only allow initial key creation without auth if no keys exist
		// All other operations require authentication
		if (path.startsWith("/api/api-keys")) {
			// Only allow POST (key creation) without auth if no keys exist
			if (path === "/api/api-keys" && method === "POST") {
				return !this.isAuthenticationEnabled(); // Only exempt if no keys exist
			}
			// All other API key operations require authentication
			return false;
		}

		// Proxy endpoints (/v1/*, /messages/*, etc.) require authentication if enabled
		if (path.startsWith("/v1") || path.startsWith("/messages")) {
			return false;
		}

		// API endpoints require authentication if enabled
		if (path.startsWith("/api")) {
			return false;
		}

		// All other paths are dashboard routes (client-side routing) or static assets
		// These should be exempt to allow serving the dashboard HTML and assets
		// This matches the server logic that serves index.html for non-API routes
		return true;
	}

	/**
	 * Authenticate a request
	 */
	async authenticateRequest(
		req: Request,
		path: string,
		method: string,
	): Promise<AuthenticationResult> {
		// If path is exempt, allow without authentication
		if (this.isPathExempt(path, method)) {
			return {
				isAuthenticated: true,
			};
		}

		// If authentication is not enabled (no API keys), allow
		if (!this.isAuthenticationEnabled()) {
			return {
				isAuthenticated: true,
			};
		}

		// Extract API key from request
		const apiKey = this.extractApiKey(req);
		if (!apiKey) {
			return {
				isAuthenticated: false,
				error:
					"API key required. Include it in the 'x-api-key' header or Authorization: Bearer <key>",
			};
		}

		// Validate the API key
		return await this.validateApiKey(apiKey);
	}
}
