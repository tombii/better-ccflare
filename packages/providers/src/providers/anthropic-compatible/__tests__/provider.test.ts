import { BaseProvider } from "../../../base";
import {
	type AnthropicCompatibleConfig,
	AnthropicCompatibleProvider,
	createAnthropicCompatibleProvider,
	createProviderForService,
	PresetProviders,
} from "../factory";

describe("AnthropicCompatibleProvider", () => {
	describe("Basic Configuration", () => {
		test("should create provider with default config", () => {
			const provider = new AnthropicCompatibleProvider();

			expect(provider.name).toBe("anthropic-compatible");
			expect(provider.canHandle("/v1/messages")).toBe(true);
			expect(provider.supportsOAuth()).toBe(false);
		});

		test("should create provider with custom config", () => {
			const config: AnthropicCompatibleConfig = {
				name: "custom-provider",
				baseUrl: "https://custom.api.com",
				authHeader: "authorization",
				authType: "direct",
				supportsStreaming: false,
				defaultModel: "custom-model",
			};

			const provider = new AnthropicCompatibleProvider(config);

			expect(provider.name).toBe("custom-provider");
			expect(provider.supportsOAuth()).toBe(false);
			expect(provider.getConfig()).toEqual(config);
		});

		test("should update configuration dynamically", () => {
			const provider = new AnthropicCompatibleProvider();

			provider.updateConfig({
				name: "updated-provider",
				baseUrl: "https://updated.api.com",
			});

			expect(provider.name).toBe("updated-provider");
			expect(provider.getConfig().baseUrl).toBe("https://updated.api.com");
		});
	});

	describe("Authentication Methods", () => {
		test("should handle API key authentication", async () => {
			const provider = new AnthropicCompatibleProvider();

			const mockAccount: Partial<Account> = {
				name: "test-account",
				refresh_token: "test-api-key",
			};

			const result = await provider.refreshToken(mockAccount, "test-client");

			expect(result.accessToken).toBe("test-api-key");
			expect(result.refreshToken).toBe("");
		});

		test("should throw error when no API key available", async () => {
			const provider = new AnthropicCompatibleProvider();

			const mockAccount: Partial<Account> = {
				name: "test-account",
				refresh_token: "",
			};

			await expect(
				provider.refreshToken(mockAccount, "test-client"),
			).rejects.toThrow("No API key available for account test-account");
		});

		test("should not support OAuth", () => {
			const provider = new AnthropicCompatibleProvider();

			expect(provider.supportsOAuth()).toBe(false);
		});
	});

	describe("URL Building", () => {
		test("should build URLs correctly with custom base URL", () => {
			const config: AnthropicCompatibleConfig = {
				baseUrl: "https://custom.api.com/v1",
			};

			const provider = new AnthropicCompatibleProvider(config);

			const url = provider.buildUrl("/messages", "?test=value");
			expect(url).toBe("https://custom.api.com/v1/messages?test=value");
		});

		test("should handle base URL without trailing slash", () => {
			const config: AnthropicCompatibleConfig = {
				baseUrl: "https://custom.api.com/",
			};

			const provider = new AnthropicCompatibleProvider(config);

			const url = provider.buildUrl("/messages", "?test=value");
			expect(url).toBe("https://custom.api.com/messages?test=value");
		});
	});

	describe("Header Preparation", () => {
		test("should set custom auth header for API key", () => {
			const config: AnthropicCompatibleConfig = {
				authHeader: "x-api-key",
			};

			const provider = new AnthropicCompatibleProvider(config);

			const headers = new Headers();
			const result = provider.prepareHeaders(headers, "test-api-key");

			expect(result.get("x-api-key")).toBe("test-api-key");
			expect(result.has("authorization")).toBe(false);
		});

		test("should set authorization header when specified", () => {
			const config: AnthropicCompatibleConfig = {
				authHeader: "authorization",
			};

			const provider = new AnthropicCompatibleProvider(config);

			const headers = new Headers();
			const result = provider.prepareHeaders(headers, "test-token");

			expect(result.get("authorization")).toBe("test-token");
		});

		test("should remove host and compression headers", () => {
			const provider = new AnthropicCompatibleProvider();

			const headers = new Headers();
			headers.set("host", "example.com");
			headers.set("accept-encoding", "gzip");
			headers.set("content-encoding", "gzip");

			const result = provider.prepareHeaders(headers, "test-token");

			expect(result.has("host")).toBe(false);
			expect(result.has("accept-encoding")).toBe(false);
			expect(result.has("content-encoding")).toBe(false);
		});

		test("SECURITY: should sanitize client authorization header to prevent credential leakage", () => {
			const provider = new AnthropicCompatibleProvider();

			const headers = new Headers();
			headers.set("authorization", "Bearer client-secret-token");

			const result = provider.prepareHeaders(headers, "test-api-key");

			// Client's authorization header should be removed
			expect(result.get("authorization")).toBeNull();
			// Our x-api-key should be set instead
			expect(result.get("x-api-key")).toBe("test-api-key");
		});

		test("SECURITY: should sanitize client authorization even when using authorization header", () => {
			const config: AnthropicCompatibleConfig = {
				authHeader: "authorization",
				authType: "bearer",
			};

			const provider = new AnthropicCompatibleProvider(config);

			const headers = new Headers();
			headers.set("authorization", "Bearer client-secret-token");

			const result = provider.prepareHeaders(headers, "server-token");

			// Client's authorization should be replaced with server's
			expect(result.get("authorization")).toBe("Bearer server-token");
			expect(result.get("authorization")).not.toBe(
				"Bearer client-secret-token",
			);
		});

		test("SECURITY: should handle case-insensitive authorization header deletion", () => {
			const provider = new AnthropicCompatibleProvider();

			const headers = new Headers();
			headers.set("Authorization", "Bearer client-secret-token"); // Capital A

			const result = provider.prepareHeaders(headers, "test-api-key");

			// Should remove regardless of casing
			expect(result.get("authorization")).toBeNull();
			expect(result.get("Authorization")).toBeNull();
			expect(result.get("AUTHORIZATION")).toBeNull();
			expect(result.get("x-api-key")).toBe("test-api-key");
		});

		test("SECURITY: should preserve client authorization in passthrough mode (no credentials)", () => {
			const provider = new AnthropicCompatibleProvider();

			const headers = new Headers();
			headers.set("authorization", "Bearer client-own-key");

			// Call without providing any credentials (passthrough mode)
			const result = provider.prepareHeaders(headers, undefined, undefined);

			// Client's authorization should be preserved for direct API access
			expect(result.get("authorization")).toBe("Bearer client-own-key");
		});

		test("SECURITY: should sanitize client auth even with empty string credentials", () => {
			const provider = new AnthropicCompatibleProvider();

			const headers = new Headers();
			headers.set("authorization", "Bearer client-secret-token");

			// Empty string is still a defined value (not undefined)
			const result = provider.prepareHeaders(headers, "", undefined);

			// Client's authorization should be removed even with empty accessToken
			expect(result.get("authorization")).toBeNull();
			expect(result.get("x-api-key")).toBeNull();
		});

		test("SECURITY: should sanitize client auth with empty string apiKey", () => {
			const provider = new AnthropicCompatibleProvider();

			const headers = new Headers();
			headers.set("authorization", "Bearer client-secret-token");

			// Empty string apiKey should still trigger sanitization
			const result = provider.prepareHeaders(headers, undefined, "");

			// Client's authorization should be removed
			expect(result.get("authorization")).toBeNull();
		});
	});

	describe("Model Mapping", () => {
		test("should transform request body with model mapping", async () => {
			const config: AnthropicCompatibleConfig = {
				modelMappings: {
					"claude-3-sonnet": "custom-model-v1",
					"claude-3-haiku": "custom-model-v2",
				},
			};

			const provider = new AnthropicCompatibleProvider(config);

			const mockRequest = new Request("http://example.com", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					model: "claude-3-sonnet",
					messages: [{ role: "user", content: "Hello" }],
				}),
			});

			const transformedRequest =
				await provider.transformRequestBody(mockRequest);
			const body = await transformedRequest.json();

			expect(body.model).toBe("custom-model-v1");
		});

		test("should not transform request when model not in mapping", async () => {
			const config: AnthropicCompatibleConfig = {
				modelMappings: {
					"claude-3-sonnet": "custom-model-v1",
				},
			};

			const provider = new AnthropicCompatibleProvider(config);

			const mockRequest = new Request("http://example.com", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					model: "claude-3-opus",
					messages: [{ role: "user", content: "Hello" }],
				}),
			});

			const transformedRequest =
				await provider.transformRequestBody(mockRequest);
			const body = await transformedRequest.json();

			expect(body.model).toBe("claude-3-opus");
		});

		test("should not transform non-JSON requests", async () => {
			const config: AnthropicCompatibleConfig = {
				modelMappings: {
					"claude-3-sonnet": "custom-model-v1",
				},
			};

			const provider = new AnthropicCompatibleProvider(config);

			const mockRequest = new Request("http://example.com", {
				method: "POST",
				headers: { "Content-Type": "text/plain" },
				body: "plain text",
			});

			const transformedRequest =
				await provider.transformRequestBody(mockRequest);

			expect(transformedRequest).toBe(mockRequest);
		});
	});

	describe("Rate Limit Parsing", () => {
		test("should parse unified rate limit headers", () => {
			const provider = new AnthropicCompatibleProvider();

			const mockResponse = new Response("{}", {
				headers: {
					"anthropic-ratelimit-unified-status": "rate_limited",
					"anthropic-ratelimit-unified-reset": "1609459200",
					"anthropic-ratelimit-unified-remaining": "0",
				},
			});

			const rateLimitInfo = provider.parseRateLimit(mockResponse);

			expect(rateLimitInfo.isRateLimited).toBe(true);
			expect(rateLimitInfo.resetTime).toBe(1609459200000);
			expect(rateLimitInfo.statusHeader).toBe("rate_limited");
			expect(rateLimitInfo.remaining).toBe(0);
		});

		test("should handle 429 status without headers", () => {
			const provider = new AnthropicCompatibleProvider();

			const mockResponse = new Response("{}", { status: 429 });

			const rateLimitInfo = provider.parseRateLimit(mockResponse);

			expect(rateLimitInfo.isRateLimited).toBe(true);
		});

		test("should handle non-rate-limited responses", () => {
			const provider = new AnthropicCompatibleProvider();

			const mockResponse = new Response("{}", { status: 200 });

			const rateLimitInfo = provider.parseRateLimit(mockResponse);

			expect(rateLimitInfo.isRateLimited).toBe(false);
		});
	});

	describe("Streaming Detection", () => {
		test("should detect streaming responses when enabled", () => {
			const config: AnthropicCompatibleConfig = {
				supportsStreaming: true,
			};

			const provider = new AnthropicCompatibleProvider(config);

			const streamingResponse = new Response("{}", {
				headers: { "content-type": "text/event-stream" },
			});

			expect(provider.isStreamingResponse(streamingResponse)).toBe(true);
		});

		test("should not detect streaming when disabled", () => {
			const config: AnthropicCompatibleConfig = {
				supportsStreaming: false,
			};

			const provider = new AnthropicCompatibleProvider(config);

			const streamingResponse = new Response("{}", {
				headers: { "content-type": "text/event-stream" },
			});

			expect(provider.isStreamingResponse(streamingResponse)).toBe(false);
		});
	});

	describe("Factory Functions", () => {
		test("should create provider with factory function", () => {
			const config: AnthropicCompatibleConfig = {
				name: "factory-provider",
				baseUrl: "https://factory.api.com",
			};

			const provider = createAnthropicCompatibleProvider(config);

			expect(provider.name).toBe("factory-provider");
			expect(provider.getConfig().baseUrl).toBe("https://factory.api.com");
		});

		test("should create provider for service", () => {
			const provider = createProviderForService(
				"test-service",
				"https://test.api.com",
				"x-test-key",
			);

			expect(provider.name).toBe("anthropic-test-service");
			expect(provider.getConfig().baseUrl).toBe("https://test.api.com");
			expect(provider.getConfig().authHeader).toBe("x-test-key");
		});

		test("should create preset providers", () => {
			const zaiProvider = PresetProviders.createZaiCompatible();
			const minimaxProvider = PresetProviders.createMinimaxCompatible();

			expect(zaiProvider.name).toBe("anthropic-zai");
			expect(minimaxProvider.name).toBe("anthropic-minimax");
		});

		test("should create provider with model mapping", () => {
			const mappings = {
				"claude-3-sonnet": "custom-model",
			};

			const provider = PresetProviders.createWithModelMapping(
				"https://custom.api.com",
				mappings,
				"authorization",
			);

			expect(provider.getConfig().modelMappings).toEqual(mappings);
			expect(provider.getConfig().authHeader).toBe("authorization");
		});
	});

	describe("Usage Information Extraction", () => {
		test("should extract usage info from JSON response", async () => {
			const provider = new AnthropicCompatibleProvider();

			const mockResponse = new Response(
				JSON.stringify({
					model: "custom-model",
					usage: {
						input_tokens: 100,
						output_tokens: 200,
						cache_read_input_tokens: 50,
					},
				}),
				{
					headers: { "content-type": "application/json" },
				},
			);

			const usageInfo = await provider.extractUsageInfo(mockResponse);

			expect(usageInfo?.model).toBe("custom-model");
			expect(usageInfo?.inputTokens).toBe(100);
			expect(usageInfo?.outputTokens).toBe(200);
			expect(usageInfo?.cacheReadInputTokens).toBe(50);
			expect(usageInfo?.promptTokens).toBe(150); // 100 + 50
			expect(usageInfo?.completionTokens).toBe(200);
			expect(usageInfo?.totalTokens).toBe(350); // 150 + 200
		});

		test("should return null for responses without usage", async () => {
			const provider = new AnthropicCompatibleProvider();

			const mockResponse = new Response(
				JSON.stringify({
					model: "custom-model",
				}),
				{
					headers: { "content-type": "application/json" },
				},
			);

			const usageInfo = await provider.extractUsageInfo(mockResponse);

			expect(usageInfo).toBeNull();
		});

		test("should handle invalid JSON", async () => {
			const provider = new AnthropicCompatibleProvider();

			const mockResponse = new Response("invalid json", {
				headers: { "content-type": "application/json" },
			});

			const usageInfo = await provider.extractUsageInfo(mockResponse);

			expect(usageInfo).toBeNull();
		});
	});

	describe("Edge Cases", () => {
		test("should handle empty model mapping object", async () => {
			const config: AnthropicCompatibleConfig = {
				modelMappings: {},
			};

			const provider = new AnthropicCompatibleProvider(config);

			const mockRequest = new Request("http://example.com", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					model: "claude-3-sonnet",
					messages: [{ role: "user", content: "Hello" }],
				}),
			});

			const transformedRequest =
				await provider.transformRequestBody(mockRequest);
			const body = await transformedRequest.json();

			expect(body.model).toBe("claude-3-sonnet"); // Should remain unchanged
		});

		test("should handle null/undefined configuration values", () => {
			const provider = new AnthropicCompatibleProvider({
				name: undefined,
				baseUrl: undefined,
			});

			expect(provider.name).toBe("anthropic-compatible"); // Default name
		});
	});
});

describe("Type Safety", () => {
	test("should have correct TypeScript types", () => {
		const config: AnthropicCompatibleConfig = {
			name: "test-provider",
			baseUrl: "https://test.api.com",
			authHeader: "authorization",
			modelMappings: {
				"model-a": "mapped-model-a",
			},
			supportsStreaming: true,
			defaultModel: "default-model",
		};

		// This should compile without TypeScript errors
		const provider = new AnthropicCompatibleProvider(config);
		expect(provider).toBeInstanceOf(BaseProvider);
	});
});
