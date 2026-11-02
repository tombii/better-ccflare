/**
 * Tests for the DeepSeek adapter.
 *
 * `globalThis.fetch` is stubbed for every test — there are no real network
 * calls, and nothing here touches Anthropic.
 */
import { afterEach, describe, expect, it } from "bun:test";
import {
	createDeepSeekAdapter,
	DEEPSEEK_SEARCH_URL,
	DeepSeekSearchError,
} from "../adapters/deepseek";
import type { WebToolAdapterConfig, WebToolSearchRequest } from "../types";

const originalFetch = globalThis.fetch;

afterEach(() => {
	globalThis.fetch = originalFetch;
});

interface CapturedCall {
	url: string;
	init: RequestInit;
}

let calls: CapturedCall[] = [];

function stubFetch(
	responder: (call: CapturedCall) => Response | Promise<Response>,
): void {
	calls = [];
	globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
		const call: CapturedCall = { url: String(input), init: init ?? {} };
		calls.push(call);
		return responder(call);
	}) as typeof fetch;
}

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

function headersOf(call: CapturedCall): Headers {
	return new Headers(call.init.headers as HeadersInit | undefined);
}

function bodyOf(call: CapturedCall): Record<string, unknown> {
	return JSON.parse(String(call.init.body)) as Record<string, unknown>;
}

const adapter = createDeepSeekAdapter();

const baseConfig: WebToolAdapterConfig = {
	apiKey: "sk-deepseek-canary-1234",
	maxResults: 10,
	extraConfig: {},
};

function request(
	overrides: Partial<WebToolSearchRequest> = {},
): WebToolSearchRequest {
	return { query: "hello world", maxResults: 5, ...overrides };
}

describe("deepseek adapter — request shape", () => {
	it("posts to the documented URL with bearer auth and the base body", async () => {
		stubFetch(() => jsonResponse({ results: [] }));

		await adapter.search(request(), baseConfig);

		expect(calls).toHaveLength(1);
		const [call] = calls;
		expect(call.url).toBe(DEEPSEEK_SEARCH_URL);
		expect(call.init.method).toBe("POST");
		expect(headersOf(call).get("Authorization")).toBe(
			"Bearer sk-deepseek-canary-1234",
		);
		expect(headersOf(call).get("Content-Type")).toBe("application/json");
		expect(call.init.signal).toBeInstanceOf(AbortSignal);

		// No optional fields are emitted unless requested.
		expect(bodyOf(call)).toEqual({ query: "hello world", count: 5 });
	});

	it("clamps count to DeepSeek's 0–50 range", async () => {
		stubFetch(() => jsonResponse({ results: [] }));
		const roomy = { ...baseConfig, maxResults: 200 };

		await adapter.search(request({ maxResults: 500 }), roomy);
		await adapter.search(request({ maxResults: -3 }), roomy);
		await adapter.search(request({ maxResults: 0 }), roomy);
		await adapter.search(request({ maxResults: Number.NaN }), roomy);
		await adapter.search(request({ maxResults: 12.9 }), roomy);

		expect(bodyOf(calls[0]).count).toBe(50);
		expect(bodyOf(calls[1]).count).toBe(0);
		expect(bodyOf(calls[2]).count).toBe(0);
		expect(bodyOf(calls[3]).count).toBe(10);
		expect(bodyOf(calls[4]).count).toBe(12);
	});

	it("the provider's configured maxResults caps the search", async () => {
		stubFetch(() => jsonResponse({ results: [] }));
		const capped = { ...baseConfig, maxResults: 3 };

		await adapter.search(request({ maxResults: 10 }), capped);
		await adapter.search(request({ maxResults: 1 }), capped);

		expect(bodyOf(calls[0]).count).toBe(3);
		expect(bodyOf(calls[1]).count).toBe(1);
	});

	it("sends need_content only when explicitly enabled", async () => {
		stubFetch(() => jsonResponse({ results: [] }));

		await adapter.search(request(), {
			...baseConfig,
			extraConfig: { needContent: true },
		});
		await adapter.search(request(), {
			...baseConfig,
			extraConfig: { needContent: "true" },
		});
		await adapter.search(request(), baseConfig);

		expect(bodyOf(calls[0]).need_content).toBe(true);
		expect(bodyOf(calls[1])).not.toHaveProperty("need_content");
		expect(bodyOf(calls[2])).not.toHaveProperty("need_content");
	});
});

describe("deepseek adapter — response mapping", () => {
	it("maps results onto the normalised hit shape", async () => {
		stubFetch(() =>
			jsonResponse({
				results: [
					{
						rerank_score: 0.9,
						title: "First",
						url: "https://example.com/1",
						snippet: "a snippet",
						summary: "a summary",
						content: "the full page",
						site_name: "Example",
						date: "2026-01-02",
					},
				],
			}),
		);

		const hits = await adapter.search(request(), baseConfig);

		expect(hits).toEqual([
			{
				title: "First",
				url: "https://example.com/1",
				snippet: "a snippet",
				content: "the full page",
				publishedDate: "2026-01-02",
			},
		]);
	});

	it("drops entries missing a url, title or snippet", async () => {
		stubFetch(() =>
			jsonResponse({
				results: [
					{ title: "No URL", snippet: "s" },
					{ url: "https://example.com/no-title", snippet: "s" },
					{ title: "No snippet", url: "https://example.com/no-snippet" },
					{ title: "Kept", url: "https://example.com/kept", snippet: "s" },
					"not an object",
				],
			}),
		);

		const hits = await adapter.search(request(), baseConfig);

		expect(hits).toEqual([
			{
				title: "Kept",
				url: "https://example.com/kept",
				snippet: "s",
			},
		]);
	});

	it("returns at most maxResults hits", async () => {
		stubFetch(() =>
			jsonResponse({
				results: [
					{ title: "a", url: "https://example.com/a", snippet: "s" },
					{ title: "b", url: "https://example.com/b", snippet: "s" },
					{ title: "c", url: "https://example.com/c", snippet: "s" },
				],
			}),
		);

		const hits = await adapter.search(request({ maxResults: 2 }), baseConfig);

		expect(hits.map((hit) => hit.url)).toEqual([
			"https://example.com/a",
			"https://example.com/b",
		]);
	});

	it("throws on a payload with a non-array results field", async () => {
		stubFetch(() => jsonResponse({ results: "nope" }));

		await expect(adapter.search(request(), baseConfig)).rejects.toBeInstanceOf(
			DeepSeekSearchError,
		);
	});

	it("throws on a non-object payload", async () => {
		stubFetch(() => jsonResponse(["nope"]));

		await expect(adapter.search(request(), baseConfig)).rejects.toThrow(
			/results array/,
		);
	});

	it("keeps an explicit empty results array as a valid empty search", async () => {
		stubFetch(() => jsonResponse({ results: [] }));

		expect(await adapter.search(request(), baseConfig)).toEqual([]);
	});

	it("throws for a 200 with no results key at all", async () => {
		// A payload without `results` is malformed, not an empty search:
		// accepting it would mark the provider healthy and stop the chain
		// before a backup provider was tried.
		stubFetch(() => jsonResponse({}));

		await expect(adapter.search(request(), baseConfig)).rejects.toThrow(
			/results array/,
		);
	});

	it("keeps an explicit empty results array as a valid empty search", async () => {
		// DeepSeek does not bill a search that returns nothing, so this is a
		// real outcome and must not fall through to another provider.
		stubFetch(() => jsonResponse({ results: [] }));

		expect(await adapter.search(request(), baseConfig)).toEqual([]);
	});
});

describe("deepseek adapter — errors", () => {
	it("throws a typed error carrying the HTTP status", async () => {
		stubFetch(() =>
			jsonResponse({ error: { message: "you are searching too fast" } }, 429),
		);

		let caught: unknown;
		try {
			await adapter.search(request(), baseConfig);
		} catch (error) {
			caught = error;
		}

		expect(caught).toBeInstanceOf(DeepSeekSearchError);
		const typed = caught as DeepSeekSearchError;
		expect(typed.status).toBe(429);
		expect(typed.name).toBe("DeepSeekSearchError");
		expect(typed.message).toContain("429");
		expect(typed.message).toContain("searching too fast");
		expect(typed.message).not.toContain(baseConfig.apiKey as string);
	});

	it("keeps auth, payment and rate-limit statuses distinguishable", async () => {
		for (const status of [401, 402, 429, 500]) {
			stubFetch(() => jsonResponse({ error: "nope" }, status));
			let caught: unknown;
			try {
				await adapter.search(request(), baseConfig);
			} catch (error) {
				caught = error;
			}
			expect((caught as DeepSeekSearchError).status).toBe(status);
		}
	});

	it("surfaces an abort as a status-408 error", async () => {
		globalThis.fetch = (async () => {
			const error = new Error("aborted");
			error.name = "AbortError";
			throw error;
		}) as typeof fetch;

		let caught: unknown;
		try {
			await adapter.search(
				request({ signal: AbortSignal.abort() }),
				baseConfig,
			);
		} catch (error) {
			caught = error;
		}

		expect(caught).toBeInstanceOf(DeepSeekSearchError);
		expect((caught as DeepSeekSearchError).status).toBe(408);
	});

	it("refuses to call out without an API key", async () => {
		stubFetch(() => jsonResponse({ results: [] }));

		await expect(
			adapter.search(request(), { ...baseConfig, apiKey: null }),
		).rejects.toThrow("requires an API key");
		expect(calls).toHaveLength(0);
	});
});

describe("deepseek adapter — test()", () => {
	it("sends a minimal probe and reports ok with latency", async () => {
		stubFetch(() => jsonResponse({ results: [] }));

		const result = await adapter.test(baseConfig);

		expect(result.ok).toBe(true);
		expect(result.error).toBeUndefined();
		expect(result.latencyMs).toBeGreaterThanOrEqual(0);
		expect(calls).toHaveLength(1);
		expect(bodyOf(calls[0])).toEqual({
			query: "better-ccflare connectivity test",
			count: 1,
		});
	});

	it("returns ok:false on a server error without throwing", async () => {
		stubFetch(() => jsonResponse({ error: "kaput" }, 500));

		const result = await adapter.test(baseConfig);

		expect(result.ok).toBe(false);
		expect(result.error).toContain("500");
		expect(result.error).not.toContain(baseConfig.apiKey as string);
	});

	it("returns ok:false on an unexpected shape", async () => {
		stubFetch(() => jsonResponse("not an object"));

		const result = await adapter.test(baseConfig);

		expect(result.ok).toBe(false);
		expect(result.error).toBe("unexpected response shape");
	});

	it("returns ok:false when no key is stored, with no outbound call", async () => {
		stubFetch(() => jsonResponse({ results: [] }));

		const result = await adapter.test({ ...baseConfig, apiKey: null });

		expect(result.ok).toBe(false);
		expect(result.error).toBe("no API key configured");
		expect(calls).toHaveLength(0);
	});
});

describe("deepseek adapter — domain filters", () => {
	// DeepSeek has no native include/exclude parameters, so these are applied
	// as a post-filter. Without them a blocked site or an off-allowlist site
	// would reach the model.
	const payload = {
		results: [
			{ title: "Also", url: "https://blog.example.com/a", snippet: "s1" },
			{ title: "Other", url: "https://other.test/b", snippet: "s2" },
			{
				title: "Root",
				url: "https://example.com/c",
				snippet: "s3",
			},
		],
	};

	it("keeps only allowlisted hosts and their subdomains", async () => {
		stubFetch(() => jsonResponse(payload));

		const hits = await adapter.search(
			request({ allowedDomains: ["example.com"] }),
			baseConfig,
		);

		expect(hits.map((h) => h.url)).toEqual([
			"https://blog.example.com/a",
			"https://example.com/c",
		]);
	});

	it("drops blocked hosts and their subdomains", async () => {
		stubFetch(() => jsonResponse(payload));

		const hits = await adapter.search(
			request({ blockedDomains: ["example.com"] }),
			baseConfig,
		);

		expect(hits.map((h) => h.url)).toEqual(["https://other.test/b"]);
	});

	it("prefers the allowlist when both lists are given", async () => {
		stubFetch(() => jsonResponse(payload));

		const hits = await adapter.search(
			request({
				allowedDomains: ["other.test"],
				blockedDomains: ["other.test"],
			}),
			baseConfig,
		);

		expect(hits.map((h) => h.url)).toEqual(["https://other.test/b"]);
	});
});
