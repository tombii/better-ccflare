import { describe, expect, it } from "bun:test";
import type { Account } from "@better-ccflare/types";
import { AnthropicProvider } from "../provider";

function makeAccount(overrides: Partial<Account> = {}): Account {
	return {
		id: "acct-1",
		name: "test-anthropic",
		provider: "claude-oauth",
		api_key: null,
		refresh_token: "rt",
		access_token: "at-bearer",
		expires_at: Date.now() + 3_600_000,
		request_count: 0,
		total_requests: 0,
		last_used: null,
		created_at: Date.now(),
		rate_limited_until: null,
		session_start: null,
		session_request_count: 0,
		paused: false,
		rate_limit_reset: null,
		rate_limit_status: null,
		rate_limit_remaining: null,
		priority: 0,
		auto_fallback_enabled: false,
		auto_refresh_enabled: false,
		custom_endpoint: null,
		model_mappings: null,
		cross_region_mode: null,
		model_fallbacks: null,
		billing_type: null,
		...overrides,
	};
}

describe("AnthropicProvider — streaming.test.ts", () => {
	const provider = new AnthropicProvider();

	// ─────────────────────────────────────────────
	// 1. parseRateLimit
	// ─────────────────────────────────────────────
	describe("parseRateLimit", () => {
		it("rate_limited status + reset header → isRateLimited:true and resetTime in ms", () => {
			const unixSeconds = 1_700_000_000;
			const response = new Response(null, {
				status: 200,
				headers: {
					"anthropic-ratelimit-unified-status": "rate_limited",
					"anthropic-ratelimit-unified-reset": String(unixSeconds),
				},
			});

			const result = provider.parseRateLimit(response);

			expect(result.isRateLimited).toBe(true);
			expect(result.resetTime).toBe(unixSeconds * 1000);
		});

		it("anthropic-ratelimit-unified-remaining: 0 → remaining: 0", () => {
			const response = new Response(null, {
				status: 200,
				headers: {
					"anthropic-ratelimit-unified-status": "rate_limited",
					"anthropic-ratelimit-unified-remaining": "0",
				},
			});

			const result = provider.parseRateLimit(response);

			expect(result.remaining).toBe(0);
		});

		it("429 status with no rate-limit headers → isRateLimited:true", () => {
			const response = new Response(null, { status: 429 });

			const result = provider.parseRateLimit(response);

			expect(result.isRateLimited).toBe(true);
		});

		it("200 status with no rate-limit headers → isRateLimited:false", () => {
			const response = new Response(null, {
				status: 200,
				headers: { "content-type": "application/json" },
			});

			const result = provider.parseRateLimit(response);

			expect(result.isRateLimited).toBe(false);
		});

		it("anthropic-ratelimit-unified-status: allowed → isRateLimited:false", () => {
			const response = new Response(null, {
				status: 200,
				headers: {
					"anthropic-ratelimit-unified-status": "allowed",
				},
			});

			const result = provider.parseRateLimit(response);

			expect(result.isRateLimited).toBe(false);
		});

		it("resetTime present but status is not rate_limited → isRateLimited:false", () => {
			const unixSeconds = 1_700_000_000;
			const response = new Response(null, {
				status: 200,
				headers: {
					"anthropic-ratelimit-unified-status": "allowed",
					"anthropic-ratelimit-unified-reset": String(unixSeconds),
				},
			});

			const result = provider.parseRateLimit(response);

			expect(result.isRateLimited).toBe(false);
			// resetTime is still parsed even when not rate limited
			expect(result.resetTime).toBe(unixSeconds * 1000);
		});

		it("blocked status → isRateLimited:true (hard limit)", () => {
			const response = new Response(null, {
				status: 200,
				headers: {
					"anthropic-ratelimit-unified-status": "blocked",
				},
			});

			const result = provider.parseRateLimit(response);

			expect(result.isRateLimited).toBe(true);
		});

		it("429 with x-ratelimit-reset header → uses that reset time converted to ms", () => {
			const unixSeconds = 1_700_000_000;
			const response = new Response(null, {
				status: 429,
				headers: {
					"x-ratelimit-reset": String(unixSeconds),
				},
			});

			const result = provider.parseRateLimit(response);

			expect(result.isRateLimited).toBe(true);
			expect(result.resetTime).toBe(unixSeconds * 1000);
		});
	});

	// ─────────────────────────────────────────────
	// 2. isStreamingResponse (from BaseProvider)
	// ─────────────────────────────────────────────
	describe("isStreamingResponse", () => {
		it("content-type: text/event-stream → true", () => {
			const response = new Response(null, {
				headers: { "content-type": "text/event-stream" },
			});
			expect(provider.isStreamingResponse?.(response)).toBe(true);
		});

		it("content-type: application/json → false", () => {
			const response = new Response(null, {
				headers: { "content-type": "application/json" },
			});
			expect(provider.isStreamingResponse?.(response)).toBe(false);
		});

		it("no content-type header → false", () => {
			const response = new Response(null, {});
			expect(provider.isStreamingResponse?.(response)).toBe(false);
		});
	});

	// ─────────────────────────────────────────────
	// 3. extractUsageInfo — SSE cache token fields
	// ─────────────────────────────────────────────
	describe("extractUsageInfo — SSE cache token fields", () => {
		it("SSE message_start with cache_creation and cache_read tokens → maps to correct fields", async () => {
			const messageStartData = JSON.stringify({
				type: "message_start",
				message: {
					model: "claude-opus-4-5",
					usage: {
						input_tokens: 100,
						output_tokens: 5,
						cache_creation_input_tokens: 10,
						cache_read_input_tokens: 5,
					},
				},
			});
			const sseBody = [
				"event: message_start",
				`data: ${messageStartData}`,
				"",
				"event: content_block_start",
				'data: {"type":"content_block_start","index":0}',
				"",
			].join("\n");

			const response = new Response(sseBody, {
				headers: { "content-type": "text/event-stream" },
			});

			const usage = await provider.extractUsageInfo(response);

			expect(usage).not.toBeNull();
			expect(usage?.cacheCreationInputTokens).toBe(10);
			expect(usage?.cacheReadInputTokens).toBe(5);
			// promptTokens = input + cache_creation + cache_read = 100 + 10 + 5
			expect(usage?.promptTokens).toBe(115);
			expect(usage?.inputTokens).toBe(100);
		});

		it("SSE message_start includes output_tokens (captured from message_start)", async () => {
			// The implementation only reads message_start (output_tokens from message_delta
			// is not captured — the code comments confirm this). Verify initial output_tokens
			// from message_start are returned correctly.
			const messageStartData = JSON.stringify({
				type: "message_start",
				message: {
					model: "claude-3-5-sonnet",
					usage: {
						input_tokens: 50,
						output_tokens: 0,
						cache_creation_input_tokens: 0,
						cache_read_input_tokens: 0,
					},
				},
			});
			const sseBody = [
				"event: message_start",
				`data: ${messageStartData}`,
				"",
			].join("\n");

			const response = new Response(sseBody, {
				headers: { "content-type": "text/event-stream" },
			});

			const usage = await provider.extractUsageInfo(response);

			expect(usage).not.toBeNull();
			expect(usage?.outputTokens).toBe(0);
			expect(usage?.completionTokens).toBe(0);
			expect(usage?.inputTokens).toBe(50);
			expect(usage?.totalTokens).toBe(50);
		});
	});

	// ─────────────────────────────────────────────
	// 4. extractUsageInfo — edge cases
	// ─────────────────────────────────────────────
	describe("extractUsageInfo — edge cases", () => {
		it("usage: {} (all fields missing) → returns object with 0 tokens, not null", async () => {
			const body = JSON.stringify({
				model: "claude-3-haiku",
				usage: {},
			});
			const response = new Response(body, {
				headers: { "content-type": "application/json" },
			});

			const usage = await provider.extractUsageInfo(response);

			// usage key is present so it returns an object (not null)
			expect(usage).not.toBeNull();
			expect(usage?.inputTokens).toBe(0);
			expect(usage?.outputTokens).toBe(0);
			expect(usage?.promptTokens).toBe(0);
			expect(usage?.completionTokens).toBe(0);
			expect(usage?.totalTokens).toBe(0);
		});

		it("JSON: input_tokens + cache_creation + cache_read → summed into promptTokens", async () => {
			const body = JSON.stringify({
				model: "claude-opus-4-5",
				usage: {
					input_tokens: 100,
					output_tokens: 20,
					cache_creation_input_tokens: 10,
					cache_read_input_tokens: 5,
				},
			});
			const response = new Response(body, {
				headers: { "content-type": "application/json" },
			});

			const usage = await provider.extractUsageInfo(response);

			expect(usage).not.toBeNull();
			// promptTokens = 100 + 10 + 5 = 115
			expect(usage?.promptTokens).toBe(115);
			// totalTokens = promptTokens + outputTokens = 115 + 20 = 135
			expect(usage?.totalTokens).toBe(135);
			expect(usage?.completionTokens).toBe(20);
		});
	});

	// ─────────────────────────────────────────────
	// 5. processResponse — SSE pass-through
	// ─────────────────────────────────────────────
	describe("processResponse — SSE pass-through for native Anthropic clients", () => {
		it("SSE body is returned byte-for-byte when anthropic-version header is present", async () => {
			// When the client sends anthropic-version, transformStreamToOpenAIFormat
			// skips transformation and returns the response unchanged.
			const events = [
				"event: message_start",
				'data: {"type":"message_start","message":{"id":"msg_1","model":"claude-3-5-sonnet","usage":{"input_tokens":10,"output_tokens":0}}}',
				"",
				"event: content_block_delta",
				'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hello"}}',
				"",
				"event: content_block_stop",
				'data: {"type":"content_block_stop","index":0}',
				"",
				"event: message_stop",
				'data: {"type":"message_stop"}',
				"",
			].join("\n");

			const original = new Response(events, {
				status: 200,
				headers: {
					"content-type": "text/event-stream",
					"x-request-id": "req-abc",
				},
			});

			// Native Anthropic SDK client: sends anthropic-version
			const requestHeaders = new Headers({
				"anthropic-version": "2023-06-01",
			});

			const result = await provider.processResponse(
				original,
				makeAccount(),
				requestHeaders,
			);

			expect(result.headers.get("content-type")).toBe("text/event-stream");
			const body = await result.text();
			expect(body).toBe(events);
		});

		it("returned response has content-type: text/event-stream for SSE input", async () => {
			const sseBody =
				"event: message_start\ndata: {}\n\nevent: message_stop\ndata: {}\n\n";
			const original = new Response(sseBody, {
				status: 200,
				headers: { "content-type": "text/event-stream" },
			});

			const requestHeaders = new Headers({
				"anthropic-version": "2023-06-01",
			});

			const result = await provider.processResponse(
				original,
				makeAccount(),
				requestHeaders,
			);

			expect(result.headers.get("content-type")).toContain("text/event-stream");
		});

		it("hop-by-hop headers are stripped from SSE response", async () => {
			const sseBody = "event: message_stop\ndata: {}\n\n";
			const original = new Response(sseBody, {
				status: 200,
				headers: {
					"content-type": "text/event-stream",
					"content-encoding": "gzip",
					"transfer-encoding": "chunked",
					"x-request-id": "req-xyz",
				},
			});

			const requestHeaders = new Headers({
				"anthropic-version": "2023-06-01",
			});

			const result = await provider.processResponse(
				original,
				makeAccount(),
				requestHeaders,
			);

			expect(result.headers.get("content-encoding")).toBeNull();
			expect(result.headers.get("transfer-encoding")).toBeNull();
			expect(result.headers.get("x-request-id")).toBe("req-xyz");
		});
	});

	// ─────────────────────────────────────────────
	// 6. buildUrl
	// ─────────────────────────────────────────────
	describe("buildUrl", () => {
		it("default endpoint: builds https://api.anthropic.com URL", () => {
			const url = provider.buildUrl("/v1/messages", "", makeAccount());
			expect(url).toBe("https://api.anthropic.com/v1/messages");
		});

		it("default endpoint with query string", () => {
			const url = provider.buildUrl("/v1/messages", "?foo=bar", makeAccount());
			expect(url).toBe("https://api.anthropic.com/v1/messages?foo=bar");
		});

		it("custom_endpoint: uses account custom endpoint", () => {
			const account = makeAccount({
				custom_endpoint: "https://my-proxy.example.com",
			});
			const url = provider.buildUrl("/v1/messages", "", account);
			expect(url).toBe("https://my-proxy.example.com/v1/messages");
		});

		it("invalid custom_endpoint: falls back to default endpoint", () => {
			const account = makeAccount({
				custom_endpoint: "not-a-valid-url",
			});
			const url = provider.buildUrl("/v1/messages", "", account);
			expect(url).toBe("https://api.anthropic.com/v1/messages");
		});

		it("no account: uses default endpoint", () => {
			const url = provider.buildUrl("/v1/messages", "");
			expect(url).toBe("https://api.anthropic.com/v1/messages");
		});
	});

	// ─────────────────────────────────────────────
	// 7. prepareHeaders
	// ─────────────────────────────────────────────
	describe("prepareHeaders", () => {
		it("sets Authorization: Bearer <accessToken> for OAuth accounts", () => {
			const incoming = new Headers({ "content-type": "application/json" });
			const result = provider.prepareHeaders(incoming, "at-bearer");

			expect(result.get("authorization")).toBe("Bearer at-bearer");
		});

		it("sets x-api-key for API key accounts (no access token)", () => {
			const incoming = new Headers({ "content-type": "application/json" });
			const result = provider.prepareHeaders(incoming, undefined, "sk-my-key");

			expect(result.get("x-api-key")).toBe("sk-my-key");
			expect(result.get("authorization")).toBeNull();
		});

		it("strips client authorization header when credentials are provided", () => {
			const incoming = new Headers({
				authorization: "Bearer client-token",
				"x-api-key": "client-api-key",
			});
			const result = provider.prepareHeaders(incoming, "server-token");

			// Client's original authorization is removed; provider sets its own
			expect(result.get("authorization")).toBe("Bearer server-token");
			// x-api-key from client is removed since we have credentials
			expect(result.get("x-api-key")).toBeNull();
		});

		it("strips host header", () => {
			const incoming = new Headers({
				host: "api.anthropic.com",
				"content-type": "application/json",
			});
			const result = provider.prepareHeaders(incoming, "at-bearer");

			expect(result.get("host")).toBeNull();
		});

		it("adds oauth-2025-04-20 to anthropic-beta header when accessToken is set", () => {
			const incoming = new Headers({ "content-type": "application/json" });
			const result = provider.prepareHeaders(incoming, "at-bearer");

			expect(result.get("anthropic-beta")).toContain("oauth-2025-04-20");
		});

		it("appends oauth-2025-04-20 to existing anthropic-beta values", () => {
			const incoming = new Headers({
				"anthropic-beta": "some-feature-flag",
			});
			const result = provider.prepareHeaders(incoming, "at-bearer");

			const betaHeader = result.get("anthropic-beta") ?? "";
			expect(betaHeader).toContain("some-feature-flag");
			expect(betaHeader).toContain("oauth-2025-04-20");
		});

		it("does not duplicate oauth-2025-04-20 if already present in anthropic-beta", () => {
			const incoming = new Headers({
				"anthropic-beta": "oauth-2025-04-20",
			});
			const result = provider.prepareHeaders(incoming, "at-bearer");

			const betaHeader = result.get("anthropic-beta") ?? "";
			// Count occurrences — should appear exactly once
			const occurrences = betaHeader.split("oauth-2025-04-20").length - 1;
			expect(occurrences).toBe(1);
		});

		it("does not set anthropic-beta when using API key (no access token)", () => {
			const incoming = new Headers({});
			const result = provider.prepareHeaders(incoming, undefined, "sk-key");

			// No oauth beta header for API key accounts
			expect(result.get("anthropic-beta")).toBeNull();
		});

		it("preserves passthrough mode when no credentials supplied", () => {
			// When both accessToken and apiKey are undefined, client's authorization is kept
			const incoming = new Headers({
				authorization: "Bearer client-provided-token",
			});
			const result = provider.prepareHeaders(incoming, undefined, undefined);

			expect(result.get("authorization")).toBe("Bearer client-provided-token");
		});
	});
});
