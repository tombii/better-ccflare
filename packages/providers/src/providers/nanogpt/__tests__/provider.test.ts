import type { Account } from "@better-ccflare/types";
import { NanoGPTProvider } from "../provider";

describe("NanoGPTProvider", () => {
	let provider: NanoGPTProvider;
	let mockAccount: Account;

	beforeEach(() => {
		provider = new NanoGPTProvider();
		mockAccount = {
			id: "test-id",
			name: "test-nanogpt-account",
			provider: "nanogpt",
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
			expect(provider.name).toBe("nanogpt");
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
		it("should use the default NanoGPT endpoint when no custom endpoint is provided", () => {
			const url = provider.buildUrl(
				"/v1/messages",
				"?stream=true",
				mockAccount,
			);
			expect(url).toBe("https://nano-gpt.com/api/v1/messages?stream=true");
		});

		it("should use custom endpoint when provided in account", () => {
			const accountWithCustomEndpoint = {
				...mockAccount,
				custom_endpoint: "https://custom.nanogpt.example.com/api",
			};
			const url = provider.buildUrl(
				"/v1/messages",
				"?model=nanogpt-pro",
				accountWithCustomEndpoint,
			);
			expect(url).toBe(
				"https://custom.nanogpt.example.com/api/v1/messages?model=nanogpt-pro",
			);
		});

		it("should handle custom endpoint with trailing slash", () => {
			const accountWithTrailingSlash = {
				...mockAccount,
				custom_endpoint: "https://custom.nanogpt.example.com/api/",
			};
			const url = provider.buildUrl(
				"/v1/messages",
				"",
				accountWithTrailingSlash,
			);
			expect(url).toBe("https://custom.nanogpt.example.com/api/v1/messages");
		});

		it("should handle empty query parameters", () => {
			const url = provider.buildUrl("/v1/messages", "", mockAccount);
			expect(url).toBe("https://nano-gpt.com/api/v1/messages");
		});

		it("should work when no account is provided", () => {
			const url = provider.buildUrl("/v1/messages", "?stream=true", undefined);
			expect(url).toBe("https://nano-gpt.com/api/v1/messages?stream=true");
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

		it("should prefer access token over API key", () => {
			const headers = new Headers({ "content-type": "application/json" });
			const preparedHeaders = provider.prepareHeaders(
				headers,
				"access-token-123",
				"api-key-456",
			);

			expect(preparedHeaders.get("x-api-key")).toBe("access-token-123");
			expect(preparedHeaders.get("authorization")).toBeNull();
		});

		it("should preserve other headers", () => {
			const headers = new Headers({
				"content-type": "application/json",
				"user-agent": "test-agent",
				accept: "application/json",
			});
			const preparedHeaders = provider.prepareHeaders(headers, "token-123");

			expect(preparedHeaders.get("x-api-key")).toBe("token-123");
			expect(preparedHeaders.get("user-agent")).toBe("test-agent");
			expect(preparedHeaders.get("accept")).toBe("application/json");
			expect(preparedHeaders.get("content-type")).toBe("application/json");
		});
	});

	describe("getEndpoint", () => {
		it("should return the configured default endpoint", () => {
			expect(provider.getEndpoint()).toBe("https://nano-gpt.com/api");
		});
	});
});
