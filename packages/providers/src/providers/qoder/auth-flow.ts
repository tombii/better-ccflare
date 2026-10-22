import { Logger } from "@better-ccflare/logger";
import type { Account } from "@better-ccflare/types";
import type { TokenRefreshResult } from "../../types";

const log = new Logger("QoderAuthFlow");

/**
 * Qoder's account surface. The CN region uses `openapi.qoder.com.cn` instead;
 * an account's custom endpoint selects it (see resolveQoderOpenApiEndpoint).
 */
export const QODER_DEFAULT_OPENAPI_ENDPOINT = "https://openapi.qoder.sh";
export const QODER_OPENAPI_ENDPOINT_ENV = "CCFLARE_QODER_OPENAPI_ENDPOINT";

/** Job tokens are documented as ~1 day; used when `expires_at` is absent. */
const DEFAULT_JOB_TOKEN_TTL_MS = 12 * 60 * 60 * 1000;

export interface QoderUserInfo {
	uid: string;
	email: string;
	name: string;
}

/** Same-resolve as CodeBuddy: explicit, then env, then the public default. */
export function resolveQoderOpenApiEndpoint(endpoint?: string | null): string {
	const candidate =
		endpoint?.trim() ||
		process.env[QODER_OPENAPI_ENDPOINT_ENV]?.trim() ||
		QODER_DEFAULT_OPENAPI_ENDPOINT;
	let end = candidate.length;
	while (end > 0 && candidate.charCodeAt(end - 1) === 47) end -= 1;
	return candidate.slice(0, end);
}

/** Never let a credential reach a log line or an error message. */
function redact(value: string): string {
	return value
		.replace(/pt-[A-Za-z0-9._~+/=-]+/g, "[redacted]")
		.replace(/jt-[A-Za-z0-9._~+/=-]+/g, "[redacted]")
		.replace(/jrt-[A-Za-z0-9._~+/=-]+/g, "[redacted]");
}

async function readText(response: Response): Promise<string> {
	try {
		return (await response.text()).slice(0, 400);
	} catch {
		return "";
	}
}

/**
 * A dead PAT is the only failure that should retire the account. Qoder answers
 * it with 401 (and, in some builds, 400 with an auth message), while a 5xx or
 * a network error is transient. Only the former carries `invalid_grant` — that
 * substring is what the token manager's re-auth detection keys off.
 */
function isDeadCredential(status: number, body: string): boolean {
	if (status === 401 || status === 403) return true;
	if (status !== 400) return false;
	return /invalid|expired|unauthori[sz]ed|personal_token/i.test(body);
}

export interface QoderJobToken {
	accessToken: string;
	/** Qoder's job refresh token (`jrt-`), when it issues one. */
	jobRefreshToken: string | null;
	expiresAt: number;
}

function expiresAtFrom(value: unknown): number {
	if (typeof value === "string") {
		const parsed = Date.parse(value);
		if (Number.isFinite(parsed)) return parsed;
	}
	if (typeof value === "number" && Number.isFinite(value)) {
		// Tolerate seconds as well as milliseconds.
		return value < 1e12 ? value * 1000 : value;
	}
	return Date.now() + DEFAULT_JOB_TOKEN_TTL_MS;
}

async function postJobToken(
	url: string,
	body: Record<string, unknown>,
	what: string,
): Promise<QoderJobToken> {
	const response = await fetch(url, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Accept: "application/json",
			"User-Agent": "better-ccflare",
			"Cosy-Version": "1.0.1",
			"Cosy-ClientType": "5",
		},
		body: JSON.stringify(body),
	});

	if (!response.ok) {
		const text = redact(await readText(response));
		if (isDeadCredential(response.status, text)) {
			throw new Error(`Qoder ${what} failed: invalid_grant ${text}`);
		}
		throw new Error(
			`Qoder ${what} failed: HTTP ${response.status} ${text}`.trim(),
		);
	}

	const payload = (await response.json().catch(() => null)) as {
		token?: unknown;
		refresh_token?: unknown;
		expires_at?: unknown;
	} | null;
	if (!payload || typeof payload.token !== "string" || !payload.token) {
		throw new Error(`Qoder ${what} failed: response carried no job token`);
	}

	return {
		accessToken: payload.token,
		jobRefreshToken:
			typeof payload.refresh_token === "string" && payload.refresh_token
				? payload.refresh_token
				: null,
		expiresAt: expiresAtFrom(payload.expires_at),
	};
}

/**
 * Exchange a Personal Access Token for a short-lived job token. This is the
 * root of every Qoder credential: the job token is the bearer for the gateway.
 */
export async function exchangeQoderPat(
	pat: string,
	endpoint?: string | null,
): Promise<QoderJobToken> {
	return postJobToken(
		`${resolveQoderOpenApiEndpoint(endpoint)}/api/v1/jobToken/exchange`,
		{ personal_token: pat },
		"PAT exchange",
	);
}

/**
 * Rotate a job token with its job refresh token. Best effort: returns null on
 * any failure so the caller can fall back to a PAT exchange.
 */
export async function refreshQoderJobToken(
	jobRefreshToken: string,
	endpoint?: string | null,
): Promise<QoderJobToken | null> {
	try {
		return await postJobToken(
			`${resolveQoderOpenApiEndpoint(endpoint)}/api/v1/jobToken/refresh`,
			{ refresh_token: jobRefreshToken },
			"job token refresh",
		);
	} catch (error) {
		log.debug(
			`Qoder job token refresh failed, falling back to PAT exchange: ${error instanceof Error ? error.message : String(error)}`,
		);
		return null;
	}
}

/**
 * Fetch the signed-in account's identity. `id` is the `uid` the COSY envelope
 * requires — without it, no chat request can be signed.
 */
export async function fetchQoderUserInfo(
	jobToken: string,
	endpoint?: string | null,
): Promise<QoderUserInfo | null> {
	try {
		const response = await fetch(
			`${resolveQoderOpenApiEndpoint(endpoint)}/api/v1/userinfo`,
			{
				headers: {
					Authorization: `Bearer ${jobToken}`,
					Accept: "application/json",
					"User-Agent": "better-ccflare",
				},
			},
		);
		if (!response.ok) return null;
		const payload = (await response.json()) as {
			id?: unknown;
			email?: unknown;
			name?: unknown;
			username?: unknown;
		};
		if (typeof payload.id !== "string" || !payload.id) return null;
		return {
			uid: payload.id,
			email: typeof payload.email === "string" ? payload.email : "",
			name:
				typeof payload.name === "string"
					? payload.name
					: typeof payload.username === "string"
						? payload.username
						: "",
		};
	} catch {
		return null;
	}
}

export interface QoderQuota {
	total: number;
	used: number;
	remaining: number;
	unit: string;
	isQuotaExceeded: boolean;
}

/** Credit balance, for the usage fetcher. Read-only; failures return null. */
export async function fetchQoderQuota(
	jobToken: string,
	endpoint?: string | null,
): Promise<QoderQuota | null> {
	try {
		const response = await fetch(
			`${resolveQoderOpenApiEndpoint(endpoint)}/api/v2/quota/usage`,
			{
				headers: {
					Authorization: `Bearer ${jobToken}`,
					Accept: "application/json",
					"User-Agent": "better-ccflare",
				},
			},
		);
		if (!response.ok) return null;
		const payload = (await response.json()) as {
			userQuota?: {
				total?: unknown;
				used?: unknown;
				remaining?: unknown;
				unit?: unknown;
			};
			isQuotaExceeded?: unknown;
		};
		const q = payload.userQuota ?? {};
		const num = (v: unknown) =>
			typeof v === "number" && Number.isFinite(v) ? v : 0;
		return {
			total: num(q.total),
			used: num(q.used),
			remaining: num(q.remaining),
			unit: typeof q.unit === "string" ? q.unit : "credits",
			isQuotaExceeded: payload.isQuotaExceeded === true,
		};
	} catch {
		return null;
	}
}

/**
 * How the job token was minted, encoded into the access token itself.
 *
 * The account row has exactly one place for "a short-lived token plus whatever
 * is needed to renew it", and the renewal path differs: a job token minted from
 * the PAT is renewed with the PAT, while one imported from the official CLI is
 * renewed with its own `jrt-` job refresh token. Carrying the mode as an opaque
 * prefix means no schema change and no extra write on the refresh path.
 *
 * Format: `__qoder_jwt.<mode>.<token>`. Anything else is a bare token
 * (the CLI's own), treated as mode `jrt`.
 */
const ACCESS_TOKEN_PREFIX = "__qoder_jwt.";
export type QoderTokenMode = "pat" | "jrt";

export function encodeQoderAccessToken(
	mode: QoderTokenMode,
	token: string,
): string {
	return `${ACCESS_TOKEN_PREFIX}${mode}.${token}`;
}

export function decodeQoderAccessToken(
	accessToken: string | null | undefined,
): {
	token: string;
	mode: QoderTokenMode;
} | null {
	if (!accessToken) return null;
	if (!accessToken.startsWith(ACCESS_TOKEN_PREFIX)) {
		return { token: accessToken, mode: "jrt" };
	}
	const rest = accessToken.slice(ACCESS_TOKEN_PREFIX.length);
	const dot = rest.indexOf(".");
	if (dot < 0) return null;
	const mode = rest.slice(0, dot);
	const token = rest.slice(dot + 1);
	if (!token || (mode !== "pat" && mode !== "jrt")) return null;
	return { token, mode };
}

/**
 * Mint a fresh job token for an account.
 *
 * Order of preference:
 *  1. The PAT in `refresh_token` — the documented, renewable credential.
 *  2. The access token's own `jrt-` job refresh token — the only option for a
 *     CLI-imported account, which has no PAT.
 */
export async function refreshQoderToken(
	account: Account,
): Promise<TokenRefreshResult> {
	const endpoint = account.custom_endpoint;
	const pat = account.refresh_token?.trim();

	if (pat) {
		const minted = await exchangeQoderPat(pat, endpoint);
		return {
			accessToken: encodeQoderAccessToken("pat", minted.accessToken),
			expiresAt: minted.expiresAt,
			// The PAT is the long-lived credential and is not rotated by the
			// exchange. Return it unchanged (an empty string would skip the
			// persist — and the account would keep the PAT either way).
			refreshToken: pat,
		};
	}

	const decoded = decodeQoderAccessToken(account.access_token);
	if (decoded?.token) {
		const rotated = await refreshQoderJobToken(decoded.token, endpoint);
		if (rotated) {
			return {
				accessToken: encodeQoderAccessToken(decoded.mode, rotated.accessToken),
				expiresAt: rotated.expiresAt,
				refreshToken: "",
			};
		}
	}

	throw new Error(
		`Qoder credential for account ${account.name} is unusable: invalid_grant (add a PAT from qoder.com/account/integrations)`,
	);
}
