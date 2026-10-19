import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import type { Account } from "@better-ccflare/types";
import { CODEBUDDY_CLI_VERSION } from "../auth-flow";
import { CodeBuddyProvider } from "../provider";

// ---------------------------------------------------------------------------
// Fixtures / helpers
// ---------------------------------------------------------------------------

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

function encodeJwtSegment(value: unknown): string {
	return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function makeJwt(payload: Record<string, unknown>): string {
	return `${encodeJwtSegment({ alg: "none", typ: "JWT" })}.${encodeJwtSegment(payload)}.signature`;
}

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}

function anthropicRequest(overrides: Record<string, unknown> = {}): Request {
	return new Request("https://proxy.local/v1/messages", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			model: "primary-model",
			max_tokens: 32,
			messages: [{ role: "user", content: "hello" }],
			...overrides,
		}),
	});
}

let originalFetch: typeof fetch;

beforeEach(() => {
	originalFetch = globalThis.fetch;
});

afterEach(() => {
	globalThis.fetch = originalFetch;
	delete process.env.CCFLARE_CODEBUDDY_ENDPOINT;
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("CodeBuddyProvider", () => {
	const provider = new CodeBuddyProvider();

	describe("name", () => {
		it('is "codebuddy"', () => {
			expect(provider.name).toBe("codebuddy");
		});
	});

	describe("supportsOAuth", () => {
		it("returns true", () => {
			expect(provider.supportsOAuth()).toBe(true);
		});
	});

	describe("buildUrl", () => {
		it("maps /v1/messages to the chat completions endpoint", () => {
			expect(
				provider.buildUrl(
					"/v1/messages",
					"?stream=true",
					makeAccount({ custom_endpoint: "https://cb.example.com/" }),
				),
			).toBe("https://cb.example.com/v2/chat/completions");
		});

		it("uses the default endpoint when the account has none", () => {
			expect(provider.buildUrl("/v1/messages", "", makeAccount())).toBe(
				"https://www.codebuddy.ai/v2/chat/completions",
			);
		});

		it("maps count_tokens to the local synthetic URL", () => {
			expect(
				provider.buildUrl("/v1/messages/count_tokens", "", makeAccount()),
			).toBe("https://better-ccflare.local/codebuddy/count_tokens");
		});

		it("maps /v1/models to the v3 config endpoint", () => {
			expect(
				provider.buildUrl(
					"/v1/models",
					"",
					makeAccount({ custom_endpoint: "https://cb.example.com" }),
				),
			).toBe("https://cb.example.com/v3/config");
		});

		it("passes other paths through to the endpoint", () => {
			expect(
				provider.buildUrl(
					"/v2/plugin/account",
					"?x=1",
					makeAccount({ custom_endpoint: "https://cb.example.com" }),
				),
			).toBe("https://cb.example.com/v2/plugin/account?x=1");
		});
	});

	describe("prepareHeaders", () => {
		it("uses the bearer access token", () => {
			const headers = provider.prepareHeaders(new Headers(), "access-1");
			expect(headers.get("Authorization")).toBe("Bearer access-1");
		});

		it("uses X-API-Key when only an API key is available", () => {
			const headers = provider.prepareHeaders(
				new Headers(),
				undefined,
				"api-key-1",
			);
			expect(headers.get("X-API-Key")).toBe("api-key-1");
			expect(headers.get("Authorization")).toBeNull();
		});

		it("adds identity headers decoded from the access token", () => {
			const token = makeJwt({
				sub: "user-1",
				enterprise_id: "enterprise-7",
			});
			const headers = provider.prepareHeaders(new Headers(), token);

			expect(headers.get("X-User-Id")).toBe("user-1");
			expect(headers.get("X-Enterprise-Id")).toBe("enterprise-7");

			const userinfo = JSON.parse(
				Buffer.from(headers.get("X-Userinfo") ?? "", "base64").toString("utf8"),
			);
			expect(userinfo).toEqual({
				uin: "user-1",
				owner_uin: "enterprise-7",
			});
		});

		it("omits identity headers when the token has no uid", () => {
			const headers = provider.prepareHeaders(new Headers(), "opaque-token");
			expect(headers.get("X-User-Id")).toBeNull();
			expect(headers.get("X-Enterprise-Id")).toBeNull();
			expect(headers.get("X-Userinfo")).toBeNull();
		});

		it("strips client auth and internal proxy headers", () => {
			const incoming = new Headers({
				authorization: "Bearer client-token",
				"x-api-key": "client-key",
				host: "proxy.local",
				cookie: "session=secret",
				"anthropic-version": "2023-06-01",
				"anthropic-beta": "some-beta",
				"anthropic-dangerous-direct-browser-access": "true",
				"x-better-ccflare-account-id": "account-1",
				"cf-connecting-ip": "203.0.113.1",
				"x-forwarded-for": "203.0.113.1",
				"cdn-loop": "cloudflare",
				forwarded: "for=203.0.113.1",
				"x-real-ip": "203.0.113.1",
			});

			const headers = provider.prepareHeaders(incoming, "access-1");

			expect(headers.get("authorization")).toBe("Bearer access-1");
			expect(headers.get("x-api-key")).toBeNull();
			expect(headers.get("host")).toBeNull();
			expect(headers.get("cookie")).toBeNull();
			expect(headers.get("anthropic-version")).toBeNull();
			expect(headers.get("anthropic-beta")).toBeNull();
			expect(
				headers.get("anthropic-dangerous-direct-browser-access"),
			).toBeNull();
			expect(headers.get("x-better-ccflare-account-id")).toBeNull();
			expect(headers.get("cf-connecting-ip")).toBeNull();
			expect(headers.get("x-forwarded-for")).toBeNull();
			expect(headers.get("cdn-loop")).toBeNull();
			expect(headers.get("forwarded")).toBeNull();
			expect(headers.get("x-real-ip")).toBeNull();
		});

		it("sets CLI identity headers and request ids", () => {
			const headers = provider.prepareHeaders(new Headers(), "access-1");

			expect(headers.get("X-Agent-Intent")).toBe("craft");
			expect(headers.get("X-Agent-Runtime")).toBe("local-agent");
			expect(headers.get("X-IDE-Type")).toBe("CLI");
			expect(headers.get("X-IDE-Name")).toBe("CLI");
			expect(headers.get("X-IDE-Version")).toBe(CODEBUDDY_CLI_VERSION);
			expect(headers.get("X-Product")).toBe("SaaS");
			expect(headers.get("User-Agent")).toBe(
				`CLI/${CODEBUDDY_CLI_VERSION} CodeBuddy/${CODEBUDDY_CLI_VERSION}`,
			);

			expect(headers.get("X-Conversation-ID")).toMatch(
				/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
			);
			expect(headers.get("X-Conversation-Request-ID")).toMatch(
				/^[0-9a-f]{32}$/,
			);
			expect(headers.get("X-Conversation-Message-ID")).toBe(
				headers.get("X-Conversation-Request-ID"),
			);
			expect(headers.get("X-Request-ID")).toBe(
				headers.get("X-Conversation-Request-ID"),
			);
		});
	});

	describe("transformRequestBody", () => {
		it("maps reasoning to reasoning_effort and sets CodeBuddy fields", async () => {
			const transformed = await provider.transformRequestBody(
				anthropicRequest({ reasoning: { effort: "high" } }),
				makeAccount(),
			);
			const body = (await transformed.json()) as Record<string, unknown>;

			expect(body.reasoning_effort).toBe("high");
			expect(body.reasoning).toBeUndefined();
			expect(body.reasoning_summary).toBe("auto");
			expect(body.cache_retention).toBe("long");
			expect(body.store).toBe(false);
		});

		it("does not set reasoning_summary when there is no effort", async () => {
			const transformed = await provider.transformRequestBody(
				anthropicRequest(),
				makeAccount(),
			);
			const body = (await transformed.json()) as Record<string, unknown>;

			expect(body.reasoning_effort).toBeUndefined();
			expect(body.reasoning_summary).toBeUndefined();
			expect(body.cache_retention).toBe("long");
			expect(body.store).toBe(false);
		});

		it("returns a synthetic count_tokens response", async () => {
			const url = provider.buildUrl(
				"/v1/messages/count_tokens",
				"",
				makeAccount(),
			);
			const request = new Request(url, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					model: "primary-model",
					max_tokens: 16,
					messages: [{ role: "user", content: "hello world" }],
				}),
			});

			const transformed = await provider.transformRequestBody(
				request,
				makeAccount(),
			);
			const body = (await transformed.json()) as { input_tokens?: number };

			expect(
				transformed.headers.get("x-better-ccflare-synthetic-response"),
			).toBe("true");
			expect(transformed.headers.get("x-better-ccflare-synthetic-status")).toBe(
				"200",
			);
			expect(body.input_tokens).toBeGreaterThan(0);
		});
	});

	describe("processResponse", () => {
		it("maps the v3 config agents list to an OpenAI model list", async () => {
			const response = jsonResponse({
				code: 0,
				data: {
					agents: [
						{
							name: "other",
							models: [{ id: "ignored-model" }],
						},
						{
							name: "cli",
							models: [
								{ id: "primary-model", name: "Primary" },
								{ name: "balanced-model" },
								{ description: "no id or name" },
							],
						},
					],
				},
			});
			response.headers.set("x-better-ccflare-request-path", "/v1/models");

			const transformed = await provider.processResponse(response, null);
			const body = (await transformed.json()) as {
				object: string;
				data: Array<Record<string, unknown>>;
				models: Array<Record<string, unknown>>;
			};

			expect(body.object).toBe("list");
			expect(body.data.map((model) => model.id)).toEqual([
				"primary-model",
				"balanced-model",
			]);
			expect(body.data[0]).toMatchObject({
				id: "primary-model",
				object: "model",
				owned_by: "codebuddy",
			});
			expect(typeof body.data[0].created).toBe("number");
			expect(body.models).toEqual(body.data);
		});

		it("returns an empty list when the cli agent is absent", async () => {
			const response = jsonResponse({ code: 0, data: { agents: [] } });
			response.headers.set("x-better-ccflare-request-path", "/v1/models");

			const transformed = await provider.processResponse(response, null);
			const body = (await transformed.json()) as {
				object: string;
				data: unknown[];
			};

			expect(body).toEqual({ object: "list", data: [], models: [] });
		});

		it("returns a 502 when the models payload is malformed", async () => {
			const response = new Response("not json", {
				status: 200,
				headers: {
					"content-type": "application/json",
					"x-better-ccflare-request-path": "/v1/models",
				},
			});

			const transformed = await provider.processResponse(response, null);
			const body = (await transformed.json()) as {
				error?: { type?: string };
			};

			expect(transformed.status).toBe(502);
			expect(body.error?.type).toBe("api_error");
		});
	});

	describe("refreshToken", () => {
		it("delegates to the CodeBuddy refresh flow", async () => {
			globalThis.fetch = mock(async () =>
				jsonResponse({
					code: 0,
					data: { accessToken: "new-access", expiresIn: 60 },
				}),
			) as unknown as typeof fetch;

			const result = await provider.refreshToken(
				makeAccount({
					refresh_token: "old-refresh",
					custom_endpoint: "https://cb.example.com",
				}),
				"",
			);

			expect(result.accessToken).toBe("new-access");
			expect(result.refreshToken).toBe("old-refresh");
		});
	});
});
