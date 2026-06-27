import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import type { Account } from "@better-ccflare/types";
import {
	XAI_DEFAULT_ENDPOINT,
	XAI_MODEL_MAPPINGS,
	XAI_TOKEN_ENDPOINT,
	XaiProvider,
} from "./provider";

const account = (overrides: Partial<Account> = {}): Account => ({
	id: "xai-1",
	name: "xai-test",
	provider: "xai",
	api_key: null,
	refresh_token: "refresh-token",
	access_token: "access-token",
	expires_at: Date.now() + 60_000,
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
	rate_limit_reset: null,
	rate_limit_status: null,
	rate_limit_remaining: null,
	priority: 50,
	auto_fallback_enabled: true,
	auto_refresh_enabled: true,
	auto_pause_on_overage_enabled: false,
	peak_hours_pause_enabled: false,
	custom_endpoint: null,
	model_mappings: null,
	cross_region_mode: null,
	model_fallbacks: null,
	billing_type: null,
	pause_reason: null,
	refresh_token_issued_at: null,
	consecutive_rate_limits: 0,
	...overrides,
});

describe("XaiProvider", () => {
	let originalFetch: typeof fetch;

	beforeEach(() => {
		originalFetch = globalThis.fetch;
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	it("builds xAI chat completions URLs from Anthropic messages paths", () => {
		const provider = new XaiProvider();

		expect(provider.buildUrl("/v1/messages", "?foo=bar", account())).toBe(
			`${XAI_DEFAULT_ENDPOINT}/chat/completions?foo=bar`,
		);
	});

	it("uses default Grok model mappings when the account has none", async () => {
		const provider = new XaiProvider();
		const request = new Request("https://proxy.local/v1/messages", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				model: "claude-3-5-sonnet-20241022",
				max_tokens: 32,
				messages: [{ role: "user", content: "hello" }],
			}),
		});

		const transformed = await provider.transformRequestBody(request, account());
		const body = await transformed.json();

		expect(body.model).toBe(XAI_MODEL_MAPPINGS.sonnet);
	});

	it("preserves custom model mappings", async () => {
		const provider = new XaiProvider();
		const request = new Request("https://proxy.local/v1/messages", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				model: "claude-3-haiku",
				max_tokens: 32,
				messages: [{ role: "user", content: "hello" }],
			}),
		});

		const transformed = await provider.transformRequestBody(
			request,
			account({ model_mappings: JSON.stringify({ haiku: "grok-custom" }) }),
		);
		const body = await transformed.json();

		expect(body.model).toBe("grok-custom");
	});

	it("advertises Grok Build credits usage polling", () => {
		const provider = new XaiProvider();

		expect(provider.supportsUsageTracking()).toBe(true);
	});

	it("requests stream usage chunks for streaming xAI requests", async () => {
		const provider = new XaiProvider();
		const request = new Request("https://proxy.local/v1/messages", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				model: "claude-3-5-sonnet-20241022",
				max_tokens: 32,
				stream: true,
				messages: [{ role: "user", content: "hello" }],
			}),
		});

		const transformed = await provider.transformRequestBody(request, account());
		const body = await transformed.json();

		expect(body.stream).toBe(true);
		expect(body.stream_options).toEqual({ include_usage: true });
	});

	it("refreshes xAI OAuth tokens with the Grok client id", async () => {
		const provider = new XaiProvider();
		const fetchMock = mock(
			async (_input: RequestInfo | URL, init?: RequestInit) => {
				expect(String(_input)).toBe(XAI_TOKEN_ENDPOINT);
				expect(init?.method).toBe("POST");
				const body = init?.body?.toString() ?? "";
				expect(body).toContain("grant_type=refresh_token");
				expect(body).toContain("refresh_token=refresh-token");
				return new Response(
					JSON.stringify({
						access_token: "new-access-token",
						refresh_token: "new-refresh-token",
						expires_in: 3600,
					}),
					{ status: 200, headers: { "content-type": "application/json" } },
				);
			},
		);
		globalThis.fetch = fetchMock as unknown as typeof fetch;

		const result = await provider.refreshToken(account(), "unused");

		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(result.accessToken).toBe("new-access-token");
		expect(result.refreshToken).toBe("new-refresh-token");
		expect(result.expiresAt).toBeGreaterThan(Date.now());
	});
});
