/**
 * Tests for the Nimble adapter.
 *
 * `globalThis.fetch` is stubbed for every test — there are no real network
 * calls, and nothing here touches Anthropic.
 */
import { afterEach, describe, expect, it } from "bun:test";
import {
	createNimbleAdapter,
	NIMBLE_SEARCH_URL,
	NimbleSearchError,
} from "../adapters/nimble";
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
	return { title: `t ${url}`, description: "s", url, content: "" };
}

const adapter = createNimbleAdapter();

const keyedConfig: WebToolAdapterConfig = {
	apiKey: "nimble-canary-key-4321",
	maxResults: 10,
	extraConfig: {},
};

function request(
	overrides: Partial<WebToolSearchRequest> = {},
): WebToolSearchRequest {
	return { query: "hello world", maxResults: 5, ...overrides };
}

describe("nimble adapter — request shape", () => {
	it("posts to the documented URL with bearer auth and the base body", async () => {
		stubFetch(() => jsonResponse({ results: [] }));

		await adapter.search(request(), keyedConfig);

		expect(calls).toHaveLength(1);
		const [call] = calls;
		expect(call.url).toBe(NIMBLE_SEARCH_URL);
		expect(call.init.method).toBe("POST");
		expect(headersOf(call).get("Authorization")).toBe(
			"Bearer nimble-canary-key-4321",
		);
		expect(headersOf(call).get("Content-Type")).toBe("application/json");
		expect(call.init.signal).toBeInstanceOf(AbortSignal);

		// No optional fields are emitted unless configured.
		expect(bodyOf(call)).toEqual({ query: "hello world", max_results: 5 });
	});

	it("forwards search_depth and focus only when configured to valid values", async () => {
		stubFetch(() => jsonResponse({ results: [] }));

		await adapter.search(request(), {
			...keyedConfig,
			extraConfig: { search_depth: "lite", focus: "news" },
		});
		await adapter.search(request(), {
			...keyedConfig,
			extraConfig: { search_depth: "deep", focus: "" },
		});
		await adapter.search(request(), {
			...keyedConfig,
			extraConfig: { search_depth: 42, focus: true },
		});

		expect(bodyOf(calls[0]).search_depth).toBe("lite");
		expect(bodyOf(calls[0]).focus).toBe("news");
		expect(bodyOf(calls[1])).not.toHaveProperty("search_depth");
		expect(bodyOf(calls[1])).not.toHaveProperty("focus");
		expect(bodyOf(calls[2])).not.toHaveProperty("search_depth");
		expect(bodyOf(calls[2])).not.toHaveProperty("focus");
	});

	it("passes allowed domains as include_domains", async () => {
		stubFetch(() => jsonResponse({ results: [] }));

		await adapter.search(
			request({ allowedDomains: ["example.com", "docs.example.com"] }),
			keyedConfig,
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
			keyedConfig,
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
			keyedConfig,
		);

		expect(bodyOf(calls[0]).include_domains).toEqual(["ok.example"]);
		expect(bodyOf(calls[0])).not.toHaveProperty("exclude_domains");
	});

	it("truncates domain lists to Nimble's 50-domain cap", async () => {
		stubFetch(() => jsonResponse({ results: [] }));
		const allowed = Array.from({ length: 55 }, (_, i) => `a${i}.example`);
		const blocked = Array.from({ length: 55 }, (_, i) => `b${i}.example`);

		await adapter.search(request({ allowedDomains: allowed }), keyedConfig);
		await adapter.search(request({ blockedDomains: blocked }), keyedConfig);

		expect(bodyOf(calls[0]).include_domains).toHaveLength(50);
		expect((bodyOf(calls[0]).include_domains as string[])[49]).toBe(
			"a49.example",
		);
		expect(bodyOf(calls[1]).exclude_domains).toHaveLength(50);
		expect((bodyOf(calls[1]).exclude_domains as string[])[49]).toBe(
			"b49.example",
		);
	});

	it("clamps max_results to Nimble's 1–100 range", async () => {
		stubFetch(() => jsonResponse({ results: [] }));
		const roomy = { ...keyedConfig, maxResults: 1000 };

		await adapter.search(request({ maxResults: 500 }), roomy);
		await adapter.search(request({ maxResults: Number.NaN }), roomy);

		expect(bodyOf(calls[0]).max_results).toBe(100);
		expect(bodyOf(calls[1]).max_results).toBe(10);
	});

	it("the provider's configured maxResults caps the search", async () => {
		stubFetch(() => jsonResponse({ results: [] }));
		const capped = { ...keyedConfig, maxResults: 3 };

		await adapter.search(request({ maxResults: 10 }), capped);
		await adapter.search(request({ maxResults: 1 }), capped);

		expect(bodyOf(calls[0]).max_results).toBe(3);
		expect(bodyOf(calls[1]).max_results).toBe(1);
	});

	it("returns [] without a call when the effective count is zero", async () => {
		stubFetch(() => jsonResponse({ results: [] }));

		expect(
			await adapter.search(request({ maxResults: 0 }), keyedConfig),
		).toEqual([]);
		expect(calls).toHaveLength(0);
	});
});

describe("nimble adapter — response mapping", () => {
	it("maps results onto the normalised hit shape", async () => {
		stubFetch(() =>
			jsonResponse({
				request_id: "req-1",
				total_results: 3,
				results: [
					{
						title: "First",
						description: "a snippet",
						url: "https://example.com/1",
						content: "page text",
						metadata: { site_name: "Example" },
						additional_data: { publish_date: "2026-01-02" },
					},
					{ title: "No url", description: "dropped" },
					{ url: "https://example.com/3" },
				],
			}),
		);

		const hits = await adapter.search(request(), keyedConfig);

		expect(hits).toEqual([
			{
				title: "First",
				url: "https://example.com/1",
				snippet: "a snippet",
				content: "page text",
				publishedDate: "2026-01-02",
			},
			{ title: "", url: "https://example.com/3" },
		]);
	});

	it("omits empty content, description and publish_date", async () => {
		stubFetch(() =>
			jsonResponse({
				results: [
					{
						title: "Empty extras",
						description: "",
						url: "https://example.com/empty",
						content: "",
						additional_data: {},
					},
				],
			}),
		);

		expect(await adapter.search(request(), keyedConfig)).toEqual([
			{ title: "Empty extras", url: "https://example.com/empty" },
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
		stubFetch(() => jsonResponse({ request_id: "r", results: [] }));

		expect(await adapter.search(request(), keyedConfig)).toEqual([]);
	});

	it("throws a 502 when the payload has no results array", async () => {
		stubFetch(() => jsonResponse({ total_results: 0 }));

		let caught: unknown;
		try {
			await adapter.search(request(), keyedConfig);
		} catch (error) {
			caught = error;
		}

		expect(caught).toBeInstanceOf(NimbleSearchError);
		expect((caught as NimbleSearchError).status).toBe(502);
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

		expect(caught).toBeInstanceOf(NimbleSearchError);
		expect((caught as NimbleSearchError).status).toBe(502);
	});

	it("throws a 502 when results is not an array", async () => {
		stubFetch(() => jsonResponse({ results: "nope" }));

		await expect(adapter.search(request(), keyedConfig)).rejects.toBeInstanceOf(
			NimbleSearchError,
		);
	});
});

describe("nimble adapter — errors", () => {
	it("throws a typed error carrying the HTTP status without the key", async () => {
		stubFetch(() => jsonResponse({ detail: "too many requests" }, 429));

		let caught: unknown;
		try {
			await adapter.search(request(), keyedConfig);
		} catch (error) {
			caught = error;
		}

		expect(caught).toBeInstanceOf(NimbleSearchError);
		const typed = caught as NimbleSearchError;
		expect(typed.status).toBe(429);
		expect(typed.name).toBe("NimbleSearchError");
		expect(typed.message).toContain("429");
		expect(typed.message).toContain("too many requests");
		expect(typed.message).not.toContain(keyedConfig.apiKey as string);
	});

	it("keeps auth, payment and rate-limit statuses distinguishable", async () => {
		for (const status of [401, 402, 429, 500]) {
			stubFetch(() => jsonResponse({ detail: "nope" }, status));
			let caught: unknown;
			try {
				await adapter.search(request(), keyedConfig);
			} catch (error) {
				caught = error;
			}
			expect((caught as NimbleSearchError).status).toBe(status);
		}
	});

	it("truncates a long error body", async () => {
		stubFetch(() => jsonResponse({ detail: "x".repeat(2000) }, 500));

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

		expect(caught).toBeInstanceOf(NimbleSearchError);
		expect((caught as NimbleSearchError).status).toBe(408);
	});

	it("refuses to call out without an API key", async () => {
		stubFetch(() => jsonResponse({ results: [] }));

		await expect(
			adapter.search(request(), { ...keyedConfig, apiKey: null }),
		).rejects.toThrow("requires an API key");
		expect(calls).toHaveLength(0);
	});
});

describe("nimble adapter — test()", () => {
	it("sends a minimal probe and reports ok with latency", async () => {
		stubFetch(() => jsonResponse({ results: [] }));

		const result = await adapter.test(keyedConfig);

		expect(result.ok).toBe(true);
		expect(result.error).toBeUndefined();
		expect(result.latencyMs).toBeGreaterThanOrEqual(0);
		expect(calls).toHaveLength(1);
		expect(headersOf(calls[0]).get("Authorization")).toBe(
			"Bearer nimble-canary-key-4321",
		);
		expect(bodyOf(calls[0])).toEqual({
			query: "better-ccflare connectivity test",
			max_results: 1,
		});
	});

	it("returns ok:false on a server error without throwing", async () => {
		stubFetch(() => jsonResponse({ detail: "kaput" }, 500));

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
