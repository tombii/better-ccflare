import type { Account } from "@better-ccflare/types";
import { DeepseekProvider } from "../provider";

describe("DeepseekProvider", () => {
	let provider: DeepseekProvider;
	let mockAccount: Account;

	beforeEach(() => {
		provider = new DeepseekProvider();
		mockAccount = {
			id: "test-id",
			name: "test-deepseek-account",
			provider: "deepseek",
			refresh_token: "test-api-key",
			access_token: null,
			expires_at: null,
			api_key: null,
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
			expect(provider.name).toBe("deepseek");
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
		it("should always use the fixed Deepseek endpoint", () => {
			const url = provider.buildUrl(
				"/v1/messages",
				"?stream=true",
				mockAccount,
			);
			expect(url).toBe(
				"https://api.deepseek.com/anthropic/v1/messages?stream=true",
			);
		});

		it("should ignore custom endpoint in account (fixed endpoint)", () => {
			const accountWithCustomEndpoint = {
				...mockAccount,
				custom_endpoint: "https://custom.deepseek.example.com",
			};
			const url = provider.buildUrl(
				"/v1/messages",
				"",
				accountWithCustomEndpoint,
			);
			// Should still use the fixed endpoint, ignoring the custom one
			expect(url).toBe("https://api.deepseek.com/anthropic/v1/messages");
		});

		it("should handle empty query parameters", () => {
			const url = provider.buildUrl("/v1/messages", "", mockAccount);
			expect(url).toBe("https://api.deepseek.com/anthropic/v1/messages");
		});
	});

	describe("prepareHeaders", () => {
		it("should use x-api-key header when access token provided", () => {
			const headers = new Headers({ "content-type": "application/json" });
			const preparedHeaders = provider.prepareHeaders(
				headers,
				"access-token-123",
			);

			expect(preparedHeaders.get("x-api-key")).toBe("access-token-123");
			expect(preparedHeaders.get("authorization")).toBeNull(); // Should be removed
			expect(preparedHeaders.get("content-type")).toBe("application/json");
		});

		it("should use x-api-key header when API key provided", () => {
			const headers = new Headers({ "content-type": "application/json" });
			const preparedHeaders = provider.prepareHeaders(
				headers,
				undefined,
				"api-key-456",
			);

			expect(preparedHeaders.get("x-api-key")).toBe("api-key-456");
			expect(preparedHeaders.get("authorization")).toBeNull(); // Should be removed
			expect(preparedHeaders.get("content-type")).toBe("application/json");
		});

		it("should prefer access token over API key when both are provided", () => {
			const headers = new Headers({ "content-type": "application/json" });
			const preparedHeaders = provider.prepareHeaders(
				headers,
				"access-token-123",
				"api-key-456",
			);

			expect(preparedHeaders.get("x-api-key")).toBe("access-token-123");
			expect(preparedHeaders.get("authorization")).toBeNull(); // Should be removed
		});

		it("should remove hop-by-hop headers and set x-api-key", () => {
			const headers = new Headers({
				authorization: "Bearer old-token", // Should be removed
				"x-api-key": "old-key", // Should be replaced
				host: "api.deepseek.com",
				"accept-encoding": "gzip, deflate",
				"content-encoding": "gzip",
				"user-agent": "test-agent",
			});

			const preparedHeaders = provider.prepareHeaders(headers, "new-token");

			expect(preparedHeaders.get("x-api-key")).toBe("new-token");
			expect(preparedHeaders.get("authorization")).toBeNull(); // Should be removed
			expect(preparedHeaders.get("host")).toBeNull();
			expect(preparedHeaders.get("accept-encoding")).toBeNull();
			expect(preparedHeaders.get("content-encoding")).toBeNull();
			expect(preparedHeaders.get("user-agent")).toBe("test-agent");
		});

		it("should handle empty headers with x-api-key", () => {
			const headers = new Headers();
			const preparedHeaders = provider.prepareHeaders(headers, "test-token");

			expect(preparedHeaders.get("x-api-key")).toBe("test-token");
			expect(preparedHeaders.get("authorization")).toBeNull();
		});
	});

	describe("refreshToken", () => {
		it("should return API key as access token for API key based authentication", async () => {
			const result = await provider.refreshToken(mockAccount, "test-client-id");

			expect(result.accessToken).toBe("test-api-key");
			expect(result.refreshToken).toBe("");
			expect(result.expiresAt).toBeGreaterThan(Date.now());
		});

		it("should throw error when no API key is available", async () => {
			const accountWithoutApiKey = {
				...mockAccount,
				refresh_token: null,
			};

			await expect(
				provider.refreshToken(accountWithoutApiKey, "test-client-id"),
			).rejects.toThrow(
				"No API key available for account test-deepseek-account",
			);
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
					connection: "keep-alive", // This should remain
					"content-encoding": "gzip", // This should be removed
					"transfer-encoding": "chunked", // This should be removed
					"content-length": "123", // This should be removed
				},
			});

			const processedResponse = await provider.processResponse(
				originalResponse,
				mockAccount,
			);

			expect(processedResponse.status).toBe(200);
			expect(processedResponse.statusText).toBe("OK");
			expect(processedResponse.headers.get("content-type")).toBe(
				"application/json",
			);
			expect(processedResponse.headers.get("connection")).toBe("keep-alive"); // Should remain
			expect(processedResponse.headers.get("content-encoding")).toBeNull(); // Should be removed
			expect(processedResponse.headers.get("transfer-encoding")).toBeNull(); // Should be removed
			expect(processedResponse.headers.get("content-length")).toBeNull(); // Should be removed
		});
	});

	describe("transformRequest", () => {
		it("should leave the model unchanged by default (DeepSeek server-side remaps automatically)", async () => {
			// No model_mappings configured — DeepSeek's own Anthropic-compatible
			// endpoint auto-remaps claude-opus*->deepseek-v4-pro and
			// claude-haiku*/claude-sonnet*->deepseek-v4-flash server-side, so
			// better-ccflare must NOT rewrite the model name in this default case.
			const accountWithoutMapping: Account = {
				...mockAccount,
				model_mappings: null,
			};

			const testModels = [
				"claude-opus-5-20260101",
				"claude-sonnet-4-5-20250929",
				"claude-haiku-4-5-20251001",
			];

			for (const input of testModels) {
				const requestBody = {
					model: input,
					messages: [{ role: "user", content: "test" }],
				};

				const request = new Request("http://test.com", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify(requestBody),
				});

				const transformedRequest = await provider.transformRequestBody(
					request,
					accountWithoutMapping,
				);

				const transformedBody = await transformedRequest.json();
				expect(transformedBody.model).toBe(input);
			}
		});

		it("should still apply custom model_mappings when an operator sets them", async () => {
			// Custom mappings are unnecessary by default (DeepSeek remaps
			// server-side), but the shared mapModelName code path still honors
			// them if an operator configures an override on the account.
			const accountWithMapping: Account = {
				...mockAccount,
				model_mappings: JSON.stringify({
					sonnet: "deepseek-v4-flash",
					opus: "deepseek-v4-pro",
					haiku: "deepseek-v4-flash",
				}),
			};

			const testModels = [
				{ input: "claude-sonnet-4-5-20250929", expected: "deepseek-v4-flash" },
				{ input: "claude-haiku-4-5-20251001", expected: "deepseek-v4-flash" },
				{ input: "claude-opus-4-1-20250805", expected: "deepseek-v4-pro" },
			];

			for (const { input, expected } of testModels) {
				const requestBody = {
					model: input,
					messages: [{ role: "user", content: "test" }],
				};

				const request = new Request("http://test.com", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify(requestBody),
				});

				const transformedRequest = await provider.transformRequestBody(
					request,
					accountWithMapping,
				);

				const transformedBody = await transformedRequest.json();
				expect(transformedBody.model).toBe(expected);
			}
		});
	});

	describe("extractUsageInfo", () => {
		it("should extract usage from non-streaming JSON response", async () => {
			const mockUsageData = {
				model: "deepseek-v4-flash",
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
				model: "deepseek-v4-flash",
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
			const response = new Response(
				JSON.stringify({ model: "deepseek-v4-flash" }),
				{
					headers: { "content-type": "application/json" },
				},
			);

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
