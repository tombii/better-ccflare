import { describe, expect, it } from "bun:test";
import type { Account } from "@better-ccflare/types";
import { OllamaProvider } from "../provider";

describe("OllamaProvider", () => {
	const provider = new OllamaProvider();

	const makeAccount = (
		custom_endpoint: string | null,
		api_key: string | null = "sk-test-key",
	): Account => ({
		id: "ollama-1",
		name: "ollama-test",
		provider: "ollama",
		api_key,
		refresh_token: "",
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
		custom_endpoint,
	});

	describe("constructor", () => {
		it("instantiates without errors", () => {
			expect(() => new OllamaProvider()).not.toThrow();
		});
	});

	describe("name", () => {
		it('should be "ollama"', () => {
			expect(provider.name).toBe("ollama");
		});
	});

	describe("getEndpoint", () => {
		it("returns the default Ollama endpoint", () => {
			expect(provider.getEndpoint()).toBe("http://localhost:11434");
		});
	});

	describe("buildUrl", () => {
		it("uses default endpoint when account is missing", () => {
			const url = provider.buildUrl("/v1/messages", "?stream=true");
			expect(url).toBe("http://localhost:11434/v1/messages?stream=true");
		});

		it("uses account.custom_endpoint when present", () => {
			const account = makeAccount("http://127.0.0.1:11434");
			const url = provider.buildUrl("/v1/models", "", account);
			expect(url).toBe("http://127.0.0.1:11434/v1/models");
		});

		it("trims trailing slash from custom endpoint", () => {
			const account = makeAccount("http://127.0.0.1:11434/");
			const url = provider.buildUrl("/v1/models", "", account);
			expect(url).toBe("http://127.0.0.1:11434/v1/models");
		});

		it("deduplicates overlapping base path prefix", () => {
			const account = makeAccount("http://localhost:11434/v1");
			const url = provider.buildUrl("/v1/messages", "", account);
			expect(url).toBe("http://localhost:11434/v1/messages");
		});

		it("appends query string", () => {
			const account = makeAccount("http://localhost:11434");
			const url = provider.buildUrl("/v1/messages", "?foo=bar&n=1", account);
			expect(url).toBe("http://localhost:11434/v1/messages?foo=bar&n=1");
		});

		describe("Ollama Cloud routing", () => {
			it("routes to /api/chat for Ollama Cloud", () => {
				const account = makeAccount("https://ollama.com");
				const url = provider.buildUrl("/v1/messages", "", account);
				expect(url).toBe("https://ollama.com/api/chat");
			});

			it("routes to /api/chat for any path on cloud", () => {
				const account = makeAccount("https://ollama.com");
				const url = provider.buildUrl("/v1/chat/completions", "", account);
				expect(url).toBe("https://ollama.com/api/chat");
			});

			it("preserves /api/tags for cloud model listing", () => {
				const account = makeAccount("https://ollama.com");
				const url = provider.buildUrl("/api/tags", "", account);
				expect(url).toBe("https://ollama.com/api/tags");
			});

			it("preserves /api/show for cloud", () => {
				const account = makeAccount("https://ollama.com");
				const url = provider.buildUrl("/api/show", "", account);
				expect(url).toBe("https://ollama.com/api/show");
			});

			it("preserves query string on cloud", () => {
				const account = makeAccount("https://ollama.com");
				const url = provider.buildUrl("/v1/messages", "?stream=true", account);
				expect(url).toBe("https://ollama.com/api/chat?stream=true");
			});

			it("handles trailing slash on cloud endpoint", () => {
				const account = makeAccount("https://ollama.com/");
				const url = provider.buildUrl("/v1/messages", "", account);
				expect(url).toBe("https://ollama.com/api/chat");
			});
		});
	});

	describe("prepareHeaders", () => {
		it("adds Bearer auth for cloud endpoint", () => {
			const headers = provider.prepareHeaders(new Headers(), "test-token");
			expect(headers.get("Authorization")).toBe("Bearer test-token");
			expect(headers.get("x-api-key")).toBeNull();
		});

		it("removes host and encoding headers", () => {
			const headers = new Headers();
			headers.set("host", "example.com");
			headers.set("accept-encoding", "gzip");
			const result = provider.prepareHeaders(headers, "test-token");
			expect(result.get("host")).toBeNull();
			expect(result.get("accept-encoding")).toBeNull();
		});
	});
});
