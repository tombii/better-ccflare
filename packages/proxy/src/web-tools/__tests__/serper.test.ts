/**
 * Tests for the Serper adapter.
 *
 * `globalThis.fetch` is stubbed for every test — there are no real network
 * calls, and nothing here touches Anthropic.
 */
import { afterEach, describe, expect, it } from "bun:test";
import {
	createSerperAdapter,
	SERPER_SEARCH_URL,
	SerperSearchError,
} from "../adapters/serper";
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

function organic(url: string): Record<string, unknown> {
	return { title: `t ${url}`, link: url, snippet: "s", position: 1 };
}

const adapter = createSerperAdapter();

const baseConfig: WebToolAdapterConfig = {
	apiKey: "serper-canary-key-4321",
	maxResults: 10,
	extraConfig: {},
};

function request(
	overrides: Partial<WebToolSearchRequest> = {},
): WebToolSearchRequest {
	return { query: "hello world", maxResults: 5, ...overrides };
}

describe("serper adapter — request shape", () => {
	it("posts to the documented URL with X-API-KEY auth and the base body", async () => {
		stubFetch(() => jsonResponse({ organic: [] }));

		await adapter.search(request(), baseConfig);

		expect(calls).toHaveLength(1);
		const [call] = calls;
		expect(call.url).toBe(SERPER_SEARCH_URL);
		expect(call.init.method).toBe("POST");
		// Serper uses X-API-KEY, not Bearer.
		expect(headersOf(call).get("X-API-KEY")).toBe("serper-canary-key-4321");
		expect(headersOf(call).get("Authorization")).toBeNull();
		expect(headersOf(call).get("Content-Type")).toBe("application/json");
		expect(call.init.signal).toBeInstanceOf(AbortSignal);

		expect(bodyOf(call)).toEqual({ q: "hello world", num: 5 });
	});

	it("clamps num to Serper's 0–100 range", async () => {
		stubFetch(() => jsonResponse({ organic: [] }));
		const roomy = { ...baseConfig, maxResults: 500 };

		await adapter.search(request({ maxResults: 500 }), roomy);
		await adapter.search(request({ maxResults: -3 }), roomy);
		await adapter.search(request({ maxResults: 0 }), roomy);
		await adapter.search(request({ maxResults: Number.NaN }), roomy);

		expect(bodyOf(calls[0]).num).toBe(100);
		expect(bodyOf(calls[1]).num).toBe(0);
		expect(bodyOf(calls[2]).num).toBe(0);
		expect(bodyOf(calls[3]).num).toBe(10);
	});

	it("the provider's configured maxResults caps the search", async () => {
		stubFetch(() => jsonResponse({ organic: [] }));
		const capped = { ...baseConfig, maxResults: 3 };

		await adapter.search(request({ maxResults: 10 }), capped);
		await adapter.search(request({ maxResults: 1 }), capped);

		expect(bodyOf(calls[0]).num).toBe(3);
		expect(bodyOf(calls[1]).num).toBe(1);
	});

	it("forwards gl, hl and tbs only when configured", async () => {
		stubFetch(() => jsonResponse({ organic: [] }));

		await adapter.search(request(), {
			...baseConfig,
			extraConfig: { gl: "de", hl: "de", tbs: "qdr:d" },
		});
		await adapter.search(request(), baseConfig);

		expect(bodyOf(calls[0])).toEqual({
			q: "hello world",
			num: 5,
			gl: "de",
			hl: "de",
			tbs: "qdr:d",
		});
		expect(bodyOf(calls[1])).toEqual({ q: "hello world", num: 5 });
	});
});

describe("serper adapter — response mapping", () => {
	it("maps organic entries onto the normalised hit shape", async () => {
		stubFetch(() =>
			jsonResponse({
				organic: [
					{
						title: "First",
						link: "https://example.com/1",
						snippet: "a snippet",
						date: "Jan 2, 2026",
						position: 1,
					},
					{ title: "No link", snippet: "dropped" },
					{ link: "https://example.com/3" },
					{ title: "Empty link", link: "", snippet: "dropped" },
				],
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
				organic: [
					organic("https://example.com/a"),
					organic("https://example.com/b"),
					organic("https://example.com/c"),
				],
			}),
		);

		const hits = await adapter.search(request({ maxResults: 2 }), baseConfig);

		expect(hits.map((hit) => hit.url)).toEqual([
			"https://example.com/a",
			"https://example.com/b",
		]);
	});

	it("throws when the payload has no organic array (results is not it)", async () => {
		stubFetch(() => jsonResponse({ results: [{ link: "https://x.com" }] }));

		await expect(adapter.search(request(), baseConfig)).rejects.toThrow(
			/organic results array/,
		);
	});

	it("throws on a non-object payload", async () => {
		stubFetch(() => jsonResponse(null));

		await expect(adapter.search(request(), baseConfig)).rejects.toBeInstanceOf(
			SerperSearchError,
		);
	});

	it("keeps an explicit empty organic array as a valid empty search", async () => {
		stubFetch(() => jsonResponse({ organic: [] }));

		expect(await adapter.search(request(), baseConfig)).toEqual([]);
	});
});

describe("serper adapter — domain post-filtering", () => {
	const payload = {
		organic: [
			organic("https://example.com/a"),
			organic("https://www.example.com/b"),
			organic("https://docs.example.com/c"),
			organic("https://example.org/d"),
			organic("https://notexample.com/e"),
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

	it("matches domains case-insensitively", async () => {
		stubFetch(() => jsonResponse(payload));

		const hits = await adapter.search(
			request({ allowedDomains: ["EXAMPLE.COM"] }),
			baseConfig,
		);

		expect(hits).toHaveLength(3);
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

	it("does not send domain filters to Serper in the body", async () => {
		stubFetch(() => jsonResponse(payload));

		await adapter.search(
			request({
				allowedDomains: ["example.com"],
				blockedDomains: ["example.org"],
			}),
			baseConfig,
		);

		expect(bodyOf(calls[0])).toEqual({ q: "hello world", num: 5 });
	});
});

describe("serper adapter — errors", () => {
	it("throws a typed error carrying the HTTP status", async () => {
		stubFetch(() =>
			jsonResponse({ message: "you are searching too fast" }, 429),
		);

		let caught: unknown;
		try {
			await adapter.search(request(), baseConfig);
		} catch (error) {
			caught = error;
		}

		expect(caught).toBeInstanceOf(SerperSearchError);
		const typed = caught as SerperSearchError;
		expect(typed.status).toBe(429);
		expect(typed.name).toBe("SerperSearchError");
		expect(typed.message).toContain("429");
		expect(typed.message).toContain("searching too fast");
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
			expect((caught as SerperSearchError).status).toBe(status);
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

		expect(caught).toBeInstanceOf(SerperSearchError);
		expect((caught as SerperSearchError).status).toBe(408);
	});

	it("refuses to call out without an API key", async () => {
		stubFetch(() => jsonResponse({ organic: [] }));

		await expect(
			adapter.search(request(), { ...baseConfig, apiKey: null }),
		).rejects.toThrow("requires an API key");
		expect(calls).toHaveLength(0);
	});
});

describe("serper adapter — test()", () => {
	it("sends a minimal probe and reports ok with latency", async () => {
		stubFetch(() => jsonResponse({ organic: [] }));

		const result = await adapter.test(baseConfig);

		expect(result.ok).toBe(true);
		expect(result.error).toBeUndefined();
		expect(result.latencyMs).toBeGreaterThanOrEqual(0);
		expect(calls).toHaveLength(1);
		expect(headersOf(calls[0]).get("X-API-KEY")).toBe("serper-canary-key-4321");
		expect(bodyOf(calls[0])).toEqual({
			q: "better-ccflare connectivity test",
			num: 1,
		});
	});

	it("returns ok:false on a server error without throwing", async () => {
		stubFetch(() => jsonResponse({ message: "kaput" }, 500));

		const result = await adapter.test(baseConfig);

		expect(result.ok).toBe(false);
		expect(result.error).toContain("500");
		expect(result.error).not.toContain(baseConfig.apiKey as string);
	});

	it("returns ok:false on an unexpected shape", async () => {
		stubFetch(() => jsonResponse({ results: [] }));

		const result = await adapter.test(baseConfig);

		expect(result.ok).toBe(false);
		expect(result.error).toBe("unexpected response shape");
	});

	it("returns ok:false when no key is stored, with no outbound call", async () => {
		stubFetch(() => jsonResponse({ organic: [] }));

		const result = await adapter.test({ ...baseConfig, apiKey: null });

		expect(result.ok).toBe(false);
		expect(result.error).toBe("no API key configured");
		expect(calls).toHaveLength(0);
	});
});
