import type { Account } from "@better-ccflare/types";
import { KiloProvider } from "../provider";

describe("KiloProvider", () => {
	let provider: KiloProvider;
	let mockAccount: Account;

	beforeEach(() => {
		provider = new KiloProvider();
		mockAccount = {
			id: "test-id",
			name: "test-kilo-account",
			provider: "kilo",
			refresh_token: "test-api-key",
			access_token: null,
			expires_at: null,
			api_key: "test-api-key",
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
			expect(provider.name).toBe("kilo");
		});
	});

	describe("buildUrl", () => {
		it("should route /v1/messages to /chat/completions on kilo gateway", () => {
			const url = provider.buildUrl("/v1/messages", "", mockAccount);
			expect(url).toBe("https://api.kilo.ai/api/gateway/chat/completions");
		});

		it("should include query string", () => {
			const url = provider.buildUrl(
				"/v1/messages",
				"?stream=true",
				mockAccount,
			);
			expect(url).toBe(
				"https://api.kilo.ai/api/gateway/chat/completions?stream=true",
			);
		});

		it("should strip /v1 prefix from other paths", () => {
			const url = provider.buildUrl("/v1/models", "", mockAccount);
			expect(url).toBe("https://api.kilo.ai/api/gateway/models");
		});

		it("should use custom endpoint when provided", () => {
			const accountWithCustomEndpoint = {
				...mockAccount,
				custom_endpoint: "https://custom.kilo.example.com/gateway",
			};
			const url = provider.buildUrl(
				"/v1/messages",
				"",
				accountWithCustomEndpoint,
			);
			expect(url).toBe(
				"https://custom.kilo.example.com/gateway/chat/completions",
			);
		});

		it("should strip trailing slash from custom endpoint", () => {
			const accountWithCustomEndpoint = {
				...mockAccount,
				custom_endpoint: "https://custom.kilo.example.com/gateway/",
			};
			const url = provider.buildUrl(
				"/v1/messages",
				"",
				accountWithCustomEndpoint,
			);
			expect(url).toBe(
				"https://custom.kilo.example.com/gateway/chat/completions",
			);
		});
	});
});
