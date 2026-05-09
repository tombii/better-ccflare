import { describe, expect, it } from "bun:test";
import type { Account } from "@better-ccflare/types";
import { OllamaCloudProvider } from "../ollama-cloud-provider";

describe("OllamaCloudProvider", () => {
	const provider = new OllamaCloudProvider();

	const makeAccount = (model_mappings: string | null = null): Account => ({
		id: "ollama-cloud-1",
		name: "ollama-cloud-test",
		provider: "ollama-cloud",
		api_key: null,
		refresh_token: "sk-test-token",
		access_token: null,
		expires_at: null,
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
		model_mappings,
	});

	const makeRequest = (body: Record<string, unknown>) =>
		new Request("http://localhost:8081/v1/messages", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
		});

	describe("constructor", () => {
		it("instantiates without errors", () => {
			expect(() => new OllamaCloudProvider()).not.toThrow();
		});
	});

	describe("name", () => {
		it('should be "ollama-cloud"', () => {
			expect(provider.name).toBe("ollama-cloud");
		});
	});

	describe("getEndpoint", () => {
		it("returns the Ollama Cloud endpoint", () => {
			expect(provider.getEndpoint()).toBe("https://ollama.com");
		});
	});

	describe("getAuthHeader", () => {
		it("returns authorization", () => {
			expect(provider.getAuthHeader()).toBe("authorization");
		});
	});

	describe("getAuthType", () => {
		it("returns bearer", () => {
			expect(provider.getAuthType()).toBe("bearer");
		});
	});

	describe("canHandle", () => {
		it("returns true for any path", () => {
			expect(provider.canHandle("/v1/messages")).toBe(true);
			expect(provider.canHandle("/api/tags")).toBe(true);
			expect(provider.canHandle("/anything")).toBe(true);
		});
	});

	describe("buildUrl", () => {
		it("passes through /api/tags", () => {
			const url = provider.buildUrl("/api/tags", "");
			expect(url).toBe("https://ollama.com/api/tags");
		});

		it("passes through /api/show", () => {
			const url = provider.buildUrl("/api/show", "");
			expect(url).toBe("https://ollama.com/api/show");
		});

		it("passes through /api/tags with query string", () => {
			const url = provider.buildUrl("/api/tags", "?foo=bar");
			expect(url).toBe("https://ollama.com/api/tags?foo=bar");
		});

		it("routes /v1/messages to /api/chat", () => {
			const url = provider.buildUrl("/v1/messages", "");
			expect(url).toBe("https://ollama.com/api/chat");
		});

		it("routes /v1/messages preserving query string", () => {
			const url = provider.buildUrl("/v1/messages", "?stream=true");
			expect(url).toBe("https://ollama.com/api/chat?stream=true");
		});

		it("routes any other path to /api/chat", () => {
			const url = provider.buildUrl("/v1/models", "");
			expect(url).toBe("https://ollama.com/api/chat");
		});

		it("routes unknown paths to /api/chat with query string", () => {
			const url = provider.buildUrl("/some/unknown/path", "?a=1");
			expect(url).toBe("https://ollama.com/api/chat?a=1");
		});
	});

	describe("transformRequestBody", () => {
		it("maps model name via model_mappings", async () => {
			const account = makeAccount(
				JSON.stringify({ "claude-sonnet-4-5": "llama3.1" }),
			);
			const request = makeRequest({
				model: "claude-sonnet-4-5",
				messages: [{ role: "user", content: "hi" }],
				stream: true,
			});

			const transformed = await provider.transformRequestBody(request, account);
			const body = await transformed.json();

			expect(body.model).toBe("llama3.1");
			expect(body.messages).toBeDefined();
			expect(body.messages).toHaveLength(1);
			expect(body.messages[0].role).toBe("user");
			expect(body.messages[0].content).toBe("hi");
		});

		it("passes through model unchanged without model_mappings", async () => {
			const account = makeAccount(null);
			const request = makeRequest({
				model: "llama3.1",
				messages: [{ role: "user", content: "hi" }],
				stream: false,
			});

			const transformed = await provider.transformRequestBody(request, account);
			const body = await transformed.json();

			expect(body.model).toBe("llama3.1");
		});

		it("converts Anthropic format to Ollama native format", async () => {
			const account = makeAccount();
			const request = makeRequest({
				model: "gemma3",
				system: "You are helpful",
				messages: [
					{ role: "user", content: "What is 2+2?" },
					{ role: "assistant", content: "4" },
					{ role: "user", content: "Thanks" },
				],
				max_tokens: 100,
				temperature: 0.7,
				stream: true,
			});

			const transformed = await provider.transformRequestBody(request, account);
			const body = await transformed.json();

			expect(body.model).toBe("gemma3");
			expect(body.stream).toBe(true);
			expect(body.options?.temperature).toBe(0.7);
			expect(body.options?.num_predict).toBe(100);
			// System prompt becomes first message with role "system"
			expect(body.messages[0].role).toBe("system");
			expect(body.messages[0].content).toBe("You are helpful");
			expect(body.messages[1].role).toBe("user");
			expect(body.messages[2].role).toBe("assistant");
			expect(body.messages[3].role).toBe("user");
		});

		it("returns a Request with POST method and JSON content type", async () => {
			const account = makeAccount();
			const request = makeRequest({
				model: "test",
				messages: [{ role: "user", content: "hi" }],
			});

			const transformed = await provider.transformRequestBody(request, account);

			expect(transformed.method).toBe("POST");
			expect(transformed.headers.get("content-type")).toBe("application/json");
		});

		it("preserves query string from original request URL", async () => {
			const account = makeAccount();
			const request = new Request(
				"http://localhost:8081/v1/messages?stream=true",
				{
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						model: "test",
						messages: [{ role: "user", content: "hi" }],
					}),
				},
			);

			const transformed = await provider.transformRequestBody(request, account);

			expect(transformed.url).toContain("?stream=true");
		});
	});

	describe("prepareHeaders", () => {
		it("sets Bearer token with authorization header", () => {
			const headers = new Headers({
				"x-api-key": "old-key",
				"anthropic-version": "2023-06-01",
				host: "localhost:8081",
				"accept-encoding": "gzip",
			});

			const result = provider.prepareHeaders(headers, "sk-ollama-token");

			expect(result.get("Authorization")).toBe("Bearer sk-ollama-token");
			expect(result.has("x-api-key")).toBe(false);
			expect(result.has("anthropic-version")).toBe(false);
			expect(result.has("host")).toBe(false);
			expect(result.has("accept-encoding")).toBe(false);
		});

		it("removes existing authorization header before setting new one", () => {
			const headers = new Headers({
				authorization: "Bearer old-token",
			});

			const result = provider.prepareHeaders(headers, "sk-new-token");

			expect(result.get("Authorization")).toBe("Bearer sk-new-token");
		});

		it("handles empty token gracefully", () => {
			const headers = new Headers({
				"x-api-key": "some-key",
			});

			const result = provider.prepareHeaders(headers, "");

			// Empty token is falsy, so the if(token) block doesn't run
			// x-api-key is preserved but host/accept-encoding are still stripped
			expect(result.has("x-api-key")).toBe(true);
			expect(result.has("Authorization")).toBe(false);
			expect(result.has("host")).toBe(false);
			expect(result.has("accept-encoding")).toBe(false);
		});

		it("uses apiKey when accessToken is not provided", () => {
			const headers = new Headers();

			const result = provider.prepareHeaders(headers, undefined, "sk-api-key");

			expect(result.get("Authorization")).toBe("Bearer sk-api-key");
		});

		it("prefers accessToken over apiKey", () => {
			const headers = new Headers();

			const result = provider.prepareHeaders(headers, "sk-access", "sk-api");

			expect(result.get("Authorization")).toBe("Bearer sk-access");
		});

		it("strips host and accept-encoding even without credentials", () => {
			const headers = new Headers({
				host: "localhost:8081",
				"accept-encoding": "gzip, deflate",
			});

			const result = provider.prepareHeaders(headers);

			expect(result.has("host")).toBe(false);
			expect(result.has("accept-encoding")).toBe(false);
		});
	});

	describe("processResponse", () => {
		describe("streaming (NDJSON)", () => {
			it("converts NDJSON to text/event-stream content type", async () => {
				const ndjson = `${JSON.stringify({
					model: "gemma3",
					message: { role: "assistant", content: "Hello" },
					done: false,
				})}\n`;

				const response = new Response(new Blob([ndjson]), {
					headers: { "Content-Type": "application/x-ndjson" },
				});

				const result = await provider.processResponse(response);

				expect(result.headers.get("Content-Type")).toBe("text/event-stream");
				expect(result.headers.get("Cache-Control")).toBe("no-cache");
				expect(result.headers.get("Connection")).toBe("keep-alive");
			});

			it("converts text/plain to text/event-stream content type", async () => {
				const ndjson = `${JSON.stringify({
					model: "gemma3",
					message: { role: "assistant", content: "Hello" },
					done: false,
				})}\n`;

				const response = new Response(new Blob([ndjson]), {
					headers: { "Content-Type": "text/plain" },
				});

				const result = await provider.processResponse(response);

				expect(result.headers.get("Content-Type")).toBe("text/event-stream");
			});

			it("converts text content chunk to SSE content_block_delta", async () => {
				const ndjson = `${JSON.stringify({
					model: "gemma3",
					message: { role: "assistant", content: "Hello world" },
					done: false,
				})}\n`;

				const response = new Response(new Blob([ndjson]), {
					headers: { "Content-Type": "application/x-ndjson" },
				});

				const result = await provider.processResponse(response);
				const text = await result.text();

				expect(text).toContain("event: content_block_delta");
				expect(text).toContain("text_delta");
				expect(text).toContain("Hello world");
			});

			it("converts done chunk to message_delta + message_stop", async () => {
				const ndjson = `${JSON.stringify({
					model: "gemma3",
					message: { role: "assistant", content: "" },
					done: true,
					done_reason: "stop",
				})}\n`;

				const response = new Response(new Blob([ndjson]), {
					headers: { "Content-Type": "application/x-ndjson" },
				});

				const result = await provider.processResponse(response);
				const text = await result.text();

				expect(text).toContain("event: message_delta");
				expect(text).toContain("event: message_stop");
				expect(text).toContain("stop");
			});

			it("skips empty content non-done chunks", async () => {
				const ndjson = `${JSON.stringify({
					model: "gemma3",
					message: { role: "assistant", content: "" },
					done: false,
				})}\n`;

				const response = new Response(new Blob([ndjson]), {
					headers: { "Content-Type": "application/x-ndjson" },
				});

				const result = await provider.processResponse(response);
				const text = await result.text();

				expect(text).toBe("");
			});

			it("handles multiple NDJSON lines in one chunk", async () => {
				const ndjson = `${[
					JSON.stringify({
						model: "gemma3",
						message: { role: "assistant", content: "Hello" },
						done: false,
					}),
					JSON.stringify({
						model: "gemma3",
						message: { role: "assistant", content: " world" },
						done: false,
					}),
					JSON.stringify({
						model: "gemma3",
						message: { role: "assistant", content: "" },
						done: true,
						done_reason: "stop",
					}),
				].join("\n")}\n`;

				const response = new Response(new Blob([ndjson]), {
					headers: { "Content-Type": "application/x-ndjson" },
				});

				const result = await provider.processResponse(response);
				const text = await result.text();

				expect(text).toContain("Hello");
				expect(text).toContain(" world");
				expect(text).toContain("message_stop");
			});

			it("skips malformed JSON lines", async () => {
				const ndjson = `not valid json\n${JSON.stringify({
					model: "gemma3",
					message: { role: "assistant", content: "OK" },
					done: false,
				})}\n`;

				const response = new Response(new Blob([ndjson]), {
					headers: { "Content-Type": "application/x-ndjson" },
				});

				const result = await provider.processResponse(response);
				const text = await result.text();

				expect(text).toContain("OK");
			});

			it("preserves response status and statusText", async () => {
				const ndjson = `${JSON.stringify({
					model: "gemma3",
					message: { role: "assistant", content: "test" },
					done: false,
				})}\n`;

				const response = new Response(new Blob([ndjson]), {
					status: 200,
					statusText: "OK",
					headers: { "Content-Type": "application/x-ndjson" },
				});

				const result = await provider.processResponse(response);

				expect(result.status).toBe(200);
				expect(result.statusText).toBe("OK");
			});
		});

		describe("non-streaming (JSON)", () => {
			it("converts JSON response to Anthropic format", async () => {
				const json = {
					model: "gemma3",
					message: { role: "assistant", content: "Hello world" },
					done: true,
				};

				const response = new Response(new Blob([JSON.stringify(json)]), {
					headers: { "Content-Type": "application/json" },
				});

				const result = await provider.processResponse(response);
				const body = await result.json();

				expect(body.type).toBe("message");
				expect(body.role).toBe("assistant");
				expect(body.model).toBe("gemma3");
				expect(body.content).toHaveLength(1);
				expect(body.content?.[0]).toEqual({
					type: "text",
					text: "Hello world",
				});
				expect(body.stop_reason).toBe("end_turn");
			});

			it("sets application/json content type", async () => {
				const json = {
					model: "llama3",
					message: { role: "assistant", content: "test" },
					done: true,
				};

				const response = new Response(new Blob([JSON.stringify(json)]), {
					headers: { "Content-Type": "application/json" },
				});

				const result = await provider.processResponse(response);

				expect(result.headers.get("Content-Type")).toBe("application/json");
			});
		});

		describe("malformed responses", () => {
			it("passes through non-JSON response unchanged", async () => {
				const response = new Response(new Blob(["plain text response"]), {
					headers: { "Content-Type": "text/html" },
					status: 500,
				});

				const result = await provider.processResponse(response);

				expect(result.status).toBe(500);
				// Not NDJSON or JSON, so should pass through
				expect(result.headers.get("Content-Type")).toBe("text/html");
			});

			it("returns original response when JSON parsing fails", async () => {
				const response = new Response(new Blob(["{invalid json"]), {
					headers: { "Content-Type": "application/json" },
				});

				const result = await provider.processResponse(response);

				expect(result.status).toBe(200);
			});
		});
	});
});
