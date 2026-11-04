/**
 * Tests for the Keenable adapter.
 *
 * `globalThis.fetch` is stubbed for every test — there are no real network
 * calls, and nothing here touches Anthropic.
 */
import { afterEach, describe, expect, it } from "bun:test";
import {
	createKeenableAdapter,
	KEENABLE_KEYLESS_SEARCH_URL,
	KEENABLE_SEARCH_URL,
	KeenableSearchError,
} from "../adapters/keenable";
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

function hit(url: string, extra: Record<string, unknown> = {}) {
	return { title: `t ${url}`, url, snippet: `s ${url}`, ...extra };
}

const adapter = createKeenableAdapter();

const keyedConfig: WebToolAdapterConfig = {
	apiKey: "keen-canary-key-5678",
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

describe("keenable adapter — request shape", () => {
	it("posts to the documented URL with max_results and JSON content type", async () => {
		stubFetch(() => jsonResponse({ query: "hello world", results: [] }));

		await adapter.search(request(), keyedConfig);

		expect(calls).toHaveLength(1);
		const [call] = calls;
		expect(call.url).toBe(KEENABLE_SEARCH_URL);
		expect(call.init.method).toBe("POST");
		expect(headersOf(call).get("Content-Type")).toBe("application/json");
		expect(call.init.signal).toBeInstanceOf(AbortSignal);

		expect(bodyOf(call)).toEqual({ query: "hello world", max_results: 5 });
	});

	it("authenticates with X-API-Key, never a query string", async () => {
		stubFetch(() => jsonResponse({ query: "hello world", results: [] }));

		await adapter.search(request(), keyedConfig);

		expect(headersOf(calls[0]).get("X-API-Key")).toBe("keen-canary-key-5678");
		expect(calls[0].url).not.toContain("keen-canary-key-5678");
	});

	it("calls the public endpoint with the app-id header when no key is stored", async () => {
		stubFetch(() => jsonResponse({ query: "hello world", results: [] }));

		await adapter.search(request(), keylessConfig);

		expect(calls).toHaveLength(1);
		const headers = new Headers(calls[0].init.headers as HeadersInit);
		expect(calls[0].url).toBe(KEENABLE_KEYLESS_SEARCH_URL);
		expect(headers.get("X-Keenable-Title")).toBe("better-ccflare");
		expect(headers.has("X-API-Key")).toBe(false);
	});

	it("forwards mode, site and date filters only when configured", async () => {
		stubFetch(() => jsonResponse({ query: "hello world", results: [] }));

		await adapter.search(request(), {
			...keyedConfig,
			extraConfig: {
				mode: "realtime",
				site: "example.com",
				published_after: "7d",
				acquired_before: "2026-01-01",
			},
		});
		await adapter.search(request(), keyedConfig);

		expect(bodyOf(calls[0])).toEqual({
			query: "hello world",
			max_results: 5,
			mode: "realtime",
			site: "example.com",
			published_after: "7d",
			acquired_before: "2026-01-01",
		});
		expect(bodyOf(calls[1])).toEqual({ query: "hello world", max_results: 5 });
	});

	it("ignores a mode the API does not define", async () => {
		stubFetch(() => jsonResponse({ query: "hello world", results: [] }));

		await adapter.search(request(), {
			...keyedConfig,
			extraConfig: { mode: "turbo" },
		});

		expect(bodyOf(calls[0])).not.toHaveProperty("mode");
	});

	it("forwards snippet_max_length when configured", async () => {
		stubFetch(() => jsonResponse({ query: "hello world", results: [] }));

		await adapter.search(request(), {
			...keyedConfig,
			extraConfig: { snippet_max_length: 400 },
		});

		expect(bodyOf(calls[0]).snippet_max_length).toBe(400);
	});

	it("never sends a max_results outside the API's 1-50 range", async () => {
		stubFetch(() => jsonResponse({ query: "hello world", results: [] }));

		await adapter.search(request({ maxResults: 0 }), keyedConfig);
		await adapter.search(request({ maxResults: 500 }), {
			...keyedConfig,
			maxResults: 500,
		});
		await adapter.search(request({ maxResults: Number.NaN }), keyedConfig);

		expect(bodyOf(calls[0]).max_results).toBe(1);
		expect(bodyOf(calls[1]).max_results).toBe(50);
		// A non-finite request count falls back to the adapter default (10);
		// `Math.min(10, 10)` keeps it at the default.
		expect(bodyOf(calls[2]).max_results).toBe(10);
	});
});

describe("keenable adapter — response mapping", () => {
	it("maps results onto the normalised hit shape", async () => {
		stubFetch(() =>
			jsonResponse({
				query: "hello world",
				mode: "pro",
				results: [
					{
						title: "Example",
						url: "https://example.com/a",
						description: "",
						snippet: "a snippet",
						published_at: "2026-01-15T10:30:00Z",
						acquired_at: "2026-01-16T08:12:34Z",
					},
				],
			}),
		);

		const hits = await adapter.search(request(), keyedConfig);

		expect(hits).toEqual([
			{
				title: "Example",
				url: "https://example.com/a",
				snippet: "a snippet",
				publishedDate: "2026-01-15T10:30:00Z",
			},
		]);
	});

	it("reads snippet, not the deprecated description field", async () => {
		stubFetch(() =>
			jsonResponse({
				query: "q",
				results: [hit("https://example.com/a", { description: "legacy" })],
			}),
		);

		const [first] = await adapter.search(request(), keyedConfig);

		expect(first.snippet).toBe("s https://example.com/a");
	});

	it("omits snippet and date when the provider leaves them out", async () => {
		stubFetch(() =>
			jsonResponse({
				query: "q",
				results: [{ title: "T", url: "https://example.com/a" }],
			}),
		);

		const [first] = await adapter.search(request(), keyedConfig);

		expect(first).toEqual({ title: "T", url: "https://example.com/a" });
	});

	it("drops entries without a URL and keeps empty titles", async () => {
		stubFetch(() =>
			jsonResponse({
				query: "q",
				results: [
					{ title: "no url", snippet: "x" },
					{ title: "", url: "https://example.com/b" },
					"not-an-object",
				],
			}),
		);

		const hits = await adapter.search(request(), keyedConfig);

		expect(hits).toEqual([{ title: "", url: "https://example.com/b" }]);
	});

	it("returns at most the requested number of hits", async () => {
		stubFetch(() =>
			jsonResponse({
				query: "q",
				results: Array.from({ length: 10 }, (_, i) =>
					hit(`https://example.com/${i}`),
				),
			}),
		);

		const hits = await adapter.search(request({ maxResults: 3 }), keyedConfig);

		expect(hits).toHaveLength(3);
	});

	it("the provider's configured maxResults caps the search", async () => {
		stubFetch(() =>
			jsonResponse({
				query: "q",
				results: Array.from({ length: 10 }, (_, i) =>
					hit(`https://example.com/${i}`),
				),
			}),
		);

		const hits = await adapter.search(request({ maxResults: 10 }), {
			...keyedConfig,
			maxResults: 2,
		});

		expect(hits).toHaveLength(2);
		expect(bodyOf(calls[0]).max_results).toBe(2);
	});

	it("keeps an explicit empty results array as a valid empty search", async () => {
		stubFetch(() => jsonResponse({ query: "q", results: [] }));

		await expect(adapter.search(request(), keyedConfig)).resolves.toEqual([]);
	});

	it("throws when the results array is missing", async () => {
		stubFetch(() => jsonResponse({ query: "q" }));

		await expect(adapter.search(request(), keyedConfig)).rejects.toThrow(
			/missing the results array/,
		);
	});

	it("throws on a non-object payload", async () => {
		stubFetch(() => jsonResponse([1, 2, 3]));

		await expect(adapter.search(request(), keyedConfig)).rejects.toThrow(
			/not a JSON object/,
		);
	});
});

describe("keenable adapter — domain post-filtering", () => {
	const multi = {
		query: "q",
		results: [
			hit("https://docs.example.com/a"),
			hit("https://example.com/b"),
			hit("https://other.com/c"),
			hit("https://news.example.org/d"),
		],
	};

	it("keeps only allowlisted hosts, matching subdomains too", async () => {
		stubFetch(() => jsonResponse(multi));

		const hits = await adapter.search(
			request({ allowedDomains: ["example.com"] }),
			keyedConfig,
		);

		expect(hits.map((h) => h.url)).toEqual([
			"https://docs.example.com/a",
			"https://example.com/b",
		]);
	});

	it("drops blocked hosts and their subdomains", async () => {
		stubFetch(() => jsonResponse(multi));

		const hits = await adapter.search(
			request({ blockedDomains: ["example.com"] }),
			keyedConfig,
		);

		expect(hits.map((h) => h.url)).toEqual([
			"https://other.com/c",
			"https://news.example.org/d",
		]);
	});

	it("prefers the allowlist and ignores the blocklist when both are set", async () => {
		stubFetch(() => jsonResponse(multi));

		const hits = await adapter.search(
			request({
				allowedDomains: ["example.org"],
				blockedDomains: ["example.org"],
			}),
			keyedConfig,
		);

		expect(hits.map((h) => h.url)).toEqual(["https://news.example.org/d"]);
	});

	it("collapses a single allowlist domain into the site parameter", async () => {
		stubFetch(() => jsonResponse(multi));

		await adapter.search(
			request({ allowedDomains: ["example.org"] }),
			keyedConfig,
		);

		expect(bodyOf(calls[0]).site).toBe("example.org");
	});

	it("does not send site for a multi-domain allowlist", async () => {
		stubFetch(() => jsonResponse(multi));

		await adapter.search(
			request({ allowedDomains: ["example.com", "example.org"] }),
			keyedConfig,
		);

		expect(bodyOf(calls[0])).not.toHaveProperty("site");
	});
});

describe("keenable adapter — errors", () => {
	it("throws a typed error carrying the HTTP status without the key", async () => {
		stubFetch(() =>
			jsonResponse({ error: "Rate limit", message: "slow down" }, 429),
		);

		const error = await adapter.search(request(), keyedConfig).catch((e) => e);

		expect(error).toBeInstanceOf(KeenableSearchError);
		expect(((error as KeenableSearchError).status as number) | 0).toBe(429);
		expect((error as Error).message).toContain("429");
		expect((error as Error).message).toContain("slow down");
		expect((error as Error).message).not.toContain("keen-canary-key-5678");
	});

	it("keeps auth, payment and rate-limit statuses distinguishable", async () => {
		for (const status of [401, 402, 429]) {
			stubFetch(() => jsonResponse({ error: "e" }, status));
			const error = await adapter
				.search(request(), keyedConfig)
				.catch((e) => e);
			expect((error as KeenableSearchError).status).toBe(status);
		}
	});

	it("surfaces an abort as a status-408 error", async () => {
		stubFetch(() => {
			throw new DOMException("aborted", "AbortError");
		});

		const error = await adapter.search(request(), keyedConfig).catch((e) => e);

		expect(error).toBeInstanceOf(KeenableSearchError);
		expect((error as KeenableSearchError).status).toBe(408);
	});

	it("rethrows a non-abort transport error unchanged", async () => {
		stubFetch(() => {
			throw new TypeError("network down");
		});

		await expect(adapter.search(request(), keyedConfig)).rejects.toThrow(
			"network down",
		);
	});
});

describe("keenable adapter — test()", () => {
	it("sends a minimal probe and reports ok with latency", async () => {
		stubFetch(() =>
			jsonResponse({ query: "q", results: [hit("https://a.b")] }),
		);

		const result = await adapter.test(keyedConfig);

		expect(result.ok).toBe(true);
		expect(result.latencyMs).toBeGreaterThanOrEqual(0);
		expect(bodyOf(calls[0]).max_results).toBe(1);
	});

	it("sends the saved settings so Test exercises the real search path", async () => {
		stubFetch(() =>
			jsonResponse({ query: "q", results: [hit("https://a.b")] }),
		);

		const result = await adapter.test({
			...keyedConfig,
			maxResults: 50,
			extraConfig: {
				mode: "realtime",
				site: "example.com",
				published_after: "7d",
				acquired_before: "2026-01-01",
				snippet_max_length: 400,
			},
		});

		expect(result.ok).toBe(true);
		// `maxResults` is the provider cap; the probe asks for one result, so
		// the cap must not leak into the probe body.
		expect(bodyOf(calls[0])).toEqual({
			query: "better-ccflare connectivity test",
			max_results: 1,
			mode: "realtime",
			site: "example.com",
			published_after: "7d",
			acquired_before: "2026-01-01",
			snippet_max_length: 400,
		});
	});

	it("tests the public endpoint when no key is stored", async () => {
		stubFetch(() => jsonResponse({ query: "q", results: [] }));

		const result = await adapter.test(keylessConfig);

		expect(result.ok).toBe(true);
		expect(calls).toHaveLength(1);
		expect(calls[0].url).toBe(KEENABLE_KEYLESS_SEARCH_URL);
	});

	it("returns ok:false on a server error without throwing", async () => {
		stubFetch(() => jsonResponse({ error: "boom" }, 500));

		const result = await adapter.test(keyedConfig);

		expect(result.ok).toBe(false);
		expect(result.error).toContain("500");
	});

	it("returns ok:false on an unexpected shape", async () => {
		stubFetch(() => jsonResponse({ nope: true }));

		const result = await adapter.test(keyedConfig);

		expect(result.ok).toBe(false);
		expect(result.error).toBeTruthy();
	});
});
