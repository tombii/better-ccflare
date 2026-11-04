/**
 * Tests for the Firecrawl adapter.
 *
 * `globalThis.fetch` is stubbed for every test — there are no real network
 * calls, and nothing here touches Anthropic.
 */
import { afterEach, describe, expect, it } from "bun:test";
import {
	createFirecrawlAdapter,
	FIRECRAWL_SEARCH_URL,
	FirecrawlSearchError,
} from "../adapters/firecrawl";
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

function entry(url: string): Record<string, unknown> {
	return { title: `t ${url}`, description: "s", url };
}

const adapter = createFirecrawlAdapter();

const keyedConfig: WebToolAdapterConfig = {
	apiKey: "firecrawl-canary-key-5678",
	maxResults: 10,
	extraConfig: {},
};

const keylessConfig: WebToolAdapterConfig = {
	apiKey: null,
	maxResults: 10,
	extraConfig: {},
};

function request(
	overrides: Partial<WebToolSearchRequest> = {},
): WebToolSearchRequest {
	return { query: "hello world", maxResults: 5, ...overrides };
}

describe("firecrawl adapter — request shape", () => {
	it("posts to the documented URL with limit and JSON content type", async () => {
		stubFetch(() => jsonResponse({ success: true, data: [] }));

		await adapter.search(request(), keyedConfig);

		expect(calls).toHaveLength(1);
		const [call] = calls;
		expect(call.url).toBe(FIRECRAWL_SEARCH_URL);
		expect(call.init.method).toBe("POST");
		expect(headersOf(call).get("Content-Type")).toBe("application/json");
		expect(call.init.signal).toBeInstanceOf(AbortSignal);

		expect(bodyOf(call)).toEqual({ query: "hello world", limit: 5 });
	});

	it("sends no scrapeOptions by default (lightweight title/url/description only)", async () => {
		stubFetch(() => jsonResponse({ success: true, data: [] }));

		await adapter.search(request(), keyedConfig);

		expect(bodyOf(calls[0])).not.toHaveProperty("scrapeOptions");
	});

	it("sends the Bearer header when a key is stored", async () => {
		stubFetch(() => jsonResponse({ success: true, data: [] }));

		await adapter.search(request(), keyedConfig);

		expect(headersOf(calls[0]).get("Authorization")).toBe(
			"Bearer firecrawl-canary-key-5678",
		);
	});

	it("calls keyless (no Authorization header) when no key is stored", async () => {
		stubFetch(() => jsonResponse({ success: true, data: { web: [] } }));

		await adapter.search(request(), keylessConfig);

		expect(calls).toHaveLength(1);
		expect(headersOf(calls[0]).has("Authorization")).toBe(false);
		expect(headersOf(calls[0]).get("Content-Type")).toBe("application/json");
		expect(bodyOf(calls[0])).toEqual({ query: "hello world", limit: 5 });
	});

	it("forwards location and tbs only when configured", async () => {
		stubFetch(() => jsonResponse({ success: true, data: [] }));

		await adapter.search(request(), {
			...keyedConfig,
			extraConfig: { location: "Germany", tbs: "qdr:d" },
		});
		await adapter.search(request(), keyedConfig);

		expect(bodyOf(calls[0])).toEqual({
			query: "hello world",
			limit: 5,
			location: "Germany",
			tbs: "qdr:d",
		});
		expect(bodyOf(calls[1])).toEqual({ query: "hello world", limit: 5 });
	});
});

describe("firecrawl adapter — response mapping", () => {
	it("maps data entries onto the normalised hit shape", async () => {
		stubFetch(() =>
			jsonResponse({
				success: true,
				data: [
					{
						title: "First",
						description: "a snippet",
						url: "https://example.com/1",
					},
					{ title: "No url", description: "dropped" },
					{ url: "https://example.com/3" },
					{ title: "Empty url", url: "", description: "dropped" },
				],
				id: "search-1",
			}),
		);

		const hits = await adapter.search(request(), keyedConfig);

		expect(hits).toEqual([
			{
				title: "First",
				url: "https://example.com/1",
				snippet: "a snippet",
			},
			{ title: "", url: "https://example.com/3" },
		]);
	});

	it("maps v2 data.web entries", async () => {
		stubFetch(() =>
			jsonResponse({
				success: true,
				data: { web: [entry("https://example.com/a")] },
			}),
		);

		const hits = await adapter.search(request(), keylessConfig);

		expect(hits).toEqual([
			{
				title: "t https://example.com/a",
				url: "https://example.com/a",
				snippet: "s",
			},
		]);
	});

	it("surfaces a keyless 403 (IP gate) as the error message", async () => {
		stubFetch(() =>
			jsonResponse(
				{
					success: false,
					error:
						"Unfortunately, your IP address looks like a VPN or proxy, so Firecrawl can't be used without an API key from here.",
				},
				403,
			),
		);

		await expect(adapter.search(request(), keylessConfig)).rejects.toThrow(
			/looks like a VPN or proxy/,
		);
		expect(calls).toHaveLength(1);
	});

	it("returns at most maxResults hits", async () => {
		stubFetch(() =>
			jsonResponse({
				success: true,
				data: [
					entry("https://example.com/a"),
					entry("https://example.com/b"),
					entry("https://example.com/c"),
				],
			}),
		);

		const hits = await adapter.search(request({ maxResults: 2 }), keyedConfig);

		expect(hits.map((hit) => hit.url)).toEqual([
			"https://example.com/a",
			"https://example.com/b",
		]);
	});

	it("the provider's configured maxResults caps the search", async () => {
		stubFetch(() =>
			jsonResponse({
				success: true,
				data: [
					entry("https://example.com/a"),
					entry("https://example.com/b"),
					entry("https://example.com/c"),
				],
			}),
		);
		const capped = { ...keyedConfig, maxResults: 1 };

		const hits = await adapter.search(request({ maxResults: 10 }), capped);

		expect(hits.map((hit) => hit.url)).toEqual(["https://example.com/a"]);
	});

	it("throws when success is false, surfacing the API's error", async () => {
		stubFetch(() =>
			jsonResponse({ success: false, error: "rate limit exceeded" }),
		);

		await expect(adapter.search(request(), keyedConfig)).rejects.toThrow(
			/rate limit exceeded/,
		);
	});

	it("throws when the payload has no data array", async () => {
		stubFetch(() => jsonResponse({ success: true, results: [] }));

		await expect(adapter.search(request(), keyedConfig)).rejects.toThrow(
			/data array/,
		);
	});

	it("throws on a non-object payload", async () => {
		stubFetch(() => jsonResponse(null));

		await expect(adapter.search(request(), keyedConfig)).rejects.toBeInstanceOf(
			FirecrawlSearchError,
		);
	});

	it("keeps an explicit empty data array as a valid empty search", async () => {
		stubFetch(() => jsonResponse({ success: true, data: [] }));

		expect(await adapter.search(request(), keyedConfig)).toEqual([]);
	});
});

describe("firecrawl adapter — domain post-filtering", () => {
	const payload = {
		success: true,
		data: [
			entry("https://example.com/a"),
			entry("https://www.example.com/b"),
			entry("https://docs.example.com/c"),
			entry("https://example.org/d"),
			entry("https://notexample.com/e"),
		],
	};

	it("keeps only allowlisted hosts, matching subdomains too", async () => {
		stubFetch(() => jsonResponse(payload));

		const hits = await adapter.search(
			request({ allowedDomains: ["example.com"] }),
			keyedConfig,
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
			keyedConfig,
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
			keyedConfig,
		);

		expect(hits).toHaveLength(3);
	});
});

describe("firecrawl adapter — errors", () => {
	it("throws a typed error carrying the HTTP status without the key", async () => {
		stubFetch(() => jsonResponse({ error: "too many requests" }, 429));

		let caught: unknown;
		try {
			await adapter.search(request(), keyedConfig);
		} catch (error) {
			caught = error;
		}

		expect(caught).toBeInstanceOf(FirecrawlSearchError);
		const typed = caught as FirecrawlSearchError;
		expect(typed.status).toBe(429);
		expect(typed.name).toBe("FirecrawlSearchError");
		expect(typed.message).toContain("429");
		expect(typed.message).toContain("too many requests");
		expect(typed.message).not.toContain(keyedConfig.apiKey as string);
	});

	it("keeps auth, payment and rate-limit statuses distinguishable", async () => {
		for (const status of [401, 402, 429, 500]) {
			stubFetch(() => jsonResponse({ error: "nope" }, status));
			let caught: unknown;
			try {
				await adapter.search(request(), keyedConfig);
			} catch (error) {
				caught = error;
			}
			expect((caught as FirecrawlSearchError).status).toBe(status);
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
				keyedConfig,
			);
		} catch (error) {
			caught = error;
		}

		expect(caught).toBeInstanceOf(FirecrawlSearchError);
		expect((caught as FirecrawlSearchError).status).toBe(408);
	});
});

describe("firecrawl adapter — test()", () => {
	it("sends a minimal probe and reports ok with latency", async () => {
		stubFetch(() => jsonResponse({ success: true, data: [] }));

		const result = await adapter.test(keyedConfig);

		expect(result.ok).toBe(true);
		expect(result.error).toBeUndefined();
		expect(result.latencyMs).toBeGreaterThanOrEqual(0);
		expect(calls).toHaveLength(1);
		expect(headersOf(calls[0]).get("Authorization")).toBe(
			"Bearer firecrawl-canary-key-5678",
		);
		expect(bodyOf(calls[0])).toEqual({
			query: "better-ccflare connectivity test",
			limit: 1,
		});
	});

	it("tests the keyless endpoint when no key is stored", async () => {
		stubFetch(() => jsonResponse({ success: true, data: { web: [] } }));

		const result = await adapter.test(keylessConfig);

		expect(result.ok).toBe(true);
		expect(calls).toHaveLength(1);
		expect(headersOf(calls[0]).has("Authorization")).toBe(false);
	});

	it("returns ok:false on a server error without throwing", async () => {
		stubFetch(() => jsonResponse({ error: "kaput" }, 500));

		const result = await adapter.test(keyedConfig);

		expect(result.ok).toBe(false);
		expect(result.error).toContain("500");
		expect(result.error).not.toContain(keyedConfig.apiKey as string);
	});

	it("returns ok:false on success:false with the API's error", async () => {
		stubFetch(() => jsonResponse({ success: false, error: "bad query" }));

		const result = await adapter.test(keyedConfig);

		expect(result.ok).toBe(false);
		expect(result.error).toContain("bad query");
	});

	it("returns ok:false on an unexpected shape", async () => {
		stubFetch(() => jsonResponse({ success: true, results: [] }));

		const result = await adapter.test(keyedConfig);

		expect(result.ok).toBe(false);
		expect(result.error).toBe("unexpected response shape");
	});
});
