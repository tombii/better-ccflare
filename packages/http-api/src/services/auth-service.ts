import type { DatabaseOperations } from "@better-ccflare/database";
import { type ApiKey, NodeCryptoUtils } from "@better-ccflare/types";

export interface AuthenticationResult {
	isAuthenticated: boolean;
	apiKey?: ApiKey;
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
				};
			}
		}

		return {
			isAuthenticated: false,
			error: "Invalid API key",
		};
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
		// Web dashboard paths are always exempt
		if (path.startsWith("/dashboard") || path === "/") {
			return true;
		}

		// Static assets are exempt
		if (path.startsWith("/static") || path.startsWith("/assets")) {
			return true;
		}

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

		// Default to requiring authentication for non-exempt paths
		return false;
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
