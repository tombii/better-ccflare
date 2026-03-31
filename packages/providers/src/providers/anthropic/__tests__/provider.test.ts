import { beforeEach, describe, expect, it } from "bun:test";
import type { Account } from "@better-ccflare/types";
import { AnthropicProvider } from "../provider";

describe("AnthropicProvider", () => {
	let provider: AnthropicProvider;
	let mockAccount: Account;

	beforeEach(() => {
		provider = new AnthropicProvider();
		mockAccount = {
			id: "test-id",
			name: "test-anthropic-account",
			provider: "claude-oauth",
			refresh_token: "test-refresh-token",
			access_token: "test-access-token",
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

	describe("processResponse", () => {
		it("preserves body and status", async () => {
			const body = JSON.stringify({ type: "message", content: "hello" });
			const original = new Response(body, {
				status: 200,
				statusText: "OK",
				headers: { "content-type": "application/json" },
			});

			const result = await provider.processResponse(original, mockAccount);

			expect(result.status).toBe(200);
			expect(await result.text()).toBe(body);
		});

		it("strips content-encoding, content-length, and transfer-encoding headers", async () => {
			const original = new Response("body", {
				status: 200,
				headers: {
					"content-type": "application/json",
					"content-encoding": "gzip",
					"transfer-encoding": "chunked",
					"content-length": "4",
				},
			});

			const result = await provider.processResponse(original, mockAccount);

			expect(result.headers.get("content-encoding")).toBeNull();
			expect(result.headers.get("transfer-encoding")).toBeNull();
			expect(result.headers.get("content-length")).toBeNull();
		});

		it("preserves non-hop-by-hop headers", async () => {
			const original = new Response("body", {
				status: 200,
				headers: {
					"content-type": "application/json",
					"x-request-id": "abc-123",
				},
			});

			const result = await provider.processResponse(original, mockAccount);

			expect(result.headers.get("content-type")).toBe("application/json");
			expect(result.headers.get("x-request-id")).toBe("abc-123");
		});

		it("preserves non-2xx status codes", async () => {
			const original = new Response(JSON.stringify({ error: "not found" }), {
				status: 404,
				statusText: "Not Found",
				headers: { "content-type": "application/json" },
			});

			const result = await provider.processResponse(original, mockAccount);

			expect(result.status).toBe(404);
		});
	});

	describe("extractUsageInfo", () => {
		it("extracts usage from non-streaming JSON response", async () => {
			const body = JSON.stringify({
				model: "claude-opus-4-5",
				usage: {
					input_tokens: 100,
					output_tokens: 50,
					cache_creation_input_tokens: 10,
					cache_read_input_tokens: 5,
				},
			});
			const response = new Response(body, {
				headers: { "content-type": "application/json" },
			});

			const usage = await provider.extractUsageInfo(response);

			expect(usage).not.toBeNull();
			expect(usage?.model).toBe("claude-opus-4-5");
			expect(usage?.inputTokens).toBe(100);
			expect(usage?.outputTokens).toBe(50);
			expect(usage?.cacheCreationInputTokens).toBe(10);
			expect(usage?.cacheReadInputTokens).toBe(5);
			// promptTokens = input + cache_creation + cache_read
			expect(usage?.promptTokens).toBe(115);
			expect(usage?.completionTokens).toBe(50);
			expect(usage?.totalTokens).toBe(165);
		});

		it("extracts billing cost from anthropic-billing-cost header", async () => {
			const body = JSON.stringify({
				model: "claude-opus-4-5",
				usage: { input_tokens: 10, output_tokens: 5 },
			});
			const response = new Response(body, {
				headers: {
					"content-type": "application/json",
					"anthropic-billing-cost": "0.0025",
				},
			});

			const usage = await provider.extractUsageInfo(response);

			expect(usage?.costUsd).toBeCloseTo(0.0025);
		});

		it("returns null when usage field is absent in JSON response", async () => {
			const body = JSON.stringify({
				model: "claude-opus-4-5",
				type: "message",
			});
			const response = new Response(body, {
				headers: { "content-type": "application/json" },
			});

			const usage = await provider.extractUsageInfo(response);

			expect(usage).toBeNull();
		});

		it("returns null for non-JSON body", async () => {
			const response = new Response("not json at all", {
				headers: { "content-type": "application/json" },
			});

			const usage = await provider.extractUsageInfo(response);

			expect(usage).toBeNull();
		});

		it("extracts usage from streaming SSE with message_start event", async () => {
			const messageStartData = JSON.stringify({
				type: "message_start",
				message: {
					model: "claude-opus-4-5",
					usage: {
						input_tokens: 20,
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
				"event: content_block_start",
				'data: {"type":"content_block_start","index":0}',
				"",
			].join("\n");

			const response = new Response(sseBody, {
				headers: { "content-type": "text/event-stream" },
			});

			const usage = await provider.extractUsageInfo(response);

			expect(usage).not.toBeNull();
			expect(usage?.model).toBe("claude-opus-4-5");
			expect(usage?.inputTokens).toBe(20);
			expect(usage?.outputTokens).toBe(0);
			expect(usage?.promptTokens).toBe(20);
			expect(usage?.totalTokens).toBe(20);
		});

		it("returns null for streaming response without message_start", async () => {
			const sseBody = [
				"event: content_block_delta",
				'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"hello"}}',
				"",
			].join("\n");

			const response = new Response(sseBody, {
				headers: { "content-type": "text/event-stream" },
			});

			const usage = await provider.extractUsageInfo(response);

			expect(usage).toBeNull();
		});
	});
});
