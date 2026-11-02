/**
 * Tests for the Brave Search adapter.
 *
 * `globalThis.fetch` is stubbed for every test — there are no real network
 * calls, and nothing here touches Anthropic.
 */
import { afterEach, describe, expect, it } from "bun:test";
import {
	BRAVE_SEARCH_URL,
	BraveSearchError,
	createBraveAdapter,
} from "../adapters/brave";
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

function paramsOf(call: CapturedCall): URLSearchParams {
	return new URL(call.url).searchParams;
}

function web(url: string): Record<string, unknown> {
	return {
		title: `t ${url}`,
		url,
		description: "d",
		profile: { name: "Example" },
	};
}

const adapter = createBraveAdapter();

const baseConfig: WebToolAdapterConfig = {
	apiKey: "brave-canary-token-9876",
	maxResults: 10,
	extraConfig: {},
};

function request(
	overrides: Partial<WebToolSearchRequest> = {},
): WebToolSearchRequest {
	return { query: "hello world", maxResults: 5, ...overrides };
}

describe("brave adapter — request shape", () => {
	it("GETs the documented URL with X-Subscription-Token auth and no body", async () => {
		stubFetch(() => jsonResponse({ web: { results: [] } }));

		await adapter.search(request(), baseConfig);

		expect(calls).toHaveLength(1);
		const [call] = calls;
		expect(call.url.startsWith(BRAVE_SEARCH_URL)).toBe(true);
		expect(call.init.method).toBe("GET");
		expect(call.init.body).toBeUndefined();
		// Brave uses X-Subscription-Token, not Bearer.
		expect(headersOf(call).get("X-Subscription-Token")).toBe(
			"brave-canary-token-9876",
		);
		expect(headersOf(call).get("Authorization")).toBeNull();
		expect(call.init.signal).toBeInstanceOf(AbortSignal);

		// Only q and count unless optional params are configured.
		expect([...paramsOf(call).keys()].sort()).toEqual(["count", "q"]);
		expect(paramsOf(call).get("q")).toBe("hello world");
		expect(paramsOf(call).get("count")).toBe("5");
	});

	it("clamps count to Brave's 0–20 range", async () => {
		stubFetch(() => jsonResponse({ web: { results: [] } }));
		const roomy = { ...baseConfig, maxResults: 500 };

		await adapter.search(request({ maxResults: 500 }), roomy);
		await adapter.search(request({ maxResults: -3 }), roomy);
		await adapter.search(request({ maxResults: 0 }), roomy);
		await adapter.search(request({ maxResults: Number.NaN }), roomy);

		expect(paramsOf(calls[0]).get("count")).toBe("20");
		expect(paramsOf(calls[1]).get("count")).toBe("0");
		expect(paramsOf(calls[2]).get("count")).toBe("0");
		expect(paramsOf(calls[3]).get("count")).toBe("10");
	});

	it("the provider's configured maxResults caps the search", async () => {
		stubFetch(() => jsonResponse({ web: { results: [] } }));
		const capped = { ...baseConfig, maxResults: 3 };

		await adapter.search(request({ maxResults: 10 }), capped);
		await adapter.search(request({ maxResults: 1 }), capped);

		expect(paramsOf(calls[0]).get("count")).toBe("3");
		expect(paramsOf(calls[1]).get("count")).toBe("1");
	});

	it("forwards country, search_lang and freshness only when configured", async () => {
		stubFetch(() => jsonResponse({ web: { results: [] } }));

		await adapter.search(request(), {
			...baseConfig,
			extraConfig: { country: "DE", searchLang: "de", freshness: "pw" },
		});
		await adapter.search(request(), baseConfig);

		const configured = paramsOf(calls[0]);
		expect(configured.get("country")).toBe("DE");
		expect(configured.get("search_lang")).toBe("de");
		expect(configured.get("freshness")).toBe("pw");

		const bare = paramsOf(calls[1]);
		expect(bare.has("country")).toBe(false);
		expect(bare.has("search_lang")).toBe(false);
		expect(bare.has("freshness")).toBe(false);
	});

	it("drops an unsupported freshness value rather than failing the request", async () => {
		stubFetch(() => jsonResponse({ web: { results: [] } }));

		await adapter.search(request(), {
			...baseConfig,
			extraConfig: { freshness: "yesterday" },
		});

		expect(paramsOf(calls[0]).has("freshness")).toBe(false);
	});

	it("url-encodes the query", async () => {
		stubFetch(() => jsonResponse({ web: { results: [] } }));

		await adapter.search(request({ query: "a & b = c" }), baseConfig);

		expect(calls[0].url).toContain("q=a+%26+b+%3D+c");
		expect(paramsOf(calls[0]).get("q")).toBe("a & b = c");
	});
});

describe("brave adapter — response mapping", () => {
	it("maps web.results entries onto the normalised hit shape", async () => {
		stubFetch(() =>
			jsonResponse({
				type: "search",
				web: {
					results: [
						{
							title: "First",
							url: "https://example.com/1",
							description: "a snippet",
							age: "2 days ago",
							page_age: "2026-01-02T00:00:00",
							extra_snippets: ["more", "text"],
						},
						{ title: "Age only", url: "https://example.com/2", age: "1h ago" },
						{ title: "No URL", description: "dropped" },
					],
				},
			}),
		);

		const hits = await adapter.search(request(), baseConfig);

		expect(hits).toEqual([
			{
				title: "First",
				url: "https://example.com/1",
				snippet: "a snippet",
				publishedDate: "2026-01-02T00:00:00",
			},
			{
				title: "Age only",
				url: "https://example.com/2",
				publishedDate: "1h ago",
			},
		]);
	});

	it("returns at most maxResults hits", async () => {
		stubFetch(() =>
			jsonResponse({
				web: {
					results: [
						web("https://example.com/a"),
						web("https://example.com/b"),
						web("https://example.com/c"),
					],
				},
			}),
		);

		const hits = await adapter.search(request({ maxResults: 2 }), baseConfig);

		expect(hits.map((hit) => hit.url)).toEqual([
			"https://example.com/a",
			"https://example.com/b",
		]);
	});

	it("returns [] when the web key is absent (documented no-results shape)", async () => {
		stubFetch(() => jsonResponse({ type: "web" }));

		expect(await adapter.search(request(), baseConfig)).toEqual([]);
	});

	it("throws when a web object carries no results array", async () => {
		// `web` present without `results` is malformed. Accepting it would
		// report a healthy empty search and stop the fallback chain.
		stubFetch(() => jsonResponse({ type: "web", web: {} }));

		await expect(adapter.search(request(), baseConfig)).rejects.toThrow(
			/results/,
		);
	});

	it("returns [] when the web key is absent entirely (Brave's no-results shape)", async () => {
		stubFetch(() => jsonResponse({ type: "web" }));

		expect(await adapter.search(request(), baseConfig)).toEqual([]);
	});

	it("keeps an explicit empty web.results array as a valid empty search", async () => {
		stubFetch(() => jsonResponse({ web: { results: [] } }));

		expect(await adapter.search(request(), baseConfig)).toEqual([]);
	});

	it("throws on a non-object payload", async () => {
		stubFetch(() => jsonResponse("nope"));

		await expect(adapter.search(request(), baseConfig)).rejects.toThrow(
			/not a JSON object/,
		);
	});

	it("throws when web is present but not an object", async () => {
		stubFetch(() => jsonResponse({ type: "web", web: [] }));

		await expect(adapter.search(request(), baseConfig)).rejects.toBeInstanceOf(
			BraveSearchError,
		);
	});

	it("throws when web.results is present but not an array", async () => {
		stubFetch(() => jsonResponse({ web: { results: "nope" } }));

		await expect(adapter.search(request(), baseConfig)).rejects.toThrow(
			/web.results array/,
		);
	});
});

describe("brave adapter — domain post-filtering", () => {
	const payload = {
		web: {
			results: [
				web("https://example.com/a"),
				web("https://www.example.com/b"),
				web("https://docs.example.com/c"),
				web("https://example.org/d"),
				web("https://notexample.com/e"),
			],
		},
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

	it("is required in the query string only for q and count", async () => {
		stubFetch(() => jsonResponse(payload));

		await adapter.search(
			request({ allowedDomains: ["example.com"] }),
			baseConfig,
		);

		expect([...paramsOf(calls[0]).keys()].sort()).toEqual(["count", "q"]);
	});
});

describe("brave adapter — errors", () => {
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

		expect(caught).toBeInstanceOf(BraveSearchError);
		const typed = caught as BraveSearchError;
		expect(typed.status).toBe(429);
		expect(typed.name).toBe("BraveSearchError");
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
			expect((caught as BraveSearchError).status).toBe(status);
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

		expect(caught).toBeInstanceOf(BraveSearchError);
		expect((caught as BraveSearchError).status).toBe(408);
	});

	it("wraps a transport failure without echoing the query", async () => {
		globalThis.fetch = (async () => {
			throw new Error("connection refused");
		}) as typeof fetch;

		let caught: unknown;
		try {
			await adapter.search(request({ query: "private query" }), baseConfig);
		} catch (error) {
			caught = error;
		}

		expect(caught).toBeInstanceOf(BraveSearchError);
		const typed = caught as BraveSearchError;
		expect(typed.message).toContain("connection refused");
		expect(typed.message).not.toContain("private query");
		expect(typed.message).not.toContain(baseConfig.apiKey as string);
	});

	it("refuses to call out without an API key", async () => {
		stubFetch(() => jsonResponse({ web: { results: [] } }));

		await expect(
			adapter.search(request(), { ...baseConfig, apiKey: null }),
		).rejects.toThrow("requires an API key");
		expect(calls).toHaveLength(0);
	});
});

describe("brave adapter — test()", () => {
	it("sends a minimal probe and reports ok with latency", async () => {
		stubFetch(() => jsonResponse({ web: { results: [] } }));

		const result = await adapter.test(baseConfig);

		expect(result.ok).toBe(true);
		expect(result.error).toBeUndefined();
		expect(result.latencyMs).toBeGreaterThanOrEqual(0);
		expect(calls).toHaveLength(1);
		expect(calls[0].init.method).toBe("GET");
		expect(headersOf(calls[0]).get("X-Subscription-Token")).toBe(
			"brave-canary-token-9876",
		);
		expect(paramsOf(calls[0]).get("q")).toBe(
			"better-ccflare connectivity test",
		);
		expect(paramsOf(calls[0]).get("count")).toBe("1");
	});

	it("treats a no-results payload as ok", async () => {
		stubFetch(() => jsonResponse({ type: "web" }));

		expect((await adapter.test(baseConfig)).ok).toBe(true);
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

	it("returns ok:false on a transport failure without throwing", async () => {
		globalThis.fetch = (async () => {
			throw new Error("dns");
		}) as typeof fetch;

		const result = await adapter.test(baseConfig);

		expect(result.ok).toBe(false);
		expect(result.error).toContain("dns");
	});

	it("returns ok:false when no key is stored, with no outbound call", async () => {
		stubFetch(() => jsonResponse({ web: { results: [] } }));

		const result = await adapter.test({ ...baseConfig, apiKey: null });

		expect(result.ok).toBe(false);
		expect(result.error).toBe("no API key configured");
		expect(calls).toHaveLength(0);
	});
});

describe("brave adapter — safesearch", () => {
	// The dashboard offers off/moderate/strict; without forwarding it the
	// operator's saved choice silently had no effect on real searches.
	for (const value of ["off", "moderate", "strict"]) {
		it(`forwards safesearch=${value}`, async () => {
			stubFetch(() => jsonResponse({ web: { results: [] } }));

			await adapter.search(request(), {
				...baseConfig,
				extraConfig: { safesearch: value },
			});

			const url = new URL(calls[0].url);
			expect(url.searchParams.get("safesearch")).toBe(value);
		});
	}

	it("drops an unsupported safesearch value rather than sending it", async () => {
		stubFetch(() => jsonResponse({ web: { results: [] } }));

		await adapter.search(request(), {
			...baseConfig,
			extraConfig: { safesearch: "paranoid" },
		});

		expect(new URL(calls[0].url).searchParams.has("safesearch")).toBe(false);
	});
});
