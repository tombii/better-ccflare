import { randomBytes, timingSafeEqual } from "node:crypto";
import type { DatabaseOperations } from "@better-ccflare/database";
import {
	type ApiKey,
	type ApiKeyRole,
	NodeCryptoUtils,
} from "@better-ccflare/types";
import { extractApiKey } from "./extract-api-key";

/**
 * Constant-time string comparison for secrets (internal-probe secret,
 * local-control secret) that mirrors the approach NodeCryptoUtils#verifyApiKey
 * uses for API key hashes: a plain `!==`/`===` on a secret leaks its length
 * and per-character match progress via timing, which `crypto.timingSafeEqual`
 * avoids. `timingSafeEqual` requires equal-length buffers, so a length
 * mismatch is treated as not-equal directly — the secrets here are
 * fixed-format (UUIDs / hex tokens), so length itself isn't the sensitive
 * bit; only the character-by-character comparison over the expected format
 * needs to be constant-time.
 */
function timingSafeStringEqual(a: string, b: string): boolean {
	const bufA = Buffer.from(a, "utf8");
	const bufB = Buffer.from(b, "utf8");
	if (bufA.length !== bufB.length) {
		return false;
	}
	return timingSafeEqual(bufA, bufB);
}

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

/** How long a minted logs-stream token remains valid if never consumed. Short
 * because the token is only ever used immediately after being minted (the
 * dashboard fetches it and opens the EventSource in the same tick). */
const STREAM_TOKEN_TTL_MS = 60_000;

interface StreamTokenRecord {
	expiresAt: number;
	apiKeyId?: string;
	role?: ApiKeyRole;
}

export class AuthService {
	private crypto: NodeCryptoUtils;
	private dbOps: DatabaseOperations;
	private internalProbeSecret?: string;
	private localControlSecret?: string;
	/** In-memory, single-use tokens minted by mintLogsStreamToken() and
	 * consumed by validateAndConsumeLogsStreamToken(). No DB persistence —
	 * these are ephemeral (60s TTL) and only ever needed within the same
	 * server process that minted them. */
	private streamTokens = new Map<string, StreamTokenRecord>();

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
		const provided = headers.get(INTERNAL_PROBE_SECRET_HEADER);
		if (!provided || !timingSafeStringEqual(provided, this.internalProbeSecret))
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
		const provided = headers.get(LOCAL_CONTROL_SECRET_HEADER);
		if (!provided) return false;
		return timingSafeStringEqual(provided, this.localControlSecret);
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
	 * Mint a short-lived, single-use token for the one endpoint where a
	 * header genuinely cannot be sent: the dashboard's live log tail uses the
	 * browser's native EventSource, which has no header-injection API (#216).
	 * Requires the caller to already be authenticated via the normal
	 * header/Bearer path (enforced by the "/api/logs/stream/token" route
	 * requiring auth like any other /api/* endpoint) — this method itself
	 * does not authenticate, it just records who the token is for.
	 *
	 * Deliberately NOT the durable API key: putting the long-lived key in a
	 * URL risks leaking it via browser history, Referer headers, or
	 * reverse-proxy/access logs. The minted token is random, expires quickly,
	 * and is consumed on first use, so even if it leaks via those channels
	 * the exposure window and blast radius are both minimal.
	 */
	mintLogsStreamToken(apiKeyId?: string, role?: ApiKeyRole): string {
		// Opportunistically sweep expired tokens so the map doesn't grow
		// unbounded across a long-lived server process.
		this.pruneExpiredStreamTokens();

		const token = randomBytes(32).toString("hex");
		this.streamTokens.set(token, {
			expiresAt: Date.now() + STREAM_TOKEN_TTL_MS,
			apiKeyId,
			role,
		});
		return token;
	}

	/**
	 * Validate and consume (single-use) a logs-stream token minted by
	 * mintLogsStreamToken(). Returns the associated role/apiKeyId on success,
	 * or null if the token is missing, unknown, expired, or already used.
	 */
	private validateAndConsumeLogsStreamToken(
		token: string,
	): StreamTokenRecord | null {
		const record = this.streamTokens.get(token);
		// Single-use: delete on first lookup regardless of outcome, so a
		// leaked/replayed token can't be tried again.
		this.streamTokens.delete(token);
		if (!record) return null;
		if (Date.now() > record.expiresAt) return null;
		return record;
	}

	private pruneExpiredStreamTokens(): void {
		const now = Date.now();
		for (const [token, record] of this.streamTokens) {
			if (now > record.expiresAt) {
				this.streamTokens.delete(token);
			}
		}
	}

	/**
	 * Extract a logs-stream token from the query string. Scoped the same way
	 * the raw-api-key query fallback used to be: only consulted for
	 * GET /api/logs/stream.
	 */
	private extractStreamTokenFromQuery(req: Request): string | null {
		try {
			const url = new URL(req.url);
			return url.searchParams.get("stream_token");
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

		// The logs SSE stream is special-cased: the browser's native
		// EventSource cannot set custom headers, so instead of accepting the
		// durable API key via query string (which risks leaking it via
		// browser history / Referer / access logs), it accepts a short-lived,
		// single-use token minted by a separate, normally-authenticated
		// endpoint (POST /api/logs/stream/token). Every other endpoint still
		// requires the key via header/Bearer form, unchanged.
		if (path === "/api/logs/stream" && method === "GET") {
			const token = this.extractStreamTokenFromQuery(req);
			if (token) {
				const record = this.validateAndConsumeLogsStreamToken(token);
				if (record) {
					return {
						isAuthenticated: true,
						apiKeyId: record.apiKeyId,
						role: record.role,
					};
				}
			}
			// Fall through to the normal header/Bearer check below in case a
			// client sends the real key via header instead of a token.
		}

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
