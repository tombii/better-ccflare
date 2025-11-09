import type { Account } from "@better-ccflare/types";
import { OpenAICompatibleProvider } from "../provider";

describe("OpenAICompatibleProvider", () => {
	let provider: OpenAICompatibleProvider;
	let mockAccount: Account;

	beforeEach(() => {
		provider = new OpenAICompatibleProvider();
		mockAccount = {
			id: "test-id",
			name: "test-account",
			provider: "openai-compatible",
			refresh_token: "test-api-key",
			access_token: null,
			expires_at: null,
			api_key: null,
			custom_endpoint: JSON.stringify({
				endpoint: "https://api.openrouter.ai/api/v1",
			}),
			rate_limited_until: null,
			rate_limit_status: null,
			rate_limit_reset: null,
			rate_limit_remaining: null,
			created_at: Date.now(),
			last_used: null,
			request_count: 0,
			total_requests: 0,
			session_start: null,
			session_request_count: 0,
			paused: false,
			priority: 0,
			auto_fallback_enabled: false,
			auto_refresh_enabled: false,
		};
	});

	describe("name", () => {
		it("should have the correct provider name", () => {
			expect(provider.name).toBe("openai-compatible");
		});
	});

	describe("canHandle", () => {
		it("should handle all paths", () => {
			expect(provider.canHandle("/v1/messages")).toBe(true);
			expect(provider.canHandle("/v1/chat/completions")).toBe(true);
			expect(provider.canHandle("/any/path")).toBe(true);
		});
	});

	describe("buildUrl", () => {
		it("should use custom endpoint when provided", () => {
			const url = provider.buildUrl("/v1/messages", "", mockAccount);
			expect(url).toBe("https://api.openrouter.ai/api/v1/chat/completions");
		});

		it("should use default endpoint when no custom endpoint", () => {
			const accountWithoutEndpoint = {
				...mockAccount,
				custom_endpoint: undefined,
			};
			const url = provider.buildUrl("/v1/messages", "", accountWithoutEndpoint);
			expect(url).toBe("https://api.openai.com/v1/chat/completions");
		});

		it("should convert Anthropic path to OpenAI path", () => {
			const url = provider.buildUrl(
				"/v1/messages",
				"?stream=true",
				mockAccount,
			);
			expect(url).toBe(
				"https://api.openrouter.ai/api/v1/chat/completions?stream=true",
			);
		});

		it("should handle trailing slashes in endpoint", () => {
			const accountWithTrailingSlash = {
				...mockAccount,
				custom_endpoint: "https://api.example.com/",
			};
			const url = provider.buildUrl(
				"/v1/messages",
				"",
				accountWithTrailingSlash,
			);
			expect(url).toBe("https://api.example.com/v1/chat/completions");
		});

		it("should fall back to default when JSON endpoint is missing", () => {
			const accountWithMappingsOnly = {
				...mockAccount,
				custom_endpoint: JSON.stringify({
					modelMappings: { opus: "custom-model" },
				}),
			};
			const url = provider.buildUrl(
				"/v1/messages",
				"",
				accountWithMappingsOnly,
			);
			expect(url).toBe("https://api.openai.com/v1/chat/completions");
		});
	});

	describe("prepareHeaders", () => {
		it("should set Authorization header with API key", () => {
			const headers = new Headers({
				"content-type": "application/json",
				"anthropic-version": "2023-06-01",
			});

			const prepared = provider.prepareHeaders(
				headers,
				undefined,
				"test-api-key",
			);

			expect(prepared.get("authorization")).toBe("Bearer test-api-key");
			expect(prepared.get("anthropic-version")).toBeNull();
			expect(prepared.get("host")).toBeNull();
			expect(prepared.get("content-type")).toBe("application/json");
		});

		it("should set Authorization header with access token", () => {
			const headers = new Headers();
			const prepared = provider.prepareHeaders(headers, "access-token");

			expect(prepared.get("authorization")).toBe("Bearer access-token");
		});

		it("should prefer API key over access token", () => {
			const headers = new Headers();
			const prepared = provider.prepareHeaders(
				headers,
				"access-token",
				"api-key",
			);

			expect(prepared.get("authorization")).toBe("Bearer api-key");
		});

		it("SECURITY: should sanitize client authorization header to prevent credential leakage", () => {
			const headers = new Headers();
			headers.set("authorization", "Bearer client-secret-token");

			const prepared = provider.prepareHeaders(
				headers,
				undefined,
				"server-api-key",
			);

			// Client's authorization should be replaced with server's
			expect(prepared.get("authorization")).toBe("Bearer server-api-key");
			expect(prepared.get("authorization")).not.toBe(
				"Bearer client-secret-token",
			);
		});

		it("SECURITY: should handle case-insensitive authorization header deletion", () => {
			const headers = new Headers();
			headers.set("Authorization", "Bearer client-secret-token"); // Capital A

			const prepared = provider.prepareHeaders(
				headers,
				undefined,
				"server-api-key",
			);

			// Should remove client's header regardless of casing and set server's
			expect(prepared.get("authorization")).toBe("Bearer server-api-key");
			expect(prepared.get("Authorization")).toBe("Bearer server-api-key");
			expect(prepared.get("authorization")).not.toBe(
				"Bearer client-secret-token",
			);
		});

		it("SECURITY: should preserve client authorization in passthrough mode (no credentials)", () => {
			const headers = new Headers();
			headers.set("authorization", "Bearer client-own-key");

			// Call without providing any credentials (passthrough mode)
			const prepared = provider.prepareHeaders(headers, undefined, undefined);

			// Client's authorization should be preserved for direct API access
			expect(prepared.get("authorization")).toBe("Bearer client-own-key");
		});

		it("SECURITY: should sanitize client auth even with empty string credentials", () => {
			const headers = new Headers();
			headers.set("authorization", "Bearer client-secret-token");

			// Empty string is still a defined value (not undefined)
			const prepared = provider.prepareHeaders(headers, "", undefined);

			// Client's authorization should be removed even with empty accessToken
			expect(prepared.get("authorization")).toBeNull();
		});

		it("SECURITY: should sanitize client auth with empty string apiKey", () => {
			const headers = new Headers();
			headers.set("authorization", "Bearer client-secret-token");

			// Empty string apiKey should still trigger sanitization
			const prepared = provider.prepareHeaders(headers, undefined, "");

			// Client's authorization should be removed
			expect(prepared.get("authorization")).toBeNull();
		});
	});

	describe("parseRateLimit", () => {
		it("should parse OpenAI rate limit headers", () => {
			const headers = new Headers({
				"x-ratelimit-reset-requests": "1640995200",
				"x-ratelimit-remaining-requests": "100",
				"x-ratelimit-limit-requests": "1000",
			});

			const response = new Response(null, {
				status: 200,
				headers,
			});

			const rateLimit = provider.parseRateLimit(response);

			expect(rateLimit.isRateLimited).toBe(false);
			expect(rateLimit.resetTime).toBe(1640995200000);
			expect(rateLimit.remaining).toBe(100);
			expect(rateLimit.statusHeader).toBe("allowed");
		});

		it("should not rate limit OpenAI-compatible providers even when remaining is 0", () => {
			const headers = new Headers({
				"x-ratelimit-remaining-requests": "0",
			});

			const response = new Response(null, {
				status: 200,
				headers,
			});

			const rateLimit = provider.parseRateLimit(response);

			expect(rateLimit.isRateLimited).toBe(false);
		});

		it("should not rate limit OpenAI-compatible providers even with 429 status", () => {
			const headers = new Headers({
				"retry-after": "60",
			});

			const response = new Response(null, {
				status: 429,
				headers,
			});

			const rateLimit = provider.parseRateLimit(response);

			// OpenAI-compatible providers should never be marked as rate-limited by our load balancer
			// They handle their own rate limiting and return errors inline
			expect(rateLimit.isRateLimited).toBe(false);
		});

		it("should not rate limit normal responses", () => {
			const response = new Response(null, { status: 200 });
			const rateLimit = provider.parseRateLimit(response);

			expect(rateLimit.isRateLimited).toBe(false);
		});
	});

	describe("refreshToken", () => {
		it("should return existing API key for API key providers", async () => {
			const result = await provider.refreshToken(mockAccount, "client-id");

			expect(result.accessToken).toBe("test-api-key");
			expect(result.refreshToken).toBe("");
			expect(result.expiresAt).toBeGreaterThan(Date.now());
		});

		it("should throw error when no API key is available", async () => {
			const accountWithoutKey = { ...mockAccount, refresh_token: null };

			await expect(
				provider.refreshToken(accountWithoutKey, "client-id"),
			).rejects.toThrow("No API key available");
		});
	});

	describe("supportsOAuth", () => {
		it("should not support OAuth", () => {
			expect(provider.supportsOAuth()).toBe(false);
		});
	});

	// Integration-style tests for format conversion
	describe("format conversion", () => {
		it("should preserve authorization header during transformation", async () => {
			const anthropicRequest = {
				model: "claude-3-haiku-20241022",
				messages: [{ role: "user", content: "Hello" }],
			};

			const request = new Request("https://example.com/v1/messages", {
				method: "POST",
				headers: {
					"content-type": "application/json",
					Authorization: "Bearer test-api-key",
				},
				body: JSON.stringify(anthropicRequest),
			});

			const transformed = await provider.transformRequestBody(
				request,
				mockAccount,
			);

			expect(transformed.headers.get("authorization")).toBe(
				"Bearer test-api-key",
			);
		});

		it("should convert Anthropic request to OpenAI format with model mapping", async () => {
			const anthropicRequest = {
				model: "claude-3-5-haiku-20241022",
				max_tokens: 1000,
				messages: [{ role: "user", content: "Hello, world!" }],
				system: "You are a helpful assistant",
				temperature: 0.7,
				stop_sequences: ["END"],
			};

			const request = new Request("https://example.com/v1/messages", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(anthropicRequest),
			});

			const transformed = await provider.transformRequestBody(
				request,
				mockAccount,
			);
			const body = await transformed.json();

			expect(body.model).toBe("openai/gpt-5-mini"); // Haiku maps to gpt-5-mini
			expect(body.max_tokens).toBe(1000);
			expect(body.temperature).toBe(0.7);
			expect(body.stop).toEqual(["END"]);
			expect(body.messages).toHaveLength(2);
			expect(body.messages[0]).toEqual({
				role: "system",
				content: "You are a helpful assistant",
			});
			expect(body.messages[1]).toEqual({
				role: "user",
				content: "Hello, world!",
			});
		});

		it("should map opus models to openai/gpt-5", async () => {
			const anthropicRequest = {
				model: "claude-3-opus-20240229",
				max_tokens: 1000,
				messages: [{ role: "user", content: "Hello" }],
			};

			const request = new Request("https://example.com/v1/messages", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(anthropicRequest),
			});

			const transformed = await provider.transformRequestBody(
				request,
				mockAccount,
			);
			const body = await transformed.json();

			expect(body.model).toBe("openai/gpt-5");
		});

		it("should map sonnet models to openai/gpt-5", async () => {
			const anthropicRequest = {
				model: "claude-3-5-sonnet-20241022",
				max_tokens: 1000,
				messages: [{ role: "user", content: "Hello" }],
			};

			const request = new Request("https://example.com/v1/messages", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(anthropicRequest),
			});

			const transformed = await provider.transformRequestBody(
				request,
				mockAccount,
			);
			const body = await transformed.json();

			expect(body.model).toBe("openai/gpt-5");
		});

		it("should map haiku models to openai/gpt-5-mini", async () => {
			const anthropicRequest = {
				model: "claude-3-haiku-20240307",
				max_tokens: 1000,
				messages: [{ role: "user", content: "Hello" }],
			};

			const request = new Request("https://example.com/v1/messages", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(anthropicRequest),
			});

			const transformed = await provider.transformRequestBody(
				request,
				mockAccount,
			);
			const body = await transformed.json();

			expect(body.model).toBe("openai/gpt-5-mini");
		});

		it("should handle unknown models with fallback mapping", async () => {
			const anthropicRequest = {
				model: "unknown-model-name",
				max_tokens: 1000,
				messages: [{ role: "user", content: "Hello" }],
			};

			const request = new Request("https://example.com/v1/messages", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(anthropicRequest),
			});

			const transformed = await provider.transformRequestBody(
				request,
				mockAccount,
			);
			const body = await transformed.json();

			expect(body.model).toBe("openai/gpt-5"); // Default fallback
		});

		it("should handle content arrays in Anthropic format", async () => {
			const anthropicRequest = {
				model: "claude-3-sonnet-20240229",
				max_tokens: 1000,
				messages: [
					{
						role: "user",
						content: [
							{ type: "text", text: "Hello" },
							{
								type: "image",
								source: {
									type: "base64",
									media_type: "image/png",
									data: "...",
								},
							},
							{ type: "text", text: "world!" },
						],
					},
				],
			};

			const request = new Request("https://example.com/v1/messages", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(anthropicRequest),
			});

			const transformed = await provider.transformRequestBody(request);
			const body = await transformed.json();

			expect(body.messages[0].content).toBe("Helloworld!");
		});

		it("should apply custom model mappings from JSON endpoint configuration", async () => {
			const accountWithMappings = {
				...mockAccount,
				custom_endpoint: JSON.stringify({
					endpoint: "https://api.customprovider.com/v1",
					modelMappings: {
						haiku: "custom/haiku-model",
					},
				}),
			};

			const anthropicRequest = {
				model: "claude-3-haiku-20240307",
				messages: [{ role: "user", content: "Hello" }],
			};

			const request = new Request("https://example.com/v1/messages", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(anthropicRequest),
			});

			const transformed = await provider.transformRequestBody(
				request,
				accountWithMappings,
			);
			const body = await transformed.json();

			expect(body.model).toBe("custom/haiku-model");
		});
	});
});
