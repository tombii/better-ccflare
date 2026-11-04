/**
 * Tests for the Tinyfish adapter.
 *
 * `globalThis.fetch` is stubbed for every test — there are no real network
 * calls, and nothing here touches Anthropic.
 */
import { afterEach, describe, expect, it } from "bun:test";
import {
	createTinyfishAdapter,
	TINYFISH_ERROR_STATUS_MISSING_KEY,
	TINYFISH_SEARCH_URL,
	TinyfishSearchError,
} from "../adapters/tinyfish";
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

function searchParamsOf(call: CapturedCall): URLSearchParams {
	return new URL(call.url).searchParams;
}

function result(url: string): Record<string, unknown> {
	return {
		position: 1,
		site_name: `site ${url}`,
		title: `t ${url}`,
		snippet: "s",
		url,
	};
}

const adapter = createTinyfishAdapter();

const baseConfig: WebToolAdapterConfig = {
	apiKey: "tinyfish-canary-key-1234",
	maxResults: 10,
	extraConfig: {},
};

function request(
	overrides: Partial<WebToolSearchRequest> = {},
): WebToolSearchRequest {
	return { query: "hello world", maxResults: 5, ...overrides };
}

describe("tinyfish adapter — request shape", () => {
	it("GETs the documented URL with X-API-Key auth and query params", async () => {
		stubFetch(() => jsonResponse({ query: "hello world", results: [] }));

		await adapter.search(request(), baseConfig);

		expect(calls).toHaveLength(1);
		const [call] = calls;
		expect(call.url.startsWith(TINYFISH_SEARCH_URL)).toBe(true);
		expect(call.init.method).toBe("GET");
		// Tinyfish uses X-API-Key, not Bearer.
		expect(headersOf(call).get("X-API-Key")).toBe("tinyfish-canary-key-1234");
		expect(headersOf(call).get("Authorization")).toBeNull();
		expect(call.init.signal).toBeInstanceOf(AbortSignal);

		const params = searchParamsOf(call);
		expect(params.get("query")).toBe("hello world");
		expect(params.get("location")).toBe("US");
		expect(params.get("language")).toBe("en");
	});

	it("forwards location, language, domain_type and purpose only when configured", async () => {
		stubFetch(() => jsonResponse({ query: "hello world", results: [] }));

		await adapter.search(request(), {
			...baseConfig,
			extraConfig: {
				location: "DE",
				language: "de",
				domain_type: "news",
				purpose: "fact-checking",
			},
		});
		await adapter.search(request(), baseConfig);

		const configured = searchParamsOf(calls[0]);
		expect(configured.get("location")).toBe("DE");
		expect(configured.get("language")).toBe("de");
		expect(configured.get("domain_type")).toBe("news");
		expect(configured.get("purpose")).toBe("fact-checking");

		const defaults = searchParamsOf(calls[1]);
		expect(defaults.get("location")).toBe("US");
		expect(defaults.get("language")).toBe("en");
		expect(defaults.get("domain_type")).toBeNull();
		expect(defaults.get("purpose")).toBeNull();
	});

	it("ignores an invalid domain_type rather than sending it", async () => {
		stubFetch(() => jsonResponse({ query: "hello world", results: [] }));

		await adapter.search(request(), {
			...baseConfig,
			extraConfig: { domain_type: "everything" },
		});

		expect(searchParamsOf(calls[0]).get("domain_type")).toBeNull();
	});
});

describe("tinyfish adapter — response mapping", () => {
	it("maps results onto the normalised hit shape", async () => {
		stubFetch(() =>
			jsonResponse({
				query: "hello world",
				results: [
					{
						position: 1,
						site_name: "Example",
						title: "First",
						snippet: "a snippet",
						url: "https://example.com/1",
						date: "Jan 2, 2026",
					},
					{ title: "No url", snippet: "dropped" },
					{ url: "https://example.com/3" },
					{ title: "Empty url", url: "", snippet: "dropped" },
				],
				total_results: 1,
				page: 1,
			}),
		);

		const hits = await adapter.search(request(), baseConfig);

		expect(hits).toEqual([
			{
				title: "First",
				url: "https://example.com/1",
				snippet: "a snippet",
				publishedDate: "Jan 2, 2026",
			},
			{ title: "", url: "https://example.com/3" },
		]);
	});

	it("returns at most maxResults hits", async () => {
		stubFetch(() =>
			jsonResponse({
				query: "hello world",
				results: [
					result("https://example.com/a"),
					result("https://example.com/b"),
					result("https://example.com/c"),
				],
			}),
		);

		const hits = await adapter.search(request({ maxResults: 2 }), baseConfig);

		expect(hits.map((hit) => hit.url)).toEqual([
			"https://example.com/a",
			"https://example.com/b",
		]);
	});

	it("the provider's configured maxResults caps the search", async () => {
		stubFetch(() =>
			jsonResponse({
				query: "hello world",
				results: [
					result("https://example.com/a"),
					result("https://example.com/b"),
					result("https://example.com/c"),
				],
			}),
		);
		const capped = { ...baseConfig, maxResults: 1 };

		const hits = await adapter.search(request({ maxResults: 10 }), capped);

		expect(hits.map((hit) => hit.url)).toEqual(["https://example.com/a"]);
	});

	it("throws when the payload has no results array", async () => {
		stubFetch(() => jsonResponse({ organic: [{ url: "https://x.com" }] }));

		await expect(adapter.search(request(), baseConfig)).rejects.toThrow(
			/results array/,
		);
	});

	it("throws on a non-object payload", async () => {
		stubFetch(() => jsonResponse(null));

		await expect(adapter.search(request(), baseConfig)).rejects.toBeInstanceOf(
			TinyfishSearchError,
		);
	});

	it("keeps an explicit empty results array as a valid empty search", async () => {
		stubFetch(() => jsonResponse({ query: "hello world", results: [] }));

		expect(await adapter.search(request(), baseConfig)).toEqual([]);
	});
});

describe("tinyfish adapter — domain post-filtering", () => {
	const payload = {
		query: "hello world",
		results: [
			result("https://example.com/a"),
			result("https://www.example.com/b"),
			result("https://docs.example.com/c"),
			result("https://example.org/d"),
			result("https://notexample.com/e"),
		],
	};

	it("keeps only allowlisted hosts, matching subdomains too", async () => {
		stubFetch(() => jsonResponse(payload));

		const hits = await adapter.search(
			request({ allowedDomains: ["example.com"] }),
			baseConfig,
		);

		expect(hits.map((hit) => hit.url)).toEqual([
			"https://example.com/a",
			"https://www.example.com/b",
			"https://docs.example.com/c",
		]);
	});

	it("drops blocked hosts and their subdomains", async () => {
		stubFetch(() => jsonResponse(payload));

		const hits = await adapter.search(
			request({ blockedDomains: ["example.com"] }),
			baseConfig,
		);

		expect(hits.map((hit) => hit.url)).toEqual([
			"https://example.org/d",
			"https://notexample.com/e",
		]);
	});

	it("prefers the allowlist and ignores the blocklist when both are set", async () => {
		stubFetch(() => jsonResponse(payload));

		const hits = await adapter.search(
			request({
				allowedDomains: ["example.com"],
				blockedDomains: ["example.com"],
			}),
			baseConfig,
		);

		expect(hits).toHaveLength(3);
	});
});

describe("tinyfish adapter — errors", () => {
	it("throws a typed error carrying the HTTP status", async () => {
		stubFetch(() => jsonResponse({ message: "slow down" }, 429));

		let caught: unknown;
		try {
			await adapter.search(request(), baseConfig);
		} catch (error) {
			caught = error;
		}

		expect(caught).toBeInstanceOf(TinyfishSearchError);
		const typed = caught as TinyfishSearchError;
		expect(typed.status).toBe(429);
		expect(typed.name).toBe("TinyfishSearchError");
		expect(typed.message).toContain("429");
		expect(typed.message).toContain("slow down");
		expect(typed.message).not.toContain(baseConfig.apiKey as string);
	});

	it("keeps auth, payment and rate-limit statuses distinguishable", async () => {
		for (const status of [401, 402, 429, 500]) {
			stubFetch(() => jsonResponse({ message: "nope" }, status));
			let caught: unknown;
			try {
				await adapter.search(request(), baseConfig);
			} catch (error) {
				caught = error;
			}
			expect((caught as TinyfishSearchError).status).toBe(status);
		}
	});

	it("surfaces the API's missing-key code instead of the bare excerpt", async () => {
		stubFetch(() =>
			jsonResponse(
				{ code: TINYFISH_ERROR_STATUS_MISSING_KEY, message: "API key missed" },
				401,
			),
		);

		let caught: unknown;
		try {
			await adapter.search(request(), baseConfig);
		} catch (error) {
			caught = error;
		}

		expect(caught).toBeInstanceOf(TinyfishSearchError);
		expect((caught as TinyfishSearchError).code).toBe(
			TINYFISH_ERROR_STATUS_MISSING_KEY,
		);
		expect((caught as Error).message).toContain(
			TINYFISH_ERROR_STATUS_MISSING_KEY,
		);
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

		expect(caught).toBeInstanceOf(TinyfishSearchError);
		expect((caught as TinyfishSearchError).status).toBe(408);
	});

	it("refuses to call out without an API key", async () => {
		stubFetch(() => jsonResponse({ query: "hello world", results: [] }));

		await expect(
			adapter.search(request(), { ...baseConfig, apiKey: null }),
		).rejects.toThrow("requires an API key");
		expect(calls).toHaveLength(0);
	});
});

describe("tinyfish adapter — test()", () => {
	it("sends a minimal probe and reports ok with latency", async () => {
		stubFetch(() => jsonResponse({ query: "test", results: [] }));

		const result = await adapter.test(baseConfig);

		expect(result.ok).toBe(true);
		expect(result.error).toBeUndefined();
		expect(result.latencyMs).toBeGreaterThanOrEqual(0);
		expect(calls).toHaveLength(1);
		expect(headersOf(calls[0]).get("X-API-Key")).toBe(
			"tinyfish-canary-key-1234",
		);
		expect(searchParamsOf(calls[0]).get("query")).toBe(
			"better-ccflare connectivity test",
		);
	});

	it("returns ok:false on a server error without throwing", async () => {
		stubFetch(() => jsonResponse({ message: "kaput" }, 500));

		const result = await adapter.test(baseConfig);

		expect(result.ok).toBe(false);
		expect(result.error).toContain("500");
		expect(result.error).not.toContain(baseConfig.apiKey as string);
	});

	it("returns ok:false on an unexpected shape", async () => {
		stubFetch(() => jsonResponse({ organic: [] }));

		const result = await adapter.test(baseConfig);

		expect(result.ok).toBe(false);
		expect(result.error).toBe("unexpected response shape");
	});

	it("returns ok:false when no key is stored, with no outbound call", async () => {
		stubFetch(() => jsonResponse({ query: "test", results: [] }));

		const result = await adapter.test({ ...baseConfig, apiKey: null });

		expect(result.ok).toBe(false);
		expect(result.error).toBe("no API key configured");
		expect(calls).toHaveLength(0);
	});
});
