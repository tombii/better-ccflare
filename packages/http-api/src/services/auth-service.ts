import type { DatabaseOperations } from "@better-ccflare/database";
import {
	type ApiKey,
	type ApiKeyRole,
	NodeCryptoUtils,
} from "@better-ccflare/types";
import { extractApiKey } from "./extract-api-key";

export interface AuthenticationResult {
	isAuthenticated: boolean;
	apiKey?: ApiKey;
	apiKeyId?: string;
	apiKeyName?: string;
	role?: ApiKeyRole;
	error?: string;
}

/** Header carrying the process-local secret that gates internal-probe markers.
 * Mirrors packages/proxy/src/handlers/proxy-types.ts INTERNAL_PROBE_SECRET_HEADER —
 * duplicated here (rather than imported) to avoid a http-api -> proxy package
 * dependency; the string value MUST stay in sync with that file. */
const INTERNAL_PROBE_SECRET_HEADER = "x-better-ccflare-internal-probe-secret";

/** Header carrying the persisted local-control secret used by the better-ccflare
 * CLI to notify its own locally-running server of DB-side changes (token
 * reload, force-reset-rate-limit) when API-key auth is enabled. Unlike the
 * internal-probe secret (minted fresh per server process), this secret is
 * persisted in the config file so the separate, short-lived CLI process can
 * read it too. See packages/config Config#getLocalControlSecret. */
const LOCAL_CONTROL_SECRET_HEADER = "x-better-ccflare-local-control-secret";

/** Paths where a valid local-control-secret is honored. Intentionally a small,
 * explicit allowlist — these are idempotent, non-sensitive internal signals
 * (clear an in-process cache / re-poll usage) triggered by the user's own CLI
 * against their own locally-running server, not a general auth bypass. */
function isLocalControlNotifyPath(path: string): boolean {
	return (
		path.startsWith("/api/accounts/") &&
		(path.endsWith("/reload") || path.endsWith("/force-reset-rate-limit"))
	);
}

export class AuthService {
	private crypto: NodeCryptoUtils;
	private dbOps: DatabaseOperations;
	private internalProbeSecret?: string;
	private localControlSecret?: string;

	constructor(
		dbOps: DatabaseOperations,
		internalProbeSecret?: string,
		localControlSecret?: string,
	) {
		this.dbOps = dbOps;
		this.crypto = new NodeCryptoUtils();
		this.internalProbeSecret = internalProbeSecret;
		this.localControlSecret = localControlSecret;
	}

	/**
	 * Mirrors isInternalProbe() in packages/proxy/src/handlers/proxy-types.ts:
	 * a request is a legitimate internal probe (auto-refresh or
	 * cache-keepalive self-loop) only if the process-local secret matches AND
	 * one of the marker headers is present. Fails closed (false) if the
	 * secret is missing/unset or doesn't match.
	 */
	private isInternalProbeRequest(headers: Headers): boolean {
		if (!this.internalProbeSecret) return false;
		if (headers.get(INTERNAL_PROBE_SECRET_HEADER) !== this.internalProbeSecret)
			return false;
		const hasAutoRefresh =
			headers.get("x-better-ccflare-auto-refresh") === "true";
		const hasKeepalive = headers.get("x-better-ccflare-keepalive") === "true";
		return hasAutoRefresh || hasKeepalive;
	}

	/**
	 * True when the request carries a valid local-control-secret AND targets
	 * one of the small allowlisted CLI-notify paths. Fails closed if the
	 * secret is missing/unset or doesn't match.
	 */
	private isLocalControlRequest(headers: Headers, path: string): boolean {
		if (!this.localControlSecret) return false;
		if (!isLocalControlNotifyPath(path)) return false;
		return headers.get(LOCAL_CONTROL_SECRET_HEADER) === this.localControlSecret;
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

		// Derive the last-8 suffix of the incoming key for a cheap pre-filter.
		// This matches how `prefixLast8` is stored: apiKey.slice(-8).
		const incomingLast8 = apiKey.slice(-8);

		// Check each API key
		for (const keyRecord of activeApiKeys) {
			// Short-circuit: skip expensive scrypt if the last-8 suffix doesn't match
			if (keyRecord.prefixLast8 && keyRecord.prefixLast8 !== incomingLast8) {
				continue;
			}
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

		// Debug endpoints are admin-only (heap snapshots contain secrets)
		if (path.startsWith("/api/debug/")) {
			return {
				authorized: false,
				reason: "Unauthorized: Debug endpoints require an admin API key",
			};
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

	extractApiKey(req: Request): string | null {
		return extractApiKey(req);
	}

	/**
	 * Extract an API key from the query string, for the one endpoint where a
	 * header genuinely cannot be sent: the dashboard's live log tail uses the
	 * browser's native EventSource, which has no header-injection API (#216).
	 * Deliberately NOT wired into extractApiKey()/the general auth path —
	 * every other endpoint still requires the key via header, unchanged. The
	 * key is still validated through the normal validateApiKey() scrypt
	 * check; this only changes *where* the key may be read from, not what
	 * counts as valid.
	 */
	private extractApiKeyFromQuery(req: Request): string | null {
		try {
			const url = new URL(req.url);
			return url.searchParams.get("api_key");
		} catch {
			return null;
		}
	}

	/**
	 * Check if a path is statically exempt from authentication
	 * (does not require async DB check)
	 */
	isStaticPathExempt(path: string): boolean {
		// Health endpoint is always exempt
		if (path === "/health") {
			return true;
		}

		// OAuth endpoints are exempt (needed for account setup)
		if (path.startsWith("/api/oauth")) {
			return true;
		}

		// Version check returns only the latest npm-published version. The
		// dashboard's sidebar tile fires this on load with no API key in
		// headers, so it must be reachable whether or not auth is enabled.
		if (path === "/api/version/check") {
			return true;
		}

		// All other paths are dashboard routes (client-side routing) or static assets
		// These should be exempt to allow serving the dashboard HTML and assets
		// This matches the server logic that serves index.html for non-API routes
		if (
			!path.startsWith("/api") &&
			!path.startsWith("/v1") &&
			!path.startsWith("/messages")
		) {
			return true;
		}

		return false;
	}

	/**
	 * Check if a path should be exempt from authentication.
	 *
	 * `headers`, when provided, allows two narrow internal exemptions
	 * (issue #216 stage 1) on top of the static/API-key rules below:
	 *  - a correctly-marked internal probe (auto-refresh / cache-keepalive
	 *    self-loop) hitting a proxy endpoint (/v1/*, /messages/*)
	 *  - a correctly-marked local-control request (the user's own CLI
	 *    notifying their own locally-running server) hitting one of the
	 *    small allowlisted account-notify endpoints
	 * Both fail closed: omitting `headers`, or presenting a wrong/missing
	 * secret, falls through to the normal auth-required behavior.
	 */
	async isPathExempt(
		path: string,
		method: string,
		headers?: Headers,
	): Promise<boolean> {
		// Static exemptions first (no DB hit)
		if (this.isStaticPathExempt(path)) {
			return true;
		}

		// API key management: Only allow initial key creation without auth if no keys exist
		// All other operations require authentication
		if (path.startsWith("/api/api-keys")) {
			// Only allow POST (key creation) without auth if no keys exist
			if (path === "/api/api-keys" && method === "POST") {
				return !(await this.isAuthenticationEnabled()); // Only exempt if no keys exist
			}
			// All other API key operations require authentication
			return false;
		}

		// Proxy endpoints (/v1/*, /messages/*, etc.) require authentication if
		// enabled, except for correctly-marked internal probes (#216).
		if (path.startsWith("/v1") || path.startsWith("/messages")) {
			if (headers && this.isInternalProbeRequest(headers)) {
				return true;
			}
			return false;
		}

		// API endpoints require authentication if enabled, except for
		// correctly-marked local-control CLI-notify requests (#216).
		if (path.startsWith("/api")) {
			if (headers && this.isLocalControlRequest(headers, path)) {
				return true;
			}
			return false;
		}

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
		if (await this.isPathExempt(path, method, req.headers)) {
			return {
				isAuthenticated: true,
			};
		}

		// If authentication is not enabled (no API keys), allow
		if (!(await this.isAuthenticationEnabled())) {
			return {
				isAuthenticated: true,
			};
		}

		// Extract API key from request. The logs SSE stream additionally
		// accepts the key via query string (?api_key=) because the browser's
		// native EventSource cannot set custom headers (#216) — every other
		// endpoint still requires the header/Bearer form.
		const apiKey =
			this.extractApiKey(req) ||
			(path === "/api/logs/stream" && method === "GET"
				? this.extractApiKeyFromQuery(req)
				: null);
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
