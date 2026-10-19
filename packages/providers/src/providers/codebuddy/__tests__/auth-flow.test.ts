import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import type { Account } from "@better-ccflare/types";
import {
	beginCodeBuddyAuth,
	CODEBUDDY_CLI_VERSION,
	CODEBUDDY_DEFAULT_ENDPOINT,
	decodeCodeBuddyIdentity,
	fetchCodeBuddyAccount,
	pollCodeBuddyAuth,
	refreshCodeBuddyToken,
	resolveCodeBuddyEndpoint,
} from "../auth-flow";

// ---------------------------------------------------------------------------
// Fixtures / helpers
// ---------------------------------------------------------------------------

const ENV_ENDPOINT = "CCFLARE_CODEBUDDY_ENDPOINT";

function makeAccount(overrides: Partial<Account> = {}): Account {
	return {
		id: "codebuddy-1",
		name: "codebuddy-test",
		provider: "codebuddy",
		api_key: null,
		refresh_token: "refresh-token",
		access_token: null,
		expires_at: null,
		request_count: 0,
		total_requests: 0,
		last_used: null,
		created_at: Date.now(),
		rate_limited_until: null,
		rate_limited_reason: null,
		rate_limited_at: null,
		session_start: null,
		session_request_count: 0,
		paused: false,
		requires_reauth: false,
		rate_limit_reset: null,
		rate_limit_status: null,
		rate_limit_remaining: null,
		priority: 0,
		auto_fallback_enabled: false,
		auto_refresh_enabled: false,
		auto_pause_on_overage_enabled: false,
		peak_hours_pause_enabled: false,
		usage_pause_five_hour_threshold: null,
		usage_pause_weekly_threshold: null,
		usage_pause_five_hour_enabled: false,
		usage_pause_weekly_enabled: false,
		custom_endpoint: null,
		model_mappings: null,
		request_transformer: null,
		cross_region_mode: null,
		model_fallbacks: null,
		billing_type: null,
		pause_reason: null,
		refresh_token_issued_at: null,
		last_manual_reauth_at: null,
		consecutive_rate_limits: 0,
		...overrides,
	};
}

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}

function encodeJwtSegment(value: unknown): string {
	return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function makeJwt(payload: Record<string, unknown>): string {
	return `${encodeJwtSegment({ alg: "none", typ: "JWT" })}.${encodeJwtSegment(payload)}.signature`;
}

let originalFetch: typeof fetch;

beforeEach(() => {
	originalFetch = globalThis.fetch;
});

afterEach(() => {
	globalThis.fetch = originalFetch;
	delete process.env[ENV_ENDPOINT];
});

// ---------------------------------------------------------------------------
// Endpoint resolution
// ---------------------------------------------------------------------------

describe("resolveCodeBuddyEndpoint", () => {
	it("uses the explicit endpoint and strips trailing slashes", () => {
		expect(resolveCodeBuddyEndpoint("https://custom.example.com///")).toBe(
			"https://custom.example.com",
		);
	});

	it("uses CCFLARE_CODEBUDDY_ENDPOINT when no explicit endpoint is given", () => {
		process.env[ENV_ENDPOINT] = "https://env.example.com/";
		expect(resolveCodeBuddyEndpoint()).toBe("https://env.example.com");
	});

	it("prefers the explicit endpoint over the environment", () => {
		process.env[ENV_ENDPOINT] = "https://env.example.com";
		expect(resolveCodeBuddyEndpoint("https://explicit.example.com")).toBe(
			"https://explicit.example.com",
		);
	});

	it("falls back to the default endpoint", () => {
		expect(resolveCodeBuddyEndpoint()).toBe(CODEBUDDY_DEFAULT_ENDPOINT);
		expect(resolveCodeBuddyEndpoint(null)).toBe(CODEBUDDY_DEFAULT_ENDPOINT);
	});
});

// ---------------------------------------------------------------------------
// beginCodeBuddyAuth
// ---------------------------------------------------------------------------

describe("beginCodeBuddyAuth", () => {
	it("posts to the state endpoint with the CLI headers and empty JSON body", async () => {
		const fetchMock = mock(async () =>
			jsonResponse({
				code: 0,
				data: { state: "state-1", authUrl: "https://auth.example.com/start" },
			}),
		);
		globalThis.fetch = fetchMock as unknown as typeof fetch;

		const session = await beginCodeBuddyAuth("https://cb.example.com/");

		expect(session).toEqual({
			state: "state-1",
			authUrl: "https://auth.example.com/start",
			endpoint: "https://cb.example.com",
		});

		expect(fetchMock).toHaveBeenCalledTimes(1);
		const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
		expect(url).toBe(
			"https://cb.example.com/v2/plugin/auth/state?platform=CLI",
		);
		expect(init.method).toBe("POST");
		expect(init.body).toBe("{}");

		const headers = new Headers(init.headers);
		expect(headers.get("X-No-Authorization")).toBe("true");
		expect(headers.get("X-No-User-Id")).toBe("true");
		expect(headers.get("X-No-Enterprise-Id")).toBe("true");
		expect(headers.get("X-No-Department-Info")).toBe("true");
		expect(headers.get("X-Domain")).toBe("cb.example.com");
		expect(headers.get("Content-Type")).toBe("application/json");
		expect(headers.get("Accept")).toBe("application/json, text/plain, */*");
		expect(headers.get("User-Agent")).toBe(
			`CLI/${CODEBUDDY_CLI_VERSION} CodeBuddy/${CODEBUDDY_CLI_VERSION}`,
		);
	});

	it("throws the upstream message when the envelope code is non-zero", async () => {
		globalThis.fetch = mock(async () =>
			jsonResponse({ code: 500, msg: "state creation failed" }),
		) as unknown as typeof fetch;

		await expect(beginCodeBuddyAuth()).rejects.toThrow(/state creation failed/);
	});

	it("throws when state or authUrl is missing", async () => {
		globalThis.fetch = mock(async () =>
			jsonResponse({ code: 0, data: { state: "only-state" } }),
		) as unknown as typeof fetch;

		await expect(beginCodeBuddyAuth()).rejects.toThrow(/authUrl/i);
	});
});

// ---------------------------------------------------------------------------
// pollCodeBuddyAuth
// ---------------------------------------------------------------------------

describe("pollCodeBuddyAuth", () => {
	const session = {
		state: "state-1",
		authUrl: "https://auth.example.com/start",
		endpoint: "https://cb.example.com",
	};

	it("polls until the pending code clears and returns the tokens", async () => {
		let calls = 0;
		const fetchMock = mock(async () => {
			calls += 1;
			if (calls === 1) {
				return jsonResponse({ code: 11217 });
			}
			return jsonResponse({
				code: 0,
				data: {
					accessToken: "access-1",
					refreshToken: "refresh-1",
					expiresIn: 3600,
					domain: "tenant.example.com",
					tokenType: "Bearer",
					scope: "all",
				},
			});
		});
		globalThis.fetch = fetchMock as unknown as typeof fetch;

		const attempts: number[] = [];
		const tokens = await pollCodeBuddyAuth(session, {
			timeoutMs: 5_000,
			intervalMs: 0,
			onTick: (attempt) => attempts.push(attempt),
		});

		expect(tokens).toEqual({
			accessToken: "access-1",
			refreshToken: "refresh-1",
			expiresIn: 3600,
			domain: "tenant.example.com",
			tokenType: "Bearer",
			scope: "all",
		});
		expect(attempts).toEqual([1, 2]);

		const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
		expect(url).toBe(
			"https://cb.example.com/v2/plugin/auth/token?state=state-1",
		);
		expect(init.method).toBe("GET");
	});

	it("applies defaults for optional token fields", async () => {
		globalThis.fetch = mock(async () =>
			jsonResponse({ code: 0, data: { accessToken: "access-1" } }),
		) as unknown as typeof fetch;

		const tokens = await pollCodeBuddyAuth(session, {
			timeoutMs: 5_000,
			intervalMs: 0,
		});

		expect(tokens.refreshToken).toBe("");
		expect(tokens.expiresIn).toBe(1800);
	});

	it("times out while the envelope stays pending", async () => {
		globalThis.fetch = mock(async () =>
			jsonResponse({ code: 11217 }),
		) as unknown as typeof fetch;

		await expect(
			pollCodeBuddyAuth(session, { timeoutMs: 15, intervalMs: 1 }),
		).rejects.toThrow(/Timed out waiting for CodeBuddy authorization/);
	});

	it("aborts a stalled token request at the deadline", async () => {
		globalThis.fetch = mock(
			(_url: string, init?: RequestInit) =>
				new Promise((_resolve, reject) => {
					init?.signal?.addEventListener("abort", () =>
						reject(new Error("aborted")),
					);
				}),
		) as unknown as typeof fetch;

		await expect(
			pollCodeBuddyAuth(session, { timeoutMs: 20, intervalMs: 1 }),
		).rejects.toThrow(/Timed out waiting for CodeBuddy authorization/);
	});

	it("throws on a terminal envelope code", async () => {
		globalThis.fetch = mock(async () =>
			jsonResponse({ code: 400, msg: "authorization denied" }),
		) as unknown as typeof fetch;

		await expect(
			pollCodeBuddyAuth(session, { timeoutMs: 5_000, intervalMs: 0 }),
		).rejects.toThrow(/authorization denied/);
	});
});

// ---------------------------------------------------------------------------
// decodeCodeBuddyIdentity
// ---------------------------------------------------------------------------

describe("decodeCodeBuddyIdentity", () => {
	it("extracts the uid, nickname, enterprise id and issuer domain", () => {
		const token = makeJwt({
			sub: "user-1",
			nickname: "Code Buddy",
			enterprise_id: "enterprise-7",
			iss: "https://tenant.example.com/sso-ent-9",
		});

		expect(decodeCodeBuddyIdentity(token)).toEqual({
			uid: "user-1",
			nickname: "Code Buddy",
			enterpriseId: "enterprise-7",
			domain: "tenant.example.com",
		});
	});

	it("falls back to preferred_username and the sso- issuer segment", () => {
		const token = makeJwt({
			sub: "user-2",
			preferred_username: "buddy",
			iss: "https://tenant.example.com/sso-ent-9",
		});

		expect(decodeCodeBuddyIdentity(token)).toEqual({
			uid: "user-2",
			nickname: "buddy",
			enterpriseId: "ent-9",
			domain: "tenant.example.com",
		});
	});

	it("reads the domain from a hostname-shaped issuer", () => {
		const token = makeJwt({
			sub: "user-3",
			iss: "https://x.sso-abc.example.com/",
		});

		const identity = decodeCodeBuddyIdentity(token);
		expect(identity.uid).toBe("user-3");
		expect(identity.domain).toBe("x.sso-abc.example.com");
	});

	it("returns an empty object for a malformed token", () => {
		expect(decodeCodeBuddyIdentity("not-a-jwt")).toEqual({});
		expect(decodeCodeBuddyIdentity("a.%%%.c")).toEqual({});
	});
});

// ---------------------------------------------------------------------------
// fetchCodeBuddyAccount
// ---------------------------------------------------------------------------

describe("fetchCodeBuddyAccount", () => {
	it("requests the account with the bearer token and domain", async () => {
		const fetchMock = mock(async () =>
			jsonResponse({ code: 0, data: { nickname: "Buddy", uid: "u1" } }),
		);
		globalThis.fetch = fetchMock as unknown as typeof fetch;

		const account = await fetchCodeBuddyAccount(
			{ accessToken: "access-1", domain: "tenant.example.com" },
			"https://cb.example.com",
		);

		expect(account).toEqual({ nickname: "Buddy", uid: "u1" });
		const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
		expect(url).toBe("https://cb.example.com/v2/plugin/account");
		const headers = new Headers(init.headers);
		expect(headers.get("Authorization")).toBe("Bearer access-1");
		expect(headers.get("X-Domain")).toBe("tenant.example.com");
		expect(headers.get("User-Agent")).toBe(
			`CLI/${CODEBUDDY_CLI_VERSION} CodeBuddy/${CODEBUDDY_CLI_VERSION}`,
		);
	});

	it("falls back to the endpoint host for X-Domain", async () => {
		const fetchMock = mock(async () => jsonResponse({ code: 0, data: {} }));
		globalThis.fetch = fetchMock as unknown as typeof fetch;

		await fetchCodeBuddyAccount(
			{ accessToken: "access-1" },
			"https://cb.example.com",
		);

		const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
		expect(new Headers(init.headers).get("X-Domain")).toBe("cb.example.com");
	});

	it("returns null for a pending or error envelope", async () => {
		globalThis.fetch = mock(async () =>
			jsonResponse({ code: 12151, msg: "pending" }),
		) as unknown as typeof fetch;

		await expect(
			fetchCodeBuddyAccount(
				{ accessToken: "access-1" },
				"https://cb.example.com",
			),
		).resolves.toBeNull();
	});

	it("returns null instead of throwing on transport failure", async () => {
		globalThis.fetch = mock(async () => {
			throw new Error("network down");
		}) as unknown as typeof fetch;

		await expect(
			fetchCodeBuddyAccount(
				{ accessToken: "access-1" },
				"https://cb.example.com",
			),
		).resolves.toBeNull();
	});
});

// ---------------------------------------------------------------------------
// refreshCodeBuddyToken
// ---------------------------------------------------------------------------

describe("refreshCodeBuddyToken", () => {
	function accountWithJwt(overrides: Partial<Account> = {}): Account {
		return makeAccount({
			access_token: makeJwt({
				sub: "user-1",
				iss: "https://tenant.example.com/sso-ent-9",
			}),
			refresh_token: "old-refresh",
			custom_endpoint: "https://cb.example.com",
			...overrides,
		});
	}

	it("posts the refresh token with the plugin headers", async () => {
		const fetchMock = mock(async () =>
			jsonResponse({
				code: 0,
				data: {
					accessToken: "new-access",
					refreshToken: "new-refresh",
					expiresIn: 120,
				},
			}),
		);
		globalThis.fetch = fetchMock as unknown as typeof fetch;

		const before = Date.now();
		const result = await refreshCodeBuddyToken(accountWithJwt());

		expect(result.accessToken).toBe("new-access");
		expect(result.refreshToken).toBe("new-refresh");
		expect(result.expiresAt).toBeGreaterThanOrEqual(before + 119_000);
		expect(result.expiresAt).toBeLessThanOrEqual(Date.now() + 121_000);

		const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
		expect(url).toBe("https://cb.example.com/v2/plugin/auth/token/refresh");
		expect(init.method).toBe("POST");
		expect(init.body).toBe("{}");
		const headers = new Headers(init.headers);
		expect(headers.get("X-Refresh-Token")).toBe("old-refresh");
		expect(headers.get("X-Auth-Refresh-Source")).toBe("plugin");
		expect(headers.get("X-Domain")).toBe("tenant.example.com");
		expect(headers.get("User-Agent")).toBe(
			`CLI/${CODEBUDDY_CLI_VERSION} CodeBuddy/${CODEBUDDY_CLI_VERSION}`,
		);
	});

	it("keeps the existing refresh token when the response omits one", async () => {
		globalThis.fetch = mock(async () =>
			jsonResponse({ code: 0, data: { accessToken: "new-access" } }),
		) as unknown as typeof fetch;

		const result = await refreshCodeBuddyToken(accountWithJwt());

		expect(result.refreshToken).toBe("old-refresh");
	});

	it("prefers a numeric expiresAt from the response", async () => {
		const upstreamExpiresAt = Date.now() + 900_000;
		globalThis.fetch = mock(async () =>
			jsonResponse({
				code: 0,
				data: { accessToken: "new-access", expiresAt: upstreamExpiresAt },
			}),
		) as unknown as typeof fetch;

		const result = await refreshCodeBuddyToken(accountWithJwt());

		expect(result.expiresAt).toBe(upstreamExpiresAt);
	});

	it("marks the account for reauth on 401 with invalid_grant", async () => {
		globalThis.fetch = mock(async () =>
			jsonResponse({ code: 401, msg: "refresh token revoked" }, 401),
		) as unknown as typeof fetch;

		const error = await refreshCodeBuddyToken(accountWithJwt()).catch(
			(caught: unknown) => caught as Error,
		);

		expect(error).toBeInstanceOf(Error);
		expect(error.message).toContain("invalid_grant");
		expect(error.message).toContain("refresh token revoked");
	});

	it("marks the account for reauth on 403 with invalid_grant", async () => {
		globalThis.fetch = mock(async () =>
			jsonResponse({ code: 403 }, 403),
		) as unknown as typeof fetch;

		await expect(refreshCodeBuddyToken(accountWithJwt())).rejects.toThrow(
			/invalid_grant/,
		);
	});

	it("throws when the account has no refresh token", async () => {
		await expect(
			refreshCodeBuddyToken(accountWithJwt({ refresh_token: "" })),
		).rejects.toThrow(/refresh token/i);
	});
});
