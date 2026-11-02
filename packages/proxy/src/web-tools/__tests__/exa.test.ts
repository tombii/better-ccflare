/**
 * Tests for the Exa adapter.
 *
 * `globalThis.fetch` is stubbed for every test — there are no real network
 * calls, and nothing here touches Anthropic.
 */
import { afterEach, describe, expect, it } from "bun:test";
import {
	createExaAdapter,
	EXA_SEARCH_URL,
	ExaSearchError,
} from "../adapters/exa";
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

const adapter = createExaAdapter();

const API_KEY = "exa-canary-key-0123456789";
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

describe("exa adapter — request shape", () => {
	it("posts to the documented URL with x-api-key auth and the base body", async () => {
		stubFetch(() => jsonResponse({ results: [] }));

		await adapter.search(request(), baseConfig);

		expect(calls).toHaveLength(1);
		const [call] = calls;
		expect(call.url).toBe("https://api.exa.ai/search");
		expect(call.url).toBe(EXA_SEARCH_URL);
		expect(call.init.method).toBe("POST");
		expect(headersOf(call).get("x-api-key")).toBe(API_KEY);
		expect(headersOf(call).get("Authorization")).toBeNull();
		expect(headersOf(call).get("Content-Type")).toBe("application/json");
		expect(call.init.signal).toBeInstanceOf(AbortSignal);

		// No optional fields are emitted unless requested.
		expect(bodyOf(call)).toEqual({
			query: "hello world",
			numResults: 5,
			type: "auto",
		});
	});

	it("passes allowed domains as includeDomains", async () => {
		stubFetch(() => jsonResponse({ results: [] }));

		await adapter.search(
			request({ allowedDomains: ["example.com", "docs.example.com"] }),
			baseConfig,
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
			baseConfig,
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
			baseConfig,
		);

		expect(bodyOf(calls[0]).includeDomains).toEqual(["ok.example"]);
		expect(bodyOf(calls[0])).not.toHaveProperty("excludeDomains");
	});

	it("clamps numResults to Exa's 0–100 range", async () => {
		stubFetch(() => jsonResponse({ results: [] }));
		const roomy = { ...baseConfig, maxResults: 500 };

		await adapter.search(request({ maxResults: 500 }), roomy);
		await adapter.search(request({ maxResults: -3 }), roomy);
		await adapter.search(request({ maxResults: 0 }), roomy);
		await adapter.search(request({ maxResults: Number.NaN }), roomy);

		expect(bodyOf(calls[0]).numResults).toBe(100);
		expect(bodyOf(calls[1]).numResults).toBe(0);
		expect(bodyOf(calls[2]).numResults).toBe(0);
		expect(bodyOf(calls[3]).numResults).toBe(10);
	});

	it("the provider's configured maxResults caps the search", async () => {
		stubFetch(() => jsonResponse({ results: [] }));
		const capped = { ...baseConfig, maxResults: 3 };

		await adapter.search(request({ maxResults: 10 }), capped);
		await adapter.search(request({ maxResults: 1 }), capped);

		expect(bodyOf(calls[0]).numResults).toBe(3);
		expect(bodyOf(calls[1]).numResults).toBe(1);
	});

	it("forwards type only when configured to a supported value", async () => {
		stubFetch(() => jsonResponse({ results: [] }));

		await adapter.search(request(), {
			...baseConfig,
			extraConfig: { type: "deep" },
		});
		await adapter.search(request(), {
			...baseConfig,
			extraConfig: { type: "keyword" },
		});
		await adapter.search(request(), baseConfig);

		expect(bodyOf(calls[0]).type).toBe("deep");
		// Not an Exa search type — falls back to Exa's own default.
		expect(bodyOf(calls[1]).type).toBe("auto");
		expect(bodyOf(calls[2]).type).toBe("auto");
	});

	it("asks for extracted text only when the operator opted in", async () => {
		stubFetch(() => jsonResponse({ results: [] }));

		await adapter.search(request(), {
			...baseConfig,
			extraConfig: { includeText: true },
		});
		await adapter.search(request(), {
			...baseConfig,
			extraConfig: { includeText: "true" },
		});
		await adapter.search(request(), baseConfig);

		expect(bodyOf(calls[0]).contents).toEqual({
			text: { maxCharacters: 1000 },
		});
		expect(bodyOf(calls[1])).not.toHaveProperty("contents");
		expect(bodyOf(calls[2])).not.toHaveProperty("contents");
	});
});

describe("exa adapter — response mapping", () => {
	it("maps results onto the normalised hit shape", async () => {
		stubFetch(() =>
			jsonResponse({
				requestId: "abc",
				costDollars: { total: 0.007 },
				results: [
					{
						title: "First",
						url: "https://example.com/1",
						publishedDate: "2026-01-02T00:00:00.000Z",
						text: "the extracted page",
					},
					{ title: "No URL", text: "dropped" },
					{ url: "https://example.com/3" },
				],
			}),
		);

		const hits = await adapter.search(request(), baseConfig);

		expect(hits).toEqual([
			{
				title: "First",
				url: "https://example.com/1",
				content: "the extracted page",
				publishedDate: "2026-01-02T00:00:00.000Z",
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

describe("exa adapter — errors", () => {
	it("throws a typed error carrying the HTTP status", async () => {
		stubFetch(() => jsonResponse({ error: "you are searching too fast" }, 429));

		let caught: unknown;
		try {
			await adapter.search(request(), baseConfig);
		} catch (error) {
			caught = error;
		}

		expect(caught).toBeInstanceOf(ExaSearchError);
		const typed = caught as ExaSearchError;
		expect(typed.status).toBe(429);
		expect(typed.name).toBe("ExaSearchError");
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
			expect(caught).toBeInstanceOf(ExaSearchError);
			expect((caught as ExaSearchError).status).toBe(status);
		}
	});

	it("preserves 402 so credit exhaustion triggers a cooldown", async () => {
		stubFetch(() =>
			jsonResponse(
				{ error: "Payment required — credit balance exhausted" },
				402,
			),
		);

		let caught: unknown;
		try {
			await adapter.search(request(), baseConfig);
		} catch (error) {
			caught = error;
		}

		expect(caught).toBeInstanceOf(ExaSearchError);
		expect((caught as ExaSearchError).status).toBe(402);
		expect((caught as Error).message).not.toContain(API_KEY);
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

		expect(caught).toBeInstanceOf(ExaSearchError);
		expect((caught as ExaSearchError).status).toBe(408);
	});

	it("refuses to call out without an API key", async () => {
		stubFetch(() => jsonResponse({ results: [] }));

		await expect(
			adapter.search(request(), { ...baseConfig, apiKey: null }),
		).rejects.toThrow("requires an API key");
		expect(calls).toHaveLength(0);
	});
});

describe("exa adapter — test()", () => {
	it("sends a minimal probe and reports ok with latency", async () => {
		stubFetch(() => jsonResponse({ results: [] }));

		const result = await adapter.test(baseConfig);

		expect(result.ok).toBe(true);
		expect(result.error).toBeUndefined();
		expect(result.latencyMs).toBeGreaterThanOrEqual(0);
		expect(calls).toHaveLength(1);
		expect(headersOf(calls[0]).get("x-api-key")).toBe(API_KEY);
		expect(bodyOf(calls[0])).toEqual({
			query: "better-ccflare connectivity test",
			numResults: 1,
			type: "auto",
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
