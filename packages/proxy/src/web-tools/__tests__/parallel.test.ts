/**
 * Tests for the Parallel adapter.
 *
 * `globalThis.fetch` is stubbed for every test — there are no real network
 * calls, and nothing here touches Anthropic.
 */
import { afterEach, describe, expect, it } from "bun:test";
import {
	createParallelAdapter,
	PARALLEL_SEARCH_URL,
	ParallelSearchError,
} from "../adapters/parallel";
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

const adapter = createParallelAdapter();

const API_KEY = "parallel-canary-key-0123456789";
const baseConfig: WebToolAdapterConfig = {
	apiKey: API_KEY,
	maxResults: 10,
	extraConfig: {},
};

function request(
	overrides: Partial<WebToolSearchRequest> = {},
): WebToolSearchRequest {
	return { query: "hello world", maxResults: 5, ...overrides };
}

describe("parallel adapter — request shape", () => {
	it("posts to the documented URL with x-api-key auth and the base body", async () => {
		stubFetch(() => jsonResponse({ results: [] }));

		await adapter.search(request(), baseConfig);

		expect(calls).toHaveLength(1);
		const [call] = calls;
		expect(call.url).toBe("https://api.parallel.ai/v1/search");
		expect(call.url).toBe(PARALLEL_SEARCH_URL);
		expect(call.init.method).toBe("POST");
		expect(headersOf(call).get("x-api-key")).toBe(API_KEY);
		expect(headersOf(call).get("Authorization")).toBeNull();
		expect(headersOf(call).get("Content-Type")).toBe("application/json");
		expect(call.init.signal).toBeInstanceOf(AbortSignal);

		// The query travels in an ARRAY — Parallel's defining difference.
		// No result-count field. Parallel has no such parameter and rejects
		// `max_results` with 422 extra_forbidden (verified against the live
		// API), so the count is trimmed locally instead.
		expect(bodyOf(call)).toEqual({
			search_queries: ["hello world"],
			mode: "basic",
		});
		expect(bodyOf(call)).not.toHaveProperty("max_results");
	});

	it("passes allowed domains under advanced_settings.source_policy", async () => {
		stubFetch(() => jsonResponse({ results: [] }));

		await adapter.search(
			request({ allowedDomains: ["example.com", "docs.example.com"] }),
			baseConfig,
		);

		const advanced = bodyOf(calls[0]).advanced_settings as Record<
			string,
			unknown
		>;
		expect(advanced.source_policy).toEqual({
			include_domains: ["example.com", "docs.example.com"],
		});
	});

	it("passes blocked domains under advanced_settings.source_policy", async () => {
		stubFetch(() => jsonResponse({ results: [] }));

		await adapter.search(
			request({ blockedDomains: ["spam.example"] }),
			baseConfig,
		);

		const advanced = bodyOf(calls[0]).advanced_settings as Record<
			string,
			unknown
		>;
		expect(advanced.source_policy).toEqual({
			exclude_domains: ["spam.example"],
		});
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

		const advanced = bodyOf(calls[0]).advanced_settings as Record<
			string,
			unknown
		>;
		expect(advanced.source_policy).toEqual({
			include_domains: ["ok.example"],
		});
	});

	it("never sends a result-count field, whatever the caller asks for", async () => {
		stubFetch(() => jsonResponse({ results: [] }));
		const roomy = { ...baseConfig, maxResults: 500 };

		await adapter.search(request({ maxResults: 500 }), roomy);
		await adapter.search(request({ maxResults: Number.NaN }), roomy);

		for (const call of calls) {
			expect(bodyOf(call)).not.toHaveProperty("max_results");
			expect(bodyOf(call)).not.toHaveProperty("num_results");
		}
	});

	it("the provider's configured maxResults trims the returned hits", async () => {
		stubFetch(() =>
			jsonResponse({
				results: Array.from({ length: 8 }, (_, i) => ({
					title: `r${i}`,
					url: `https://example.com/${i}`,
					excerpts: ["x"],
				})),
			}),
		);
		const capped = { ...baseConfig, maxResults: 3 };

		// The provider returns 8; the operator's cap binds regardless of what
		// the caller asks for.
		expect(
			await adapter.search(request({ maxResults: 10 }), capped),
		).toHaveLength(3);
		expect(
			await adapter.search(request({ maxResults: 1 }), capped),
		).toHaveLength(1);
	});

	it("forwards mode only when configured to a supported value", async () => {
		stubFetch(() => jsonResponse({ results: [] }));

		await adapter.search(request(), {
			...baseConfig,
			extraConfig: { mode: "advanced" },
		});
		await adapter.search(request(), {
			...baseConfig,
			extraConfig: { mode: "superfast" },
		});
		await adapter.search(request(), baseConfig);

		expect(bodyOf(calls[0]).mode).toBe("advanced");
		// Not a Parallel mode — falls back to Parallel's own default.
		expect(bodyOf(calls[1]).mode).toBe("basic");
		expect(bodyOf(calls[2]).mode).toBe("basic");
	});

	it("forwards objective only when configured", async () => {
		stubFetch(() => jsonResponse({ results: [] }));

		await adapter.search(request(), {
			...baseConfig,
			extraConfig: { objective: "find pricing pages for LLM gateways" },
		});
		await adapter.search(request(), {
			...baseConfig,
			extraConfig: { objective: "   " },
		});
		await adapter.search(request(), baseConfig);

		expect(bodyOf(calls[0]).objective).toBe(
			"find pricing pages for LLM gateways",
		);
		expect(bodyOf(calls[1])).not.toHaveProperty("objective");
		expect(bodyOf(calls[2])).not.toHaveProperty("objective");
	});
});

describe("parallel adapter — response mapping", () => {
	it("maps results, joining excerpts into content and slicing a snippet", async () => {
		stubFetch(() =>
			jsonResponse({
				results: [
					{
						title: "First",
						url: "https://example.com/1",
						publish_date: "2026-01-02",
						excerpts: ["first passage", "second passage"],
					},
					{ title: "No URL", excerpts: ["dropped"] },
					{ url: "https://example.com/3" },
				],
			}),
		);

		const hits = await adapter.search(request(), baseConfig);

		expect(hits).toEqual([
			{
				title: "First",
				url: "https://example.com/1",
				content: "first passage\n\nsecond passage",
				snippet: "first passage\n\nsecond passage",
				publishedDate: "2026-01-02",
			},
			{ title: "", url: "https://example.com/3" },
		]);
	});

	it("snippets longer than 500 characters are truncated", async () => {
		const long = "x".repeat(800);
		stubFetch(() =>
			jsonResponse({
				results: [
					{ title: "Big", url: "https://example.com/big", excerpts: [long] },
				],
			}),
		);

		const hits = await adapter.search(request(), baseConfig);

		expect(hits[0].content).toHaveLength(800);
		expect(hits[0].snippet).toHaveLength(500);
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

	it("throws on a payload without a results array instead of faking success", async () => {
		stubFetch(() => jsonResponse({ unexpected: true }));

		await expect(adapter.search(request(), baseConfig)).rejects.toThrow(
			/results array/,
		);
	});

	it("keeps an explicit empty results array as a valid empty search", async () => {
		stubFetch(() => jsonResponse({ results: [] }));

		expect(await adapter.search(request(), baseConfig)).toEqual([]);
	});
});

describe("parallel adapter — errors", () => {
	it("throws a typed error carrying the HTTP status", async () => {
		stubFetch(() => jsonResponse({ error: "you are searching too fast" }, 429));

		let caught: unknown;
		try {
			await adapter.search(request(), baseConfig);
		} catch (error) {
			caught = error;
		}

		expect(caught).toBeInstanceOf(ParallelSearchError);
		const typed = caught as ParallelSearchError;
		expect(typed.status).toBe(429);
		expect(typed.name).toBe("ParallelSearchError");
		expect(typed.message).toContain("429");
		expect(typed.message).toContain("searching too fast");
		// The credential is never echoed back.
		expect(typed.message).not.toContain(API_KEY);
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
			expect(caught).toBeInstanceOf(ParallelSearchError);
			expect((caught as ParallelSearchError).status).toBe(status);
		}
	});

	it("truncates a long error body", async () => {
		stubFetch(() => jsonResponse({ error: "x".repeat(2000) }, 500));

		let caught: unknown;
		try {
			await adapter.search(request(), baseConfig);
		} catch (error) {
			caught = error;
		}

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

		expect(caught).toBeInstanceOf(ParallelSearchError);
		expect((caught as ParallelSearchError).status).toBe(408);
	});

	it("refuses to call out without an API key", async () => {
		stubFetch(() => jsonResponse({ results: [] }));

		await expect(
			adapter.search(request(), { ...baseConfig, apiKey: null }),
		).rejects.toThrow("requires an API key");
		expect(calls).toHaveLength(0);
	});
});

describe("parallel adapter — test()", () => {
	it("sends a minimal probe and reports ok with latency", async () => {
		stubFetch(() => jsonResponse({ results: [] }));

		const result = await adapter.test(baseConfig);

		expect(result.ok).toBe(true);
		expect(result.error).toBeUndefined();
		expect(result.latencyMs).toBeGreaterThanOrEqual(0);
		expect(calls).toHaveLength(1);
		expect(headersOf(calls[0]).get("x-api-key")).toBe(API_KEY);
		expect(bodyOf(calls[0])).toEqual({
			search_queries: ["better-ccflare connectivity test"],
			mode: "basic",
		});
	});

	it("returns ok:false on a server error without throwing", async () => {
		stubFetch(() => jsonResponse({ error: "kaput" }, 500));

		const result = await adapter.test(baseConfig);

		expect(result.ok).toBe(false);
		expect(result.error).toContain("500");
		expect(result.error).not.toContain(API_KEY);
		expect(result.latencyMs).toBeGreaterThanOrEqual(0);
	});

	it("returns ok:false on an unexpected response shape", async () => {
		stubFetch(() => jsonResponse({ unexpected: true }));

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
