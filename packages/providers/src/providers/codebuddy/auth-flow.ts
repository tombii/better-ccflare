import { Logger } from "@better-ccflare/logger";
import type { Account } from "@better-ccflare/types";
import type { TokenRefreshResult } from "../../types";

const log = new Logger("CodeBuddyAuthFlow");

export const CODEBUDDY_DEFAULT_ENDPOINT = "https://www.codebuddy.ai";
export const CODEBUDDY_CLI_VERSION = "2.169.0";

const CODEBUDDY_ENDPOINT_ENV = "CCFLARE_CODEBUDDY_ENDPOINT";
const DEFAULT_POLL_TIMEOUT_MS = 300_000;
const DEFAULT_POLL_INTERVAL_MS = 1_000;
const PENDING_CODE = 11217;

export interface CodeBuddyAuthSession {
	state: string;
	authUrl: string;
	endpoint: string;
}

export interface CodeBuddyTokens {
	accessToken: string;
	refreshToken: string;
	expiresIn: number;
	domain?: string;
	tokenType?: string;
	scope?: string;
}

interface CodeBuddyEnvelope<T> {
	code?: number;
	data?: T;
	msg?: string;
}

interface CodeBuddyTokenData {
	accessToken?: unknown;
	refreshToken?: unknown;
	expiresIn?: unknown;
	expiresAt?: unknown;
	domain?: unknown;
	tokenType?: unknown;
	scope?: unknown;
}

interface CodeBuddyIdentity {
	uid?: string;
	enterpriseId?: string;
	domain?: string;
	nickname?: string;
}

/**
 * Resolve the CodeBuddy API endpoint.
 *
 * Precedence: explicit endpoint / account.custom_endpoint, then
 * CCFLARE_CODEBUDDY_ENDPOINT, then the public default. Trailing slashes are
 * stripped so callers can concatenate paths safely.
 */
export function resolveCodeBuddyEndpoint(endpoint?: string | null): string {
	const candidate =
		endpoint?.trim() ||
		process.env[CODEBUDDY_ENDPOINT_ENV]?.trim() ||
		CODEBUDDY_DEFAULT_ENDPOINT;
	// Trim trailing slashes without a regex: `/\/+$/` is polynomial on input
	// with many slashes (CodeQL js/polynomial-redos).
	let end = candidate.length;
	while (end > 0 && candidate.charCodeAt(end - 1) === 47) end -= 1;
	return candidate.slice(0, end);
}

function endpointHost(endpoint: string): string {
	try {
		return new URL(endpoint).hostname;
	} catch {
		return endpoint.replace(/^https?:\/\//i, "").split("/")[0];
	}
}

function userAgent(): string {
	return `CLI/${CODEBUDDY_CLI_VERSION} CodeBuddy/${CODEBUDDY_CLI_VERSION}`;
}

/**
 * Headers used for unauthenticated CodeBuddy plugin endpoints. The X-No-*
 * flags tell the gateway not to look for credentials it will not find.
 */
export function buildCodeBuddyAuthHeaders(endpoint: string): Headers {
	return new Headers({
		"X-No-Authorization": "true",
		"X-No-User-Id": "true",
		"X-No-Enterprise-Id": "true",
		"X-No-Department-Info": "true",
		"X-Domain": endpointHost(endpoint),
		"Content-Type": "application/json",
		Accept: "application/json, text/plain, */*",
		"User-Agent": userAgent(),
	});
}

async function readEnvelope<T>(
	response: Response,
): Promise<CodeBuddyEnvelope<T>> {
	try {
		const parsed = (await response.json()) as unknown;
		if (parsed && typeof parsed === "object") {
			return parsed as CodeBuddyEnvelope<T>;
		}
	} catch {
		// Fall through to an empty envelope; callers surface a generic error.
	}
	return {};
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Start the CodeBuddy external-link auth flow.
 *
 * CodeBuddy does not use standard OAuth: the CLI asks for a state, shows the
 * returned authUrl to the user, then polls for the token.
 */
export async function beginCodeBuddyAuth(
	endpoint?: string,
): Promise<CodeBuddyAuthSession> {
	const resolved = resolveCodeBuddyEndpoint(endpoint);
	const response = await fetch(
		`${resolved}/v2/plugin/auth/state?platform=CLI`,
		{
			method: "POST",
			headers: buildCodeBuddyAuthHeaders(resolved),
			body: "{}",
		},
	);

	const payload = await readEnvelope<{ state?: unknown; authUrl?: unknown }>(
		response,
	);
	if (!response.ok || payload.code !== 0) {
		const message =
			payload.msg ?? (response.statusText || `HTTP ${response.status}`);
		throw new Error(`CodeBuddy authorization failed: ${message}`);
	}

	const state = payload.data?.state;
	const authUrl = payload.data?.authUrl;
	if (
		typeof state !== "string" ||
		state.length === 0 ||
		typeof authUrl !== "string" ||
		authUrl.length === 0
	) {
		throw new Error(
			"CodeBuddy authorization response was missing state or authUrl",
		);
	}

	return { state, authUrl, endpoint: resolved };
}

/**
 * Poll the token endpoint until the user completes authorization.
 *
 * Envelope code 11217 means "still pending". Any other non-zero code is
 * terminal; code 0 with an access token completes the flow.
 */
export async function pollCodeBuddyAuth(
	session: CodeBuddyAuthSession,
	opts?: {
		timeoutMs?: number;
		intervalMs?: number;
		onTick?: (attempt: number) => void;
	},
): Promise<CodeBuddyTokens> {
	const timeoutMs = opts?.timeoutMs ?? DEFAULT_POLL_TIMEOUT_MS;
	const intervalMs = opts?.intervalMs ?? DEFAULT_POLL_INTERVAL_MS;
	const deadline = Date.now() + timeoutMs;
	let attempt = 0;

	while (Date.now() < deadline) {
		attempt += 1;
		opts?.onTick?.(attempt);

		// Bound the request *and* its body read by the remaining time. A stalled
		// token endpoint must not keep the poll (and the server-side session)
		// alive past the caller's deadline.
		const remaining = deadline - Date.now();
		if (remaining <= 0) break;
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), remaining);

		let payload: CodeBuddyEnvelope<CodeBuddyTokenData>;
		let responseStatus = 0;
		let responseStatusText = "";
		try {
			const response = await fetch(
				`${session.endpoint}/v2/plugin/auth/token?state=${encodeURIComponent(session.state)}`,
				{
					method: "GET",
					headers: buildCodeBuddyAuthHeaders(session.endpoint),
					signal: controller.signal,
				},
			);
			responseStatus = response.status;
			responseStatusText = response.statusText;
			payload = await readEnvelope<CodeBuddyTokenData>(response);
		} catch (error) {
			if (controller.signal.aborted) break;
			throw error;
		} finally {
			clearTimeout(timer);
		}

		if (payload.code === PENDING_CODE) {
			const next = deadline - Date.now();
			if (next <= 0) break;
			await sleep(Math.min(intervalMs, next));
			continue;
		}

		if (payload.code === 0) {
			const data = payload.data;
			if (
				!data ||
				typeof data.accessToken !== "string" ||
				data.accessToken.length === 0
			) {
				throw new Error(
					`CodeBuddy authorization failed: ${payload.msg ?? "missing access token"}`,
				);
			}

			const tokens: CodeBuddyTokens = {
				accessToken: data.accessToken,
				refreshToken:
					typeof data.refreshToken === "string" ? data.refreshToken : "",
				expiresIn: typeof data.expiresIn === "number" ? data.expiresIn : 1800,
			};
			if (typeof data.domain === "string") tokens.domain = data.domain;
			if (typeof data.tokenType === "string") tokens.tokenType = data.tokenType;
			if (typeof data.scope === "string") tokens.scope = data.scope;
			return tokens;
		}

		const message =
			payload.msg ??
			(responseStatusText || `unexpected code ${payload.code ?? responseStatus}`);
		throw new Error(`CodeBuddy authorization failed: ${message}`);
	}

	throw new Error(
		"Timed out waiting for CodeBuddy authorization. Please try again.",
	);
}

/**
 * Fetch the signed-in account's profile. Returns null for pending responses,
 * non-zero envelope codes, and transport failures — callers treat the profile
 * as best-effort metadata.
 */
export async function fetchCodeBuddyAccount(
	tokens: Pick<CodeBuddyTokens, "accessToken" | "domain">,
	endpoint: string,
): Promise<Record<string, unknown> | null> {
	const resolved = resolveCodeBuddyEndpoint(endpoint);
	const headers = buildCodeBuddyAuthHeaders(resolved);
	headers.delete("X-No-Authorization");
	headers.delete("X-No-User-Id");
	headers.delete("X-No-Enterprise-Id");
	headers.delete("X-No-Department-Info");
	headers.set("Authorization", `Bearer ${tokens.accessToken}`);
	headers.set("X-Domain", tokens.domain || endpointHost(resolved));

	try {
		const response = await fetch(`${resolved}/v2/plugin/account`, {
			method: "GET",
			headers,
		});
		const payload = await readEnvelope<Record<string, unknown>>(response);
		if (
			payload.code !== 0 ||
			!payload.data ||
			typeof payload.data !== "object"
		) {
			return null;
		}
		return payload.data;
	} catch (error) {
		log.debug(
			`Failed to fetch CodeBuddy account: ${error instanceof Error ? error.message : String(error)}`,
		);
		return null;
	}
}

/**
 * Decode the unverified JWT payload of a CodeBuddy access token. The signature
 * is deliberately not checked: these values are only echoed back to the issuer
 * as request headers.
 */
export function decodeCodeBuddyIdentity(
	accessToken: string,
): CodeBuddyIdentity {
	try {
		const parts = accessToken.split(".");
		if (parts.length < 2 || parts[1] === "") return {};

		const decoded = Buffer.from(parts[1], "base64url").toString("utf8");
		const parsed = JSON.parse(decoded) as unknown;
		if (!parsed || typeof parsed !== "object") return {};

		const payload = parsed as Record<string, unknown>;
		const identity: CodeBuddyIdentity = {};

		if (typeof payload.sub === "string" && payload.sub.length > 0) {
			identity.uid = payload.sub;
		}

		const nickname =
			typeof payload.nickname === "string"
				? payload.nickname
				: typeof payload.preferred_username === "string"
					? payload.preferred_username
					: undefined;
		if (nickname) identity.nickname = nickname;

		let enterpriseId =
			typeof payload.enterprise_id === "string"
				? payload.enterprise_id
				: typeof payload.enterpriseId === "string"
					? payload.enterpriseId
					: undefined;

		const issuer = typeof payload.iss === "string" ? payload.iss : undefined;
		if (!enterpriseId && issuer) {
			const segments = issuer.split("/").filter(Boolean);
			const last = segments[segments.length - 1];
			if (last?.startsWith("sso-")) {
				enterpriseId = last.slice(4);
			}
		}
		if (enterpriseId) identity.enterpriseId = enterpriseId;

		if (issuer) {
			try {
				identity.domain = new URL(issuer).hostname;
			} catch {
				// Issuer is not a URL; leave domain unset.
			}
		}

		return identity;
	} catch {
		return {};
	}
}

/**
 * Refresh a CodeBuddy access token.
 *
 * A 401/403 from the refresh endpoint means the refresh token is no longer
 * valid. The message includes `invalid_grant` so the token manager marks the
 * account as requiring reauthentication.
 */
export async function refreshCodeBuddyToken(
	account: Account,
): Promise<TokenRefreshResult> {
	if (!account.refresh_token) {
		throw new Error(
			`No CodeBuddy refresh token available for account ${account.name}`,
		);
	}

	const endpoint = resolveCodeBuddyEndpoint(account.custom_endpoint);
	const identity = decodeCodeBuddyIdentity(account.access_token ?? "");
	const headers = buildCodeBuddyAuthHeaders(endpoint);
	headers.delete("X-No-Authorization");
	headers.delete("X-No-User-Id");
	headers.delete("X-No-Enterprise-Id");
	headers.delete("X-No-Department-Info");
	headers.set("X-Refresh-Token", account.refresh_token);
	headers.set("X-Auth-Refresh-Source", "plugin");
	headers.set("X-Domain", identity.domain || endpointHost(endpoint));

	const response = await fetch(`${endpoint}/v2/plugin/auth/token/refresh`, {
		method: "POST",
		headers,
		body: "{}",
	});
	const payload = await readEnvelope<CodeBuddyTokenData>(response);
	const upstreamMessage = payload.msg ? `: ${payload.msg}` : "";

	if (response.status === 401 || response.status === 403) {
		throw new Error(
			`CodeBuddy token refresh failed: invalid_grant${upstreamMessage}`,
		);
	}

	if (!response.ok || payload.code !== 0) {
		const message =
			payload.msg ?? (response.statusText || `HTTP ${response.status}`);
		throw new Error(`CodeBuddy token refresh failed: ${message}`);
	}

	const data = payload.data;
	if (
		!data ||
		typeof data.accessToken !== "string" ||
		data.accessToken.length === 0
	) {
		throw new Error("CodeBuddy token refresh failed: missing access token");
	}

	const expiresIn = typeof data.expiresIn === "number" ? data.expiresIn : 1800;
	const now = Date.now();
	const expiresAt =
		typeof data.expiresAt === "number" && data.expiresAt > now
			? data.expiresAt
			: now + expiresIn * 1000;

	return {
		accessToken: data.accessToken,
		refreshToken:
			typeof data.refreshToken === "string"
				? data.refreshToken
				: account.refresh_token,
		expiresAt,
	};
}
