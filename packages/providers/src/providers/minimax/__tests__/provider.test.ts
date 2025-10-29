import type { Account } from "@better-ccflare/types";
import { MinimaxProvider } from "../provider";

describe("MinimaxProvider", () => {
	let provider: MinimaxProvider;
	let mockAccount: Account;

	beforeEach(() => {
		provider = new MinimaxProvider();
		mockAccount = {
			id: "test-id",
			name: "test-minimax-account",
			provider: "minimax",
			refresh_token: "test-api-key",
			access_token: null,
			expires_at: null,
			api_key: null,
			account_tier: 5,
			custom_endpoint: null,
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
			expect(provider.name).toBe("minimax");
		});
	});

	describe("canHandle", () => {
		it("should handle all paths", () => {
			expect(provider.canHandle("/v1/messages")).toBe(true);
			expect(provider.canHandle("/v1/complete")).toBe(true);
			expect(provider.canHandle("/any/path")).toBe(true);
		});
	});

	describe("buildUrl", () => {
		it("should use default endpoint when no custom endpoint is provided", () => {
			const url = provider.buildUrl("/v1/messages", "?stream=true", mockAccount);
			expect(url).toBe("https://api.minimax.io/anthropic/v1/messages?stream=true");
		});

		it("should use custom endpoint when provided", () => {
			const accountWithCustomEndpoint = {
				...mockAccount,
				custom_endpoint: "https://custom.minimax.example.com",
			};
			const url = provider.buildUrl("/v1/messages", "", accountWithCustomEndpoint);
			expect(url).toBe("https://custom.minimax.example.com/v1/messages");
		});

		it("should handle trailing slashes in custom endpoint", () => {
			const accountWithTrailingSlash = {
				...mockAccount,
				custom_endpoint: "https://custom.minimax.example.com/",
			};
			const url = provider.buildUrl("/v1/messages", "?stream=true", accountWithTrailingSlash);
			expect(url).toBe("https://custom.minimax.example.com/v1/messages?stream=true");
		});

		it("should handle empty query parameters", () => {
			const url = provider.buildUrl("/v1/messages", "", mockAccount);
			expect(url).toBe("https://api.minimax.io/anthropic/v1/messages");
		});
	});

	describe("prepareHeaders", () => {
		it("should use access token when provided", () => {
			const headers = new Headers({ "content-type": "application/json" });
			const preparedHeaders = provider.prepareHeaders(headers, "access-token-123");

			expect(preparedHeaders.get("authorization")).toBe("Bearer access-token-123");
			expect(preparedHeaders.get("content-type")).toBe("application/json");
		});

		it("should use API key when provided", () => {
			const headers = new Headers({ "content-type": "application/json" });
			const preparedHeaders = provider.prepareHeaders(headers, undefined, "api-key-456");

			expect(preparedHeaders.get("authorization")).toBe("Bearer api-key-456");
			expect(preparedHeaders.get("content-type")).toBe("application/json");
		});

		it("should prefer access token over API key when both are provided", () => {
			const headers = new Headers({ "content-type": "application/json" });
			const preparedHeaders = provider.prepareHeaders(headers, "access-token-123", "api-key-456");

			expect(preparedHeaders.get("authorization")).toBe("Bearer access-token-123");
		});

		it("should remove hop-by-hop headers", () => {
			const headers = new Headers({
				"authorization": "Bearer old-token",
				"host": "api.minimax.io",
				"accept-encoding": "gzip, deflate",
				"content-encoding": "gzip",
				"user-agent": "test-agent",
			});

			const preparedHeaders = provider.prepareHeaders(headers, "new-token");

			expect(preparedHeaders.get("authorization")).toBe("Bearer new-token");
			expect(preparedHeaders.get("host")).toBeNull();
			expect(preparedHeaders.get("accept-encoding")).toBeNull();
			expect(preparedHeaders.get("content-encoding")).toBeNull();
			expect(preparedHeaders.get("user-agent")).toBe("test-agent");
		});

		it("should handle empty headers", () => {
			const headers = new Headers();
			const preparedHeaders = provider.prepareHeaders(headers, "test-token");

			expect(preparedHeaders.get("authorization")).toBe("Bearer test-token");
		});
	});

	describe("refreshToken", () => {
		it("should return API key as access token for API key based authentication", async () => {
			const result = await provider.refreshToken(mockAccount, "test-client-id");

			expect(result.accessToken).toBe("test-api-key");
			expect(result.refreshToken).toBe("test-api-key");
			expect(result.expiresAt).toBeGreaterThan(Date.now());
		});

		it("should throw error when no API key is available", async () => {
			const accountWithoutApiKey = {
				...mockAccount,
				refresh_token: null,
			};

			await expect(provider.refreshToken(accountWithoutApiKey, "test-client-id"))
				.rejects.toThrow("No API key available for account test-minimax-account");
		});
	});

	describe("supportsOAuth", () => {
		it("should not support OAuth", () => {
			expect(provider.supportsOAuth()).toBe(false);
		});
	});

	describe("isStreamingResponse", () => {
		it("should identify streaming responses", () => {
			const streamingResponse = new Response(null, {
				headers: { "content-type": "text/event-stream" },
			});

			expect(provider.isStreamingResponse(streamingResponse)).toBe(true);
		});

		it("should identify non-streaming responses", () => {
			const jsonResponse = new Response(null, {
				headers: { "content-type": "application/json" },
			});

			expect(provider.isStreamingResponse(jsonResponse)).toBe(false);
		});

		it("should handle response without content-type header", () => {
			const response = new Response(null);

			expect(provider.isStreamingResponse(response)).toBe(false);
		});
	});

	describe("extractTierInfo", () => {
		it("should return null for tier info", async () => {
			const response = new Response();
			const tierInfo = await provider.extractTierInfo(response);

			expect(tierInfo).toBeNull();
		});
	});

	describe("processResponse", () => {
		it("should sanitize response headers", async () => {
			const originalResponse = new Response("test body", {
				status: 200,
				statusText: "OK",
				headers: {
					"content-type": "application/json",
					"connection": "keep-alive", // This should remain
					"content-encoding": "gzip", // This should be removed
					"transfer-encoding": "chunked", // This should be removed
					"content-length": "123", // This should be removed
				},
			});

			const processedResponse = await provider.processResponse(originalResponse, mockAccount);

			expect(processedResponse.status).toBe(200);
			expect(processedResponse.statusText).toBe("OK");
			expect(processedResponse.headers.get("content-type")).toBe("application/json");
			expect(processedResponse.headers.get("connection")).toBe("keep-alive"); // Should remain
			expect(processedResponse.headers.get("content-encoding")).toBeNull(); // Should be removed
			expect(processedResponse.headers.get("transfer-encoding")).toBeNull(); // Should be removed
			expect(processedResponse.headers.get("content-length")).toBeNull(); // Should be removed
		});
	});

	describe("extractUsageInfo", () => {
		it("should extract usage from non-streaming JSON response", async () => {
			const mockUsageData = {
				model: "MiniMax-M2",
				usage: {
					input_tokens: 100,
					output_tokens: 50,
					cache_creation_input_tokens: 10,
					cache_read_input_tokens: 5,
				},
			};

			const response = new Response(JSON.stringify(mockUsageData), {
				headers: { "content-type": "application/json" },
			});

			const usage = await provider.extractUsageInfo(response);

			expect(usage).toEqual({
				model: "MiniMax-M2",
				promptTokens: 115, // 100 + 10 + 5
				completionTokens: 50,
				totalTokens: 165,
				inputTokens: 100,
				cacheReadInputTokens: 5,
				cacheCreationInputTokens: 10,
				outputTokens: 50,
				costUsd: expect.any(Number),
			});
		});

		it("should return null for response without usage info", async () => {
			const response = new Response(JSON.stringify({ model: "MiniMax-M2" }), {
				headers: { "content-type": "application/json" },
			});

			const usage = await provider.extractUsageInfo(response);
			expect(usage).toBeNull();
		});

		it("should handle non-JSON responses gracefully", async () => {
			const response = new Response("invalid json", {
				headers: { "content-type": "text/plain" },
			});

			const usage = await provider.extractUsageInfo(response);
			expect(usage).toBeNull();
		});
	});
});