import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { Account } from "@better-ccflare/types";
import {
	decodeQoderAccessToken,
	exchangeQoderPat,
	fetchQoderUserInfo,
	QODER_DEFAULT_OPENAPI_ENDPOINT,
	QODER_OPENAPI_ENDPOINT_ENV,
	refreshQoderJobToken,
	resolveQoderOpenApiEndpoint,
} from "../auth-flow";

const ENV = QODER_OPENAPI_ENDPOINT_ENV;

function makeAccount(overrides: Partial<Account> = {}): Account {
	return {
		id: "qoder-1",
		name: "qoder-test",
		provider: "qoder",
		api_key: null,
		refresh_token: "pt-personal-token",
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

interface Captured {
	url: string;
	init: RequestInit | undefined;
}

let calls: Captured[] = [];
let originalFetch: typeof fetch;

function respond(body: unknown, status = 200): void {
	globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
		calls.push({ url: String(input), init });
		return new Response(
			typeof body === "string" ? body : JSON.stringify(body),
			{
				status,
				headers: { "content-type": "application/json" },
			},
		);
	}) as unknown as typeof fetch;
}

beforeEach(() => {
	originalFetch = globalThis.fetch;
	calls = [];
});

afterEach(() => {
	globalThis.fetch = originalFetch;
	delete process.env[ENV];
});

describe("resolveQoderOpenApiEndpoint", () => {
	it("defaults to the international host", () => {
		expect(resolveQoderOpenApiEndpoint(null)).toBe(
			QODER_DEFAULT_OPENAPI_ENDPOINT,
		);
		expect(QODER_DEFAULT_OPENAPI_ENDPOINT).toBe("https://openapi.qoder.sh");
	});

	it("honours the account's custom endpoint and strips trailing slashes", () => {
		expect(resolveQoderOpenApiEndpoint("https://openapi.qoder.com.cn//")).toBe(
			"https://openapi.qoder.com.cn",
		);
	});

	it("falls back to the environment override", () => {
		process.env[ENV] = "https://env.example.com/";
		expect(resolveQoderOpenApiEndpoint(null)).toBe("https://env.example.com");
	});

	it("prefers the environment over a gateway-derived host", () => {
		process.env[ENV] = "https://env.example.com";
		expect(resolveQoderOpenApiEndpoint("https://gateway.qoder.com.cn")).toBe(
			"https://env.example.com",
		);
	});

	it("prefers an explicit openapiEndpoint in a JSON endpoint", () => {
		process.env[ENV] = "https://env.example.com";
		expect(
			resolveQoderOpenApiEndpoint(
				JSON.stringify({
					endpoint: "https://gateway.qoder.com.cn",
					openapiEndpoint: "https://openapi.example.com",
				}),
			),
		).toBe("https://openapi.example.com");
	});

	it("derives the documented CN pair from a gateway host", () => {
		expect(
			resolveQoderOpenApiEndpoint({
				custom_endpoint: "https://gateway.qoder.com.cn",
			}),
		).toBe("https://openapi.qoder.com.cn");
	});

	it("keeps an account that already names the OpenAPI host working", () => {
		expect(
			resolveQoderOpenApiEndpoint({
				custom_endpoint: "https://openapi.qoder.com.cn/",
			}),
		).toBe("https://openapi.qoder.com.cn");
	});
});

describe("exchangeQoderPat", () => {
	it("posts the PAT to the exchange endpoint with the documented headers", async () => {
		respond({
			token: "jt-access",
			refresh_token: "jrt-refresh",
			expires_at: "2026-10-23T09:08:09Z",
		});

		const result = await exchangeQoderPat("pt-abc");

		expect(calls).toHaveLength(1);
		expect(calls[0].url).toBe(
			"https://openapi.qoder.sh/api/v1/jobToken/exchange",
		);
		expect(calls[0].init?.method).toBe("POST");
		const headers = new Headers(calls[0].init?.headers);
		expect(headers.get("content-type")).toBe("application/json");
		expect(headers.get("cosy-version")).toBe("1.0.1");
		expect(headers.get("cosy-clienttype")).toBe("5");
		expect(JSON.parse(String(calls[0].init?.body))).toEqual({
			personal_token: "pt-abc",
		});

		expect(result.accessToken).toBe("jt-access");
		expect(result.jobRefreshToken).toBe("jrt-refresh");
		expect(result.expiresAt).toBe(Date.parse("2026-10-23T09:08:09Z"));
	});

	it("never places the PAT in a header", async () => {
		respond({ token: "jt", refresh_token: "jrt", expires_at: null });
		await exchangeQoderPat("pt-secret");
		const headers = new Headers(calls[0].init?.headers);
		expect(headers.get("authorization")).toBeNull();
		for (const [, value] of headers.entries()) {
			expect(value).not.toContain("pt-secret");
		}
	});

	it("reports no job refresh token when Qoder omits one", async () => {
		respond({ token: "jt", expires_at: null });
		const result = await exchangeQoderPat("pt-abc");
		expect(result.jobRefreshToken).toBeNull();
	});

	it("carries invalid_grant on a 401 so the token manager marks reauth", async () => {
		respond({ error: "unauthorized" }, 401);
		await expect(exchangeQoderPat("pt-dead")).rejects.toThrow(/invalid_grant/);
	});

	it("does not claim invalid_grant for a transient 5xx", async () => {
		respond("upstream down", 503);
		await expect(exchangeQoderPat("pt-abc")).rejects.toThrow(/503/);
		try {
			respond("upstream down", 503);
			await exchangeQoderPat("pt-abc");
		} catch (error) {
			expect(String(error)).not.toContain("invalid_grant");
		}
	});

	it("redacts the PAT from upstream error text", async () => {
		respond("bad token pt-supersecret rejected", 400);
		try {
			await exchangeQoderPat("pt-supersecret");
			throw new Error("expected rejection");
		} catch (error) {
			expect(String(error)).not.toContain("pt-supersecret");
			expect(String(error)).toContain("[redacted]");
		}
	});

	it("rejects when the response has no token", async () => {
		respond({ refresh_token: "jrt" });
		await expect(exchangeQoderPat("pt-abc")).rejects.toThrow(/token/i);
	});

	it("defaults the expiry when expires_at is absent or unparseable", async () => {
		respond({ token: "jt", expires_at: "not-a-date" });
		const result = await exchangeQoderPat("pt-abc");
		expect(result.expiresAt).toBeGreaterThan(Date.now());
	});
});

describe("refreshQoderJobToken", () => {
	it("posts the job refresh token to the refresh endpoint", async () => {
		respond({ token: "jt-new", refresh_token: "jrt-new" });
		const result = await refreshQoderJobToken("jrt-old");
		expect(calls[0].url).toBe(
			"https://openapi.qoder.sh/api/v1/jobToken/refresh",
		);
		expect(JSON.parse(String(calls[0].init?.body))).toEqual({
			refresh_token: "jrt-old",
		});
		expect(result?.accessToken).toBe("jt-new");
		expect(result?.jobRefreshToken).toBe("jrt-new");
	});

	it("returns null on any failure so callers can fall back to the PAT", async () => {
		respond("nope", 500);
		expect(await refreshQoderJobToken("jrt")).toBeNull();
	});

	it("returns null on a network error", async () => {
		globalThis.fetch = (async () => {
			throw new Error("ECONNREFUSED");
		}) as unknown as typeof fetch;
		expect(await refreshQoderJobToken("jrt")).toBeNull();
	});
});

describe("fetchQoderUserInfo", () => {
	it("reads the uid with a bearer job token", async () => {
		respond({ id: "u-42", email: "a@b.c", name: "Tester" });
		const info = await fetchQoderUserInfo("jt-abc");
		expect(calls[0].url).toBe("https://openapi.qoder.sh/api/v1/userinfo");
		expect(new Headers(calls[0].init?.headers).get("authorization")).toBe(
			"Bearer jt-abc",
		);
		expect(info).toEqual({ uid: "u-42", email: "a@b.c", name: "Tester" });
	});

	it("returns null for a non-ok response", async () => {
		respond({}, 401);
		expect(await fetchQoderUserInfo("jt")).toBeNull();
	});

	it("reads the uid from the account's OpenAPI host", async () => {
		respond({ id: "u-42" });
		await fetchQoderUserInfo("jt-abc", {
			custom_endpoint: "https://gateway.qoder.com.cn",
		});
		expect(calls[0].url).toBe("https://openapi.qoder.com.cn/api/v1/userinfo");
	});
});

describe("the PAT exchange follows the account's OpenAPI host", () => {
	it("exchanges against the derived CN host", async () => {
		respond({ token: "jt-access" });
		await exchangeQoderPat("pt-abc", {
			custom_endpoint: "https://gateway.qoder.com.cn",
		});
		expect(calls[0].url).toBe(
			"https://openapi.qoder.com.cn/api/v1/jobToken/exchange",
		);
	});
});

describe("QoderProvider.refreshToken", () => {
	// The provider delegates here; this is the contract the token manager sees.
	it("mints a job token from the PAT stored in refresh_token and keeps the PAT", async () => {
		const { QoderProvider } = await import("../provider");
		respond({
			token: "jt-access",
			refresh_token: "jrt-1",
			expires_at: new Date(Date.now() + 86_400_000).toISOString(),
		});
		const provider = new QoderProvider();
		const result = await provider.refreshToken(makeAccount(), "client");
		expect(decodeQoderAccessToken(result.accessToken)).toEqual({
			token: "jt-access",
			mode: "pat",
		});
		// The account's own credential is the PAT: rotating it away would strand
		// the account, so refreshToken must never overwrite refresh_token.
		expect(result.refreshToken).toBe("pt-personal-token");
		expect(calls[0].url).toBe(
			"https://openapi.qoder.sh/api/v1/jobToken/exchange",
		);
	});

	it("throws invalid_grant when the account has no PAT", async () => {
		const { QoderProvider } = await import("../provider");
		const provider = new QoderProvider();
		await expect(
			provider.refreshToken(makeAccount({ refresh_token: null }), "client"),
		).rejects.toThrow(/invalid_grant/);
	});
});
