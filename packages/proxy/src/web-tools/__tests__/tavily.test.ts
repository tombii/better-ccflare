/**
 * Tests for the Tavily adapter.
 *
 * `globalThis.fetch` is stubbed for every test — there are no real network
 * calls, and nothing here touches Anthropic.
 */
import { afterEach, describe, expect, it } from "bun:test";
import {
	createTavilyAdapter,
	TAVILY_SEARCH_URL,
	TavilySearchError,
} from "../adapters/tavily";
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

const adapter = createTavilyAdapter();

const baseConfig: WebToolAdapterConfig = {
	apiKey: "tvly-test-key",
	maxResults: 10,
	extraConfig: {},
};

function request(
	overrides: Partial<WebToolSearchRequest> = {},
): WebToolSearchRequest {
	return { query: "hello world", maxResults: 5, ...overrides };
}

describe("tavily adapter — request shape", () => {
	it("posts to the documented URL with bearer auth and the base body", async () => {
		stubFetch(() => jsonResponse({ results: [] }));

		await adapter.search(request(), baseConfig);

		expect(calls).toHaveLength(1);
		const [call] = calls;
		expect(call.url).toBe(TAVILY_SEARCH_URL);
		expect(call.init.method).toBe("POST");
		expect(headersOf(call).get("Authorization")).toBe("Bearer tvly-test-key");
		expect(headersOf(call).get("Content-Type")).toBe("application/json");
		expect(call.init.signal).toBeInstanceOf(AbortSignal);

		// No optional fields are emitted unless requested.
		expect(bodyOf(call)).toEqual({
			query: "hello world",
			max_results: 5,
			search_depth: "basic",
		});
	});

	it("passes allowed domains as include_domains", async () => {
		stubFetch(() => jsonResponse({ results: [] }));

		await adapter.search(
			request({ allowedDomains: ["example.com", "docs.example.com"] }),
			baseConfig,
		);

		expect(bodyOf(calls[0]).include_domains).toEqual([
			"example.com",
			"docs.example.com",
		]);
		expect(bodyOf(calls[0])).not.toHaveProperty("exclude_domains");
	});

	it("passes blocked domains as exclude_domains", async () => {
		stubFetch(() => jsonResponse({ results: [] }));

		await adapter.search(
			request({ blockedDomains: ["spam.example"] }),
			baseConfig,
		);

		expect(bodyOf(calls[0]).exclude_domains).toEqual(["spam.example"]);
		expect(bodyOf(calls[0])).not.toHaveProperty("include_domains");
	});

	it("prefers include_domains when both filters are present", async () => {
		stubFetch(() => jsonResponse({ results: [] }));

		await adapter.search(
			request({
				allowedDomains: ["ok.example"],
				blockedDomains: ["bad.example"],
			}),
			baseConfig,
		);

		expect(bodyOf(calls[0]).include_domains).toEqual(["ok.example"]);
		expect(bodyOf(calls[0])).not.toHaveProperty("exclude_domains");
	});

	it("clamps max_results to Tavily's 0–20 range", async () => {
		stubFetch(() => jsonResponse({ results: [] }));

		await adapter.search(request({ maxResults: 50 }), baseConfig);
		await adapter.search(request({ maxResults: -3 }), baseConfig);
		await adapter.search(request({ maxResults: 0 }), baseConfig);
		await adapter.search(request({ maxResults: Number.NaN }), baseConfig);

		expect(bodyOf(calls[0]).max_results).toBe(20);
		expect(bodyOf(calls[1]).max_results).toBe(0);
		expect(bodyOf(calls[2]).max_results).toBe(0);
		expect(bodyOf(calls[3]).max_results).toBe(10);
	});

	it("forwards topic only when configured to a supported value", async () => {
		stubFetch(() => jsonResponse({ results: [] }));

		await adapter.search(request(), {
			...baseConfig,
			extraConfig: { topic: "news" },
		});
		await adapter.search(request(), {
			...baseConfig,
			extraConfig: { topic: "weather" },
		});
		await adapter.search(request(), baseConfig);

		expect(bodyOf(calls[0]).topic).toBe("news");
		expect(bodyOf(calls[1])).not.toHaveProperty("topic");
		expect(bodyOf(calls[2])).not.toHaveProperty("topic");
	});

	it("asks for raw content only when the operator opted in", async () => {
		stubFetch(() => jsonResponse({ results: [] }));

		await adapter.search(request(), {
			...baseConfig,
			extraConfig: { includeRawContent: true },
		});
		await adapter.search(request(), {
			...baseConfig,
			extraConfig: { includeRawContent: "true" },
		});
		await adapter.search(request(), baseConfig);

		expect(bodyOf(calls[0]).include_raw_content).toBe(true);
		expect(bodyOf(calls[1])).not.toHaveProperty("include_raw_content");
		expect(bodyOf(calls[2])).not.toHaveProperty("include_raw_content");
	});
});

describe("tavily adapter — response mapping", () => {
	it("maps results onto the normalised hit shape", async () => {
		stubFetch(() =>
			jsonResponse({
				results: [
					{
						title: "First",
						url: "https://example.com/1",
						content: "a snippet",
						raw_content: "the full page",
						published_date: "2026-01-02",
					},
					{ title: "No URL", content: "dropped" },
					{ url: "https://example.com/3" },
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
			{ title: "", url: "https://example.com/3" },
		]);
	});

	it("returns at most maxResults hits", async () => {
		stubFetch(() =>
			jsonResponse({
				results: [
					{ title: "a", url: "https://example.com/a" },
					{ title: "b", url: "https://example.com/b" },
					{ title: "c", url: "https://example.com/c" },
				],
			}),
		);

		const hits = await adapter.search(request({ maxResults: 2 }), baseConfig);

		expect(hits).toHaveLength(2);
		expect(hits.map((hit) => hit.url)).toEqual([
			"https://example.com/a",
			"https://example.com/b",
		]);
	});

	it("treats a malformed payload as no results", async () => {
		stubFetch(() => jsonResponse({ unexpected: true }));

		expect(await adapter.search(request(), baseConfig)).toEqual([]);
	});
});

describe("tavily adapter — errors", () => {
	it("throws a typed error carrying the HTTP status", async () => {
		stubFetch(() =>
			jsonResponse({ detail: "you are searching too fast" }, 429),
		);

		let caught: unknown;
		try {
			await adapter.search(request(), baseConfig);
		} catch (error) {
			caught = error;
		}

		expect(caught).toBeInstanceOf(TavilySearchError);
		const typed = caught as TavilySearchError;
		expect(typed.status).toBe(429);
		expect(typed.name).toBe("TavilySearchError");
		expect(typed.message).toContain("429");
		expect(typed.message).toContain("searching too fast");
		// The credential is never echoed back.
		expect(typed.message).not.toContain(baseConfig.apiKey as string);
	});

	it("keeps auth, payment and rate-limit statuses distinguishable", async () => {
		for (const status of [401, 402, 429, 500]) {
			stubFetch(() => jsonResponse({ detail: "nope" }, status));
			let caught: unknown;
			try {
				await adapter.search(request(), baseConfig);
			} catch (error) {
				caught = error;
			}
			expect((caught as TavilySearchError).status).toBe(status);
		}
	});

	it("truncates a long error body", async () => {
		stubFetch(() => jsonResponse({ detail: "x".repeat(2000) }, 500));

		let caught: unknown;
		try {
			await adapter.search(request(), baseConfig);
		} catch (error) {
			caught = error;
		}

		// Status prefix + a ~200-character excerpt, not the whole body.
		expect((caught as Error).message.length).toBeLessThan(400);
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

		expect(caught).toBeInstanceOf(TavilySearchError);
		expect((caught as TavilySearchError).status).toBe(408);
	});

	it("refuses to call out without an API key", async () => {
		stubFetch(() => jsonResponse({ results: [] }));

		await expect(
			adapter.search(request(), { ...baseConfig, apiKey: null }),
		).rejects.toThrow("requires an API key");
		expect(calls).toHaveLength(0);
	});
});

describe("tavily adapter — test()", () => {
	it("sends a minimal probe and reports ok with latency", async () => {
		stubFetch(() => jsonResponse({ results: [] }));

		const result = await adapter.test(baseConfig);

		expect(result.ok).toBe(true);
		expect(result.error).toBeUndefined();
		expect(result.latencyMs).toBeGreaterThanOrEqual(0);
		expect(calls).toHaveLength(1);
		expect(bodyOf(calls[0])).toEqual({
			query: "better-ccflare connectivity test",
			max_results: 1,
			search_depth: "basic",
		});
	});

	it("returns ok:false on a server error without throwing", async () => {
		stubFetch(() => jsonResponse({ detail: "kaput" }, 500));

		const result = await adapter.test(baseConfig);

		expect(result.ok).toBe(false);
		expect(result.error).toContain("500");
		expect(result.latencyMs).toBeGreaterThanOrEqual(0);
	});

	it("returns ok:false when no key is stored, with no outbound call", async () => {
		stubFetch(() => jsonResponse({ results: [] }));

		const result = await adapter.test({ ...baseConfig, apiKey: null });

		expect(result.ok).toBe(false);
		expect(result.error).toBe("no API key configured");
		expect(calls).toHaveLength(0);
	});
});
