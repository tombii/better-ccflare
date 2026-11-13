/**
 * Tests for the Linkup adapter.
 *
 * `globalThis.fetch` is stubbed for every test — there are no real network
 * calls, and nothing here touches Anthropic.
 */
import { afterEach, describe, expect, it } from "bun:test";
import {
	createLinkupAdapter,
	LINKUP_SEARCH_URL,
	LinkupSearchError,
} from "../adapters/linkup";
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
	return { name: `t ${url}`, url, content: "c", type: "text" };
}

const adapter = createLinkupAdapter();

const keyedConfig: WebToolAdapterConfig = {
	apiKey: "linkup-canary-key-8765",
	maxResults: 10,
	extraConfig: {},
};

function request(
	overrides: Partial<WebToolSearchRequest> = {},
): WebToolSearchRequest {
	return { query: "hello world", maxResults: 5, ...overrides };
}

describe("linkup adapter — request shape", () => {
	it("posts to the documented URL with bearer auth and the base body", async () => {
		stubFetch(() => jsonResponse({ results: [] }));

		await adapter.search(request(), keyedConfig);

		expect(calls).toHaveLength(1);
		const [call] = calls;
		expect(call.url).toBe(LINKUP_SEARCH_URL);
		expect(call.init.method).toBe("POST");
		expect(headersOf(call).get("Authorization")).toBe(
			"Bearer linkup-canary-key-8765",
		);
		expect(headersOf(call).get("Content-Type")).toBe("application/json");
		expect(call.init.signal).toBeInstanceOf(AbortSignal);

		// `outputType` is mandatory and always sent; `depth` defaults to standard.
		expect(bodyOf(call)).toEqual({
			q: "hello world",
			depth: "standard",
			outputType: "searchResults",
			maxResults: 5,
		});
	});

	it("forwards a configured depth and ignores unsupported values", async () => {
		stubFetch(() => jsonResponse({ results: [] }));

		for (const depth of ["flash", "fast", "standard", "deep"]) {
			await adapter.search(request(), {
				...keyedConfig,
				extraConfig: { depth },
			});
		}
		await adapter.search(request(), {
			...keyedConfig,
			extraConfig: { depth: "turbo" },
		});
		await adapter.search(request(), keyedConfig);

		expect(calls.slice(0, 4).map((call) => bodyOf(call).depth)).toEqual([
			"flash",
			"fast",
			"standard",
			"deep",
		]);
		expect(bodyOf(calls[4]).depth).toBe("standard");
		expect(bodyOf(calls[5]).depth).toBe("standard");
	});

	it("passes allowed domains as includeDomains", async () => {
		stubFetch(() => jsonResponse({ results: [] }));

		await adapter.search(
			request({ allowedDomains: ["example.com", "docs.example.com"] }),
			keyedConfig,
		);

		expect(bodyOf(calls[0]).includeDomains).toEqual([
			"example.com",
			"docs.example.com",
		]);
		expect(bodyOf(calls[0])).not.toHaveProperty("excludeDomains");
	});

	it("passes blocked domains as excludeDomains", async () => {
		stubFetch(() => jsonResponse({ results: [] }));

		await adapter.search(
			request({ blockedDomains: ["spam.example"] }),
			keyedConfig,
		);

		expect(bodyOf(calls[0]).excludeDomains).toEqual(["spam.example"]);
		expect(bodyOf(calls[0])).not.toHaveProperty("includeDomains");
	});

	it("prefers includeDomains when both filters are present", async () => {
		stubFetch(() => jsonResponse({ results: [] }));

		await adapter.search(
			request({
				allowedDomains: ["ok.example"],
				blockedDomains: ["bad.example"],
			}),
			keyedConfig,
		);

		expect(bodyOf(calls[0]).includeDomains).toEqual(["ok.example"]);
		expect(bodyOf(calls[0])).not.toHaveProperty("excludeDomains");
	});

	it("truncates domain lists to Linkup's 100-domain cap", async () => {
		stubFetch(() => jsonResponse({ results: [] }));
		const allowed = Array.from({ length: 105 }, (_, i) => `a${i}.example`);
		const blocked = Array.from({ length: 105 }, (_, i) => `b${i}.example`);

		await adapter.search(request({ allowedDomains: allowed }), keyedConfig);
		await adapter.search(request({ blockedDomains: blocked }), keyedConfig);

		expect(bodyOf(calls[0]).includeDomains).toHaveLength(100);
		expect((bodyOf(calls[0]).includeDomains as string[])[99]).toBe(
			"a99.example",
		);
		expect(bodyOf(calls[1]).excludeDomains).toHaveLength(100);
		expect((bodyOf(calls[1]).excludeDomains as string[])[99]).toBe(
			"b99.example",
		);
	});

	it("does not invent an upper maxResults clamp", async () => {
		stubFetch(() => jsonResponse({ results: [] }));
		const roomy = { ...keyedConfig, maxResults: 1000 };

		await adapter.search(request({ maxResults: 500 }), roomy);

		expect(bodyOf(calls[0]).maxResults).toBe(500);
	});

	it("falls back to 10 for a non-finite maxResults", async () => {
		stubFetch(() => jsonResponse({ results: [] }));

		await adapter.search(request({ maxResults: Number.NaN }), {
			...keyedConfig,
			maxResults: 1000,
		});

		expect(bodyOf(calls[0]).maxResults).toBe(10);
	});

	it("the provider's configured maxResults caps the search", async () => {
		stubFetch(() => jsonResponse({ results: [] }));
		const capped = { ...keyedConfig, maxResults: 3 };

		await adapter.search(request({ maxResults: 10 }), capped);
		await adapter.search(request({ maxResults: 1 }), capped);

		expect(bodyOf(calls[0]).maxResults).toBe(3);
		expect(bodyOf(calls[1]).maxResults).toBe(1);
	});

	it("returns [] without a call when the effective count is zero", async () => {
		stubFetch(() => jsonResponse({ results: [] }));

		expect(
			await adapter.search(request({ maxResults: 0 }), keyedConfig),
		).toEqual([]);
		expect(calls).toHaveLength(0);
	});
});

describe("linkup adapter — response mapping", () => {
	it("maps results onto the normalised hit shape and skips images", async () => {
		stubFetch(() =>
			jsonResponse({
				results: [
					{
						name: "First",
						url: "https://example.com/1",
						content: "page text",
						favicon: "https://example.com/favicon.ico",
						type: "text",
					},
					{
						name: "An image",
						url: "https://example.com/pic.png",
						favicon: "",
						type: "image",
					},
					{ name: "No url", content: "dropped", type: "text" },
					{ url: "https://example.com/4", type: "text" },
				],
			}),
		);

		const hits = await adapter.search(request(), keyedConfig);

		expect(hits).toEqual([
			{
				title: "First",
				url: "https://example.com/1",
				content: "page text",
			},
			{ title: "", url: "https://example.com/4" },
		]);
	});

	it("returns at most maxResults hits", async () => {
		stubFetch(() =>
			jsonResponse({
				results: [
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

	it("keeps an explicit empty results array as a valid empty search", async () => {
		stubFetch(() => jsonResponse({ results: [] }));

		expect(await adapter.search(request(), keyedConfig)).toEqual([]);
	});

	it("throws a 502 when the payload has no results array", async () => {
		stubFetch(() => jsonResponse({ data: [] }));

		let caught: unknown;
		try {
			await adapter.search(request(), keyedConfig);
		} catch (error) {
			caught = error;
		}

		expect(caught).toBeInstanceOf(LinkupSearchError);
		expect((caught as LinkupSearchError).status).toBe(502);
		expect((caught as Error).message).toContain("results array");
	});

	it("throws a 502 on a non-object payload", async () => {
		stubFetch(() => jsonResponse(null));

		let caught: unknown;
		try {
			await adapter.search(request(), keyedConfig);
		} catch (error) {
			caught = error;
		}

		expect(caught).toBeInstanceOf(LinkupSearchError);
		expect((caught as LinkupSearchError).status).toBe(502);
	});

	it("throws a 502 when results is not an array", async () => {
		stubFetch(() => jsonResponse({ results: {} }));

		await expect(adapter.search(request(), keyedConfig)).rejects.toBeInstanceOf(
			LinkupSearchError,
		);
	});
});

describe("linkup adapter — errors", () => {
	it("throws a typed error carrying the HTTP status without the key", async () => {
		stubFetch(() => jsonResponse({ error: "too many requests" }, 429));

		let caught: unknown;
		try {
			await adapter.search(request(), keyedConfig);
		} catch (error) {
			caught = error;
		}

		expect(caught).toBeInstanceOf(LinkupSearchError);
		const typed = caught as LinkupSearchError;
		expect(typed.status).toBe(429);
		expect(typed.name).toBe("LinkupSearchError");
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
			expect((caught as LinkupSearchError).status).toBe(status);
		}
	});

	it("truncates a long error body", async () => {
		stubFetch(() => jsonResponse({ error: "x".repeat(2000) }, 500));

		let caught: unknown;
		try {
			await adapter.search(request(), keyedConfig);
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
				keyedConfig,
			);
		} catch (error) {
			caught = error;
		}

		expect(caught).toBeInstanceOf(LinkupSearchError);
		expect((caught as LinkupSearchError).status).toBe(408);
	});

	it("refuses to call out without an API key", async () => {
		stubFetch(() => jsonResponse({ results: [] }));

		await expect(
			adapter.search(request(), { ...keyedConfig, apiKey: null }),
		).rejects.toThrow("requires an API key");
		expect(calls).toHaveLength(0);
	});
});

describe("linkup adapter — test()", () => {
	it("sends a minimal probe and reports ok with latency", async () => {
		stubFetch(() => jsonResponse({ results: [] }));

		const result = await adapter.test(keyedConfig);

		expect(result.ok).toBe(true);
		expect(result.error).toBeUndefined();
		expect(result.latencyMs).toBeGreaterThanOrEqual(0);
		expect(calls).toHaveLength(1);
		expect(headersOf(calls[0]).get("Authorization")).toBe(
			"Bearer linkup-canary-key-8765",
		);
		expect(bodyOf(calls[0])).toEqual({
			q: "better-ccflare connectivity test",
			depth: "fast",
			outputType: "searchResults",
			maxResults: 1,
		});
	});

	it("returns ok:false on a server error without throwing", async () => {
		stubFetch(() => jsonResponse({ error: "kaput" }, 500));

		const result = await adapter.test(keyedConfig);

		expect(result.ok).toBe(false);
		expect(result.error).toContain("500");
		expect(result.error).not.toContain(keyedConfig.apiKey as string);
		expect(result.latencyMs).toBeGreaterThanOrEqual(0);
	});

	it("returns ok:false on a malformed body", async () => {
		stubFetch(() => jsonResponse({ unexpected: true }));

		const result = await adapter.test(keyedConfig);

		expect(result.ok).toBe(false);
		expect(result.error).toBe("unexpected response shape");
	});

	it("returns ok:false on an OK response with a non-object body", async () => {
		stubFetch(() => jsonResponse(null));

		const result = await adapter.test(keyedConfig);

		expect(result.ok).toBe(false);
		expect(result.error).toBe("unexpected response shape");
	});

	it("returns ok:false when no key is stored, with no outbound call", async () => {
		stubFetch(() => jsonResponse({ results: [] }));

		const result = await adapter.test({ ...keyedConfig, apiKey: null });

		expect(result.ok).toBe(false);
		expect(result.error).toBe("no API key configured");
		expect(calls).toHaveLength(0);
	});
});
