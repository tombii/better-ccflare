import type { OpenAIRequest } from "@better-ccflare/openai-formats";
import type { Account } from "@better-ccflare/types";
import { OpenAICompatibleProvider } from "../providers/openai/provider";

describe("OpenAICompatibleProvider Alibaba Features", () => {
	let provider: OpenAICompatibleProvider;
	let mockAccount: Account;

	beforeEach(() => {
		provider = new OpenAICompatibleProvider();
		mockAccount = {
			name: "test-dashscope",
			provider: "openai-compatible",
			custom_endpoint: "https://dashscope.aliyuncs.com/compatible-mode/v1",
			refresh_token: "test-api-key",
			priority: 1,
			status: "active",
			created_at: Date.now(),
			updated_at: Date.now(),
		} as Account;
	});

	describe("Alibaba caching injection", () => {
		it("should inject cache_control for Qwen models on DashScope endpoint", async () => {
			// Build URL to set endpoint
			const _url = provider.buildUrl("/v1/messages", "", mockAccount);

			// Simulate request body
			const anthropicBody = {
				model: "qwen3.5-plus",
				system: "You are a helpful assistant",
				messages: [
					{ role: "user", content: "Hello" },
					{ role: "assistant", content: "Hi" },
				],
			};

			// Trigger beforeConvert to set model
			provider.beforeConvert(anthropicBody, mockAccount);

			// Create OpenAI request
			const openaiBody: OpenAIRequest = {
				model: "qwen3.5-plus",
				messages: [
					{ role: "system", content: "You are a helpful assistant" },
					{ role: "user", content: "Hello" },
					{ role: "assistant", content: "Hi" },
				],
			};

			// Call afterConvert to inject caching
			provider.afterConvert(openaiBody);

			// Verify system message has cache_control
			const systemMsg = openaiBody.messages[0];
			expect(systemMsg.role).toBe("system");
			if (Array.isArray(systemMsg.content)) {
				expect(systemMsg.content[0]).toHaveProperty("cache_control");
				expect((systemMsg.content[0] as any).cache_control).toEqual({
					type: "ephemeral",
				});
			}

			// Verify last message has cache_control
			const lastMsg = openaiBody.messages[openaiBody.messages.length - 1];
			if (Array.isArray(lastMsg.content)) {
				expect(lastMsg.content[0]).toHaveProperty("cache_control");
			}
		});

		it("should NOT inject cache_control for non-Qwen models", async () => {
			// Build URL to set endpoint
			const _url = provider.buildUrl("/v1/messages", "", mockAccount);

			// Simulate request body with different model
			const anthropicBody = {
				model: "glm-5.1", // Not a Qwen model
				system: "You are a helpful assistant",
				messages: [{ role: "user", content: "Hello" }],
			};

			provider.beforeConvert(anthropicBody, mockAccount);

			const openaiBody: OpenAIRequest = {
				model: "glm-5.1",
				messages: [
					{ role: "system", content: "You are a helpful assistant" },
					{ role: "user", content: "Hello" },
				],
			};

			provider.afterConvert(openaiBody);

			// Verify NO cache_control was injected
			const systemMsg = openaiBody.messages[0];
			if (typeof systemMsg.content === "string") {
				expect(systemMsg.content).toBe("You are a helpful assistant");
			} else if (Array.isArray(systemMsg.content)) {
				expect(systemMsg.content[0]).not.toHaveProperty("cache_control");
			}
		});

		it("should NOT inject cache_control for non-DashScope endpoints", async () => {
			// Use a regular OpenAI endpoint
			mockAccount.custom_endpoint = "https://api.openai.com";
			const _url = provider.buildUrl("/v1/messages", "", mockAccount);

			const anthropicBody = {
				model: "qwen3.5-plus",
				messages: [{ role: "user", content: "Hello" }],
			};

			provider.beforeConvert(anthropicBody, mockAccount);

			const openaiBody: OpenAIRequest = {
				model: "qwen3.5-plus",
				messages: [{ role: "user", content: "Hello" }],
			};

			provider.afterConvert(openaiBody);

			// Verify NO cache_control was injected (wrong endpoint)
			const userMsg = openaiBody.messages[0];
			expect(userMsg.content).toBe("Hello");
			expect(userMsg).not.toHaveProperty("cache_control");
		});
	});

	describe("enable_thinking injection", () => {
		it("should inject enable_thinking for Qwen models", async () => {
			provider.buildUrl("/v1/messages", "", mockAccount);

			const anthropicBody = {
				model: "qwen3.5-plus",
				messages: [{ role: "user", content: "Hello" }],
			};

			provider.beforeConvert(anthropicBody, mockAccount);

			const openaiBody: OpenAIRequest = {
				model: "qwen3.5-plus",
				messages: [{ role: "user", content: "Hello" }],
			};

			// Call afterConvert first (injects caching)
			provider.afterConvert(openaiBody);

			// Then call injectDashScopeReasoning (as done in transformRequestBody)
			(provider as any).injectDashScopeReasoning(openaiBody, anthropicBody);

			// enable_thinking should be injected for Qwen reasoning models
			expect((openaiBody as any).enable_thinking).toBe(true);
		});

		it("should NOT inject enable_thinking for kimi-k2-thinking", async () => {
			provider.buildUrl("/v1/messages", "", mockAccount);

			const anthropicBody = {
				model: "kimi-k2-thinking",
				messages: [{ role: "user", content: "Hello" }],
			};

			provider.beforeConvert(anthropicBody, mockAccount);

			const openaiBody: OpenAIRequest = {
				model: "kimi-k2-thinking",
				messages: [{ role: "user", content: "Hello" }],
			};

			provider.afterConvert(openaiBody);
			(provider as any).injectDashScopeReasoning(openaiBody, anthropicBody);

			expect((openaiBody as any).enable_thinking).toBeUndefined();
		});
	});
});
