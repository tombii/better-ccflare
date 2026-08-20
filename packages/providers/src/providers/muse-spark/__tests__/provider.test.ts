import type { Account } from "@better-ccflare/types";
import {
	isMuseSparkMessagesPath,
	isMuseSparkModel,
	MUSE_SPARK_DEFAULT_MODEL,
	MuseSparkProvider,
} from "../provider";

function makeAccount(overrides: Partial<Account> = {}): Account {
	return {
		id: "test-id",
		name: "test-muse-spark-account",
		provider: "muse-spark",
		refresh_token: "",
		access_token: null,
		expires_at: null,
		api_key: "LLM|123|secret",
		custom_endpoint: null,
		rate_limited_until: null,
		rate_limited_reason: null,
		rate_limited_at: null,
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
		requires_reauth: false,
		priority: 0,
		auto_fallback_enabled: false,
		auto_refresh_enabled: false,
		auto_pause_on_overage_enabled: false,
		peak_hours_pause_enabled: false,
		model_mappings: null,
		cross_region_mode: null,
		model_fallbacks: null,
		billing_type: null,
		pause_reason: null,
		refresh_token_issued_at: null,
		consecutive_rate_limits: 0,
		...overrides,
	} as Account;
}

async function bodyOf(request: Request): Promise<Record<string, unknown>> {
	return (await request.json()) as Record<string, unknown>;
}

function jsonRequest(body: unknown): Request {
	return new Request("https://proxy.local/v1/messages", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
}

describe("MuseSparkProvider", () => {
	let provider: MuseSparkProvider;
	let account: Account;

	beforeEach(() => {
		provider = new MuseSparkProvider();
		account = makeAccount();
	});

	describe("name", () => {
		it("should have the correct provider name", () => {
			expect(provider.name).toBe("muse-spark");
		});
	});

	describe("getEndpoint", () => {
		it("returns the Meta Model API base", () => {
			expect(provider.getEndpoint()).toBe("https://api.meta.ai");
		});
	});

	describe("buildUrl", () => {
		it("targets the Messages endpoint by default", () => {
			expect(provider.buildUrl("/v1/messages", "", account)).toBe(
				"https://api.meta.ai/v1/messages",
			);
		});

		it("preserves the query string", () => {
			expect(provider.buildUrl("/v1/messages", "?beta=true", account)).toBe(
				"https://api.meta.ai/v1/messages?beta=true",
			);
		});

		it("supports the count_tokens endpoint", () => {
			expect(provider.buildUrl("/v1/messages/count_tokens", "", account)).toBe(
				"https://api.meta.ai/v1/messages/count_tokens",
			);
		});

		it("honours a custom endpoint", () => {
			const custom = makeAccount({
				custom_endpoint: "https://gateway.example.com",
			});
			expect(provider.buildUrl("/v1/messages", "", custom)).toBe(
				"https://gateway.example.com/v1/messages",
			);
		});

		it("strips a trailing slash on a custom endpoint", () => {
			const custom = makeAccount({
				custom_endpoint: "https://gateway.example.com/",
			});
			expect(provider.buildUrl("/v1/messages", "", custom)).toBe(
				"https://gateway.example.com/v1/messages",
			);
		});

		it("does not double up when the base already ends in /v1", () => {
			const custom = makeAccount({
				custom_endpoint: "https://api.meta.ai/v1",
			});
			expect(provider.buildUrl("/v1/messages", "", custom)).toBe(
				"https://api.meta.ai/v1/messages",
			);
		});

		it("collapses /v1 overlap behind a gateway path prefix", () => {
			const custom = makeAccount({
				custom_endpoint: "https://gateway.example/proxy/v1",
			});
			expect(provider.buildUrl("/v1/messages", "", custom)).toBe(
				"https://gateway.example/proxy/v1/messages",
			);
			expect(provider.buildUrl("/v1/messages/count_tokens", "", custom)).toBe(
				"https://gateway.example/proxy/v1/messages/count_tokens",
			);
		});

		it("keeps a gateway prefix that does not overlap the request path", () => {
			const custom = makeAccount({
				custom_endpoint: "https://gateway.example/proxy",
			});
			expect(provider.buildUrl("/v1/messages", "", custom)).toBe(
				"https://gateway.example/proxy/v1/messages",
			);
		});

		// A query on the base must stay a query: string concatenation would bury
		// the route inside it and leave the path at /proxy.
		it("preserves a query string on a custom endpoint", () => {
			const custom = makeAccount({
				custom_endpoint: "https://gateway.example/proxy?api-version=2024",
			});
			const url = new URL(provider.buildUrl("/v1/messages", "", custom));
			expect(url.pathname).toBe("/proxy/v1/messages");
			expect(url.searchParams.get("api-version")).toBe("2024");
		});

		it("merges base and request query parameters", () => {
			const custom = makeAccount({
				custom_endpoint: "https://gateway.example/proxy?api-version=2024",
			});
			const url = new URL(
				provider.buildUrl("/v1/messages", "?beta=true", custom),
			);
			expect(url.pathname).toBe("/proxy/v1/messages");
			expect(url.searchParams.get("api-version")).toBe("2024");
			expect(url.searchParams.get("beta")).toBe("true");
		});

		it("drops a fragment, which is never sent upstream", () => {
			const custom = makeAccount({
				custom_endpoint: "https://gateway.example/proxy#section",
			});
			expect(provider.buildUrl("/v1/messages", "", custom)).toBe(
				"https://gateway.example/proxy/v1/messages",
			);
		});

		it("falls back to the default when no account is given", () => {
			expect(provider.buildUrl("/v1/messages", "")).toBe(
				"https://api.meta.ai/v1/messages",
			);
		});
	});

	describe("prepareHeaders", () => {
		it("sends the key as a bearer token, not x-api-key", () => {
			const headers = provider.prepareHeaders(
				new Headers(),
				undefined,
				"LLM|123|secret",
			);
			expect(headers.get("Authorization")).toBe("Bearer LLM|123|secret");
			expect(headers.get("x-api-key")).toBeNull();
		});

		it("replaces a client-supplied credential", () => {
			const incoming = new Headers({
				authorization: "Bearer client-token",
				"x-api-key": "client-key",
			});
			const headers = provider.prepareHeaders(
				incoming,
				undefined,
				"LLM|123|secret",
			);
			expect(headers.get("Authorization")).toBe("Bearer LLM|123|secret");
			expect(headers.get("x-api-key")).toBeNull();
		});

		it("strips hop-by-hop and compression headers", () => {
			const incoming = new Headers({
				host: "proxy.local",
				"accept-encoding": "gzip",
			});
			const headers = provider.prepareHeaders(incoming, "token");
			expect(headers.get("host")).toBeNull();
			expect(headers.get("accept-encoding")).toBeNull();
		});

		it("strips content-length, which sanitization invalidates", () => {
			const incoming = new Headers({ "content-length": "1234" });
			const headers = provider.prepareHeaders(incoming, "token");
			expect(headers.get("content-length")).toBeNull();
		});
	});

	describe("resolveModel", () => {
		it("routes a Claude model to the default Muse Spark checkpoint", () => {
			expect(provider.resolveModel("claude-opus-4-6-20260115", account)).toBe(
				MUSE_SPARK_DEFAULT_MODEL,
			);
			expect(provider.resolveModel("claude-haiku-4-5-20251001", account)).toBe(
				MUSE_SPARK_DEFAULT_MODEL,
			);
		});

		it("passes an explicit Muse Spark model through", () => {
			expect(provider.resolveModel("muse-spark-1.1", account)).toBe(
				"muse-spark-1.1",
			);
			expect(provider.resolveModel("muse-spark-1.2-contributor", account)).toBe(
				"muse-spark-1.2-contributor",
			);
		});

		it("lets an explicit account mapping win", () => {
			const mapped = makeAccount({
				model_mappings: JSON.stringify({ opus: "muse-spark-1.1" }),
			});
			expect(provider.resolveModel("claude-opus-4-6-20260115", mapped)).toBe(
				"muse-spark-1.1",
			);
		});

		it("routes an unknown model to the default rather than forwarding it", () => {
			expect(provider.resolveModel("gpt-4o", account)).toBe(
				MUSE_SPARK_DEFAULT_MODEL,
			);
		});
	});

	describe("transformRequestBody", () => {
		it("maps the model and strips fields Meta rejects", async () => {
			const request = jsonRequest({
				model: "claude-opus-4-6-20260115",
				max_tokens: 4096,
				messages: [{ role: "user", content: "hi" }],
				stop_sequences: ["\n"],
				top_k: 40,
			});

			const body = await bodyOf(
				await provider.transformRequestBody(request, account),
			);

			expect(body.model).toBe(MUSE_SPARK_DEFAULT_MODEL);
			expect(body).not.toHaveProperty("stop_sequences");
			expect(body).not.toHaveProperty("top_k");
			expect(body.messages).toEqual([{ role: "user", content: "hi" }]);
		});

		it("drops thinking:disabled, which would be a 400", async () => {
			const request = jsonRequest({
				model: "muse-spark-1.2",
				max_tokens: 4096,
				messages: [{ role: "user", content: "hi" }],
				thinking: { type: "disabled" },
			});

			const body = await bodyOf(
				await provider.transformRequestBody(request, account),
			);
			expect(body).not.toHaveProperty("thinking");
		});

		it("leaves a non-JSON body untouched", async () => {
			const request = new Request("https://proxy.local/v1/messages", {
				method: "POST",
				headers: { "content-type": "text/plain" },
				body: "raw",
			});
			const result = await provider.transformRequestBody(request, account);
			expect(await result.text()).toBe("raw");
		});

		it("forwards an unparseable JSON body rather than dropping it", async () => {
			const request = new Request("https://proxy.local/v1/messages", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: "{not json",
			});
			const result = await provider.transformRequestBody(request, account);
			expect(await result.text()).toBe("{not json");
		});

		// Reusing the inbound length after rewriting the body sends wrong framing
		// and the outgoing fetch can reject the request before Meta sees it.
		it("does not carry a stale content-length onto the rewritten body", async () => {
			const original = JSON.stringify({
				model: "claude-opus-4-6-20260115",
				max_tokens: 4096,
				messages: [{ role: "user", content: "hi" }],
				stop_sequences: ["\n"],
				top_k: 40,
			});
			const request = new Request("https://proxy.local/v1/messages", {
				method: "POST",
				headers: {
					"content-type": "application/json",
					"content-length": String(original.length),
				},
				body: original,
			});

			const transformed = await provider.transformRequestBody(request, account);
			const stated = transformed.headers.get("content-length");
			const actual = (await transformed.clone().text()).length;
			expect(stated === null || Number(stated) === actual).toBe(true);
		});

		it("also sanitizes count_tokens, which shares the Messages contract", async () => {
			const request = new Request(
				"https://proxy.local/v1/messages/count_tokens",
				{
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({
						model: "claude-opus-4-6-20260115",
						messages: [{ role: "user", content: "hi" }],
						top_k: 40,
					}),
				},
			);

			const body = await bodyOf(
				await provider.transformRequestBody(request, account),
			);
			expect(body.model).toBe(MUSE_SPARK_DEFAULT_MODEL);
			expect(body).not.toHaveProperty("top_k");
		});

		it("leaves a non-Messages endpoint body untouched", async () => {
			const original = { purpose: "assistants", some_field: 1 };
			const request = new Request("https://proxy.local/v1/files", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(original),
			});

			const body = await bodyOf(
				await provider.transformRequestBody(request, account),
			);
			expect(body).toEqual(original);
		});
	});

	describe("isMuseSparkMessagesPath", () => {
		it("matches the Messages surface only", () => {
			expect(isMuseSparkMessagesPath("https://api.meta.ai/v1/messages")).toBe(
				true,
			);
			expect(
				isMuseSparkMessagesPath("https://api.meta.ai/v1/messages/count_tokens"),
			).toBe(true);
			expect(isMuseSparkMessagesPath("https://api.meta.ai/v1/files")).toBe(
				false,
			);
			expect(isMuseSparkMessagesPath("https://api.meta.ai/v1/responses")).toBe(
				false,
			);
		});

		it("ignores the query string", () => {
			expect(
				isMuseSparkMessagesPath("https://api.meta.ai/v1/messages?beta=1"),
			).toBe(true);
		});

		// The proxy hands transformRequestBody the already-rewritten target URL,
		// so a gateway prefix must still be recognised or sanitization is skipped
		// for exactly the accounts that need it.
		it("matches both Messages routes behind a gateway path prefix", () => {
			expect(
				isMuseSparkMessagesPath("https://gateway.example/proxy/v1/messages"),
			).toBe(true);
			expect(
				isMuseSparkMessagesPath(
					"https://gateway.example/proxy/v1/messages/count_tokens",
				),
			).toBe(true);
			expect(
				isMuseSparkMessagesPath("https://gateway.example/proxy/v1/files"),
			).toBe(false);
		});
	});

	describe("parseRateLimit", () => {
		it("reports not rate limited on a healthy response", () => {
			const response = new Response("{}", {
				status: 200,
				headers: {
					"x-ratelimit-remaining-requests": "2500",
					"x-ratelimit-limit-requests": "3000",
				},
			});
			const info = provider.parseRateLimit(response);
			expect(info.isRateLimited).toBe(false);
			expect(info.remaining).toBe(2500);
		});

		// Rate-limit metadata is only persisted when a status is present, so a
		// healthy response must carry one or the parsed headroom is discarded.
		it("marks a healthy response allowed so headroom is persisted", () => {
			const response = new Response("{}", {
				status: 200,
				headers: { "x-ratelimit-remaining-requests": "2500" },
			});
			const info = provider.parseRateLimit(response);
			expect(info.statusHeader).toBe("allowed");
			expect(info.remaining).toBe(2500);
			expect(info.isRateLimited).toBe(false);
		});

		it("claims no status when Meta reported no quota headers", () => {
			const info = provider.parseRateLimit(new Response("{}", { status: 200 }));
			expect(info.statusHeader).toBeUndefined();
			expect(info.remaining).toBeUndefined();
		});

		it("falls back to remaining tokens when requests are not reported", () => {
			const response = new Response("{}", {
				status: 200,
				headers: { "x-ratelimit-remaining-tokens": "1200000" },
			});
			expect(provider.parseRateLimit(response).remaining).toBe(1_200_000);
		});

		it("flags a 429 and derives the reset time from retry-after", () => {
			const before = Date.now();
			const response = new Response("{}", {
				status: 429,
				headers: { "retry-after": "30" },
			});
			const info = provider.parseRateLimit(response);
			expect(info.isRateLimited).toBe(true);
			expect(info.resetTime).toBeGreaterThanOrEqual(before + 30_000);
		});

		it("flags a 429 with no retry-after and leaves the reset time unset", () => {
			const info = provider.parseRateLimit(new Response("{}", { status: 429 }));
			expect(info.isRateLimited).toBe(true);
			expect(info.resetTime).toBeUndefined();
		});

		it("returns undefined remaining when no headers are present", () => {
			const info = provider.parseRateLimit(new Response("{}", { status: 200 }));
			expect(info.isRateLimited).toBe(false);
			expect(info.remaining).toBeUndefined();
		});
	});

	describe("extractUsageInfo", () => {
		it("reads Anthropic-shaped usage from a JSON response", async () => {
			const response = new Response(
				JSON.stringify({
					model: "muse-spark-1.2",
					usage: {
						input_tokens: 100,
						output_tokens: 50,
						cache_read_input_tokens: 20,
					},
				}),
				{ headers: { "content-type": "application/json" } },
			);

			const usage = await provider.extractUsageInfo(response);
			expect(usage?.model).toBe("muse-spark-1.2");
			expect(usage?.inputTokens).toBe(100);
			expect(usage?.outputTokens).toBe(50);
			expect(usage?.cacheReadInputTokens).toBe(20);
		});
	});

	describe("supportsOAuth", () => {
		it("is an API-key provider", () => {
			expect(provider.supportsOAuth()).toBe(false);
		});
	});

	describe("isMuseSparkModel", () => {
		it("recognises Muse Spark model IDs", () => {
			expect(isMuseSparkModel("muse-spark-1.2")).toBe(true);
			expect(isMuseSparkModel("MUSE-SPARK-1.1")).toBe(true);
			expect(isMuseSparkModel("claude-opus-4-6")).toBe(false);
		});
	});
});
