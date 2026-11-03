/**
 * Tests for the Brave Search adapter.
 *
 * `globalThis.fetch` is stubbed for every test — there are no real network
 * calls, and nothing here touches Anthropic.
 */
import { afterEach, describe, expect, it } from "bun:test";
import {
	BRAVE_LLM_CONTEXT_URL,
	BRAVE_SEARCH_URL,
	BraveSearchError,
	createBraveAdapter,
	resetBravePlanMemory,
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

/**
 * The web/search product, which is now opt-in: every spec that exercises the
 * `web.results[]` shape has to name it explicitly. Specs for the LLM Context
 * product (the default) live in their own describe block below.
 */
const baseConfig: WebToolAdapterConfig = {
	apiKey: "brave-canary-token-9876",
	maxResults: 10,
	extraConfig: { endpoint: "web" },
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
			extraConfig: {
				...baseConfig.extraConfig,
				country: "DE",
				searchLang: "de",
				freshness: "pw",
			},
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
			extraConfig: { ...baseConfig.extraConfig, freshness: "yesterday" },
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
				extraConfig: { ...baseConfig.extraConfig, safesearch: value },
			});

			const url = new URL(calls[0].url);
			expect(url.searchParams.get("safesearch")).toBe(value);
		});
	}

	it("drops an unsupported safesearch value rather than sending it", async () => {
		stubFetch(() => jsonResponse({ web: { results: [] } }));

		await adapter.search(request(), {
			...baseConfig,
			extraConfig: { ...baseConfig.extraConfig, safesearch: "paranoid" },
		});

		expect(new URL(calls[0].url).searchParams.has("safesearch")).toBe(false);
	});
});

describe("brave adapter — llm/context endpoint", () => {
	const llmConfig: WebToolAdapterConfig = {
		...baseConfig,
		extraConfig: { endpoint: "llm-context" },
	};

	/** A documented LLM Context payload: chunks under grounding.generic[]. */
	function llmPayload(
		entries: Array<Record<string, unknown>> = [
			{
				url: "https://example.com/a",
				title: "Alpha",
				snippets: ["first chunk", "second chunk"],
			},
			{
				url: "https://example.com/b",
				title: "Beta",
				snippets: ["only chunk"],
			},
		],
	): Record<string, unknown> {
		return {
			grounding: { generic: entries, map: [] },
			sources: {
				"https://example.com/a": {
					title: "Alpha",
					hostname: "example.com",
				},
			},
		};
	}

	it("GETs the llm/context URL instead of web/search", async () => {
		stubFetch(() => jsonResponse(llmPayload()));

		await adapter.search(request(), llmConfig);

		expect(calls[0].url.startsWith(BRAVE_LLM_CONTEXT_URL)).toBe(true);
		expect(calls[0].url.startsWith(BRAVE_SEARCH_URL)).toBe(false);
		expect(calls[0].init.method).toBe("GET");
		expect(headersOf(calls[0]).get("X-Subscription-Token")).toBe(
			"brave-canary-token-9876",
		);
	});

	it("defaults to llm/context when no endpoint is configured", async () => {
		stubFetch(() => jsonResponse(llmPayload()));

		await adapter.search(request(), {
			...baseConfig,
			extraConfig: {},
		});

		expect(calls[0].url.startsWith(BRAVE_LLM_CONTEXT_URL)).toBe(true);
	});

	it("falls back to llm/context for an unrecognised endpoint value", async () => {
		stubFetch(() => jsonResponse(llmPayload()));

		await adapter.search(request(), {
			...baseConfig,
			extraConfig: { endpoint: "legacy-ai" },
		});

		expect(calls[0].url.startsWith(BRAVE_LLM_CONTEXT_URL)).toBe(true);
	});

	it('uses web/search only when endpoint is explicitly "web"', async () => {
		stubFetch(() => jsonResponse({ web: { results: [] } }));

		await adapter.search(request(), {
			...baseConfig,
			extraConfig: { endpoint: "web" },
		});

		expect(calls[0].url.startsWith(BRAVE_SEARCH_URL)).toBe(true);
		expect(paramsOf(calls[0]).has("maximum_number_of_tokens")).toBe(false);
	});

	it("pins the token, URL and snippet budgets so we never pay for content we truncate", async () => {
		stubFetch(() => jsonResponse(llmPayload()));

		await adapter.search(request(), llmConfig);

		const params = paramsOf(calls[0]);
		expect(params.get("maximum_number_of_tokens")).toBe("2048");
		expect(params.get("maximum_number_of_urls")).toBe("5");
		expect(params.get("maximum_number_of_snippets")).toBe("5");
	});

	it("maps grounding.generic onto hits, joining chunks into the snippet", async () => {
		stubFetch(() => jsonResponse(llmPayload()));

		const hits = await adapter.search(request(), llmConfig);

		expect(hits).toEqual([
			{
				title: "Alpha",
				url: "https://example.com/a",
				snippet: "first chunk\n\nsecond chunk",
			},
			{
				title: "Beta",
				url: "https://example.com/b",
				snippet: "only chunk",
			},
		]);
	});

	it("falls back to the sources map for a title the entry omits", async () => {
		stubFetch(() =>
			jsonResponse(
				llmPayload([{ url: "https://example.com/a", snippets: ["chunk"] }]),
			),
		);

		const hits = await adapter.search(request(), llmConfig);

		expect(hits[0].title).toBe("Alpha");
	});

	it("drops entries with no URL and entries with no snippets", async () => {
		stubFetch(() =>
			jsonResponse(
				llmPayload([
					{ title: "No URL", snippets: ["chunk"] },
					{ url: "https://example.com/empty", title: "Empty" },
					{ url: "https://example.com/ok", snippets: ["chunk"] },
				]),
			),
		);

		const hits = await adapter.search(request(), llmConfig);

		expect(hits.map((h) => h.url)).toEqual(["https://example.com/ok"]);
	});

	it("returns at most maxResults hits", async () => {
		stubFetch(() =>
			jsonResponse(
				llmPayload(
					Array.from({ length: 8 }, (_, i) => ({
						url: `https://example.com/${i}`,
						title: `T${i}`,
						snippets: ["chunk"],
					})),
				),
			),
		);

		const hits = await adapter.search(request({ maxResults: 3 }), llmConfig);

		expect(hits).toHaveLength(3);
	});

	it("applies the domain post-filter to llm/context hits", async () => {
		stubFetch(() =>
			jsonResponse(
				llmPayload([
					{ url: "https://docs.example.com/x", snippets: ["chunk"] },
					{ url: "https://evil.test/y", snippets: ["chunk"] },
				]),
			),
		);

		const hits = await adapter.search(
			request({ allowedDomains: ["example.com"] }),
			llmConfig,
		);

		expect(hits.map((h) => h.url)).toEqual(["https://docs.example.com/x"]);
	});

	it("returns [] when grounding is absent (a valid empty search)", async () => {
		stubFetch(() => jsonResponse({}));

		expect(await adapter.search(request(), llmConfig)).toEqual([]);
	});

	it("keeps an explicit empty grounding.generic as a valid empty search", async () => {
		stubFetch(() => jsonResponse({ grounding: { generic: [] } }));

		expect(await adapter.search(request(), llmConfig)).toEqual([]);
	});

	it("throws when grounding is present but not an object", async () => {
		stubFetch(() => jsonResponse({ grounding: "nope" }));

		await expect(adapter.search(request(), llmConfig)).rejects.toBeInstanceOf(
			BraveSearchError,
		);
	});

	it("throws when grounding.generic is present but not an array", async () => {
		stubFetch(() => jsonResponse({ grounding: { generic: {} } }));

		await expect(adapter.search(request(), llmConfig)).rejects.toBeInstanceOf(
			BraveSearchError,
		);
	});

	it("probes the configured endpoint from test()", async () => {
		stubFetch(() => jsonResponse(llmPayload()));

		const result = await adapter.test(llmConfig);

		expect(result.ok).toBe(true);
		expect(calls[0].url.startsWith(BRAVE_LLM_CONTEXT_URL)).toBe(true);
	});

	it("forwards country, search_lang and safesearch on llm/context", async () => {
		stubFetch(() => jsonResponse(llmPayload()));

		await adapter.search(request(), {
			...baseConfig,
			extraConfig: {
				endpoint: "llm-context",
				country: "DE",
				searchLang: "de",
				safesearch: "strict",
			},
		});

		const params = paramsOf(calls[0]);
		expect(params.get("country")).toBe("DE");
		expect(params.get("search_lang")).toBe("de");
		expect(params.get("safesearch")).toBe("strict");
	});
});

describe("brave adapter — plan without LLM Context", () => {
	/**
	 * Brave's documented shape for a key whose plan lacks the endpoint:
	 * HTTP 400 with `error.code = "OPTION_NOT_IN_PLAN"`. The legacy "Free AI"
	 * plan returns exactly this for `/llm/context` while `/web/search` works.
	 */
	function optionNotInPlan(): Response {
		return jsonResponse(
			{
				type: "ErrorResponse",
				error: {
					id: "probe",
					status: 400,
					detail: "The option is not included in the plan.",
					meta: { component: "authentication" },
					code: "OPTION_NOT_IN_PLAN",
				},
				time: 0,
			},
			400,
		);
	}

	const ROW_ID = "row-brave-legacy";

	/** Config for a row that asks for llm-context and carries its id. */
	const llmConfig: WebToolAdapterConfig = {
		...baseConfig,
		extraConfig: {},
		rowId: ROW_ID,
	};

	afterEach(() => {
		resetBravePlanMemory();
	});

	it("falls back to web/search and returns its hits", async () => {
		stubFetch((call) =>
			call.url.startsWith(BRAVE_LLM_CONTEXT_URL)
				? optionNotInPlan()
				: jsonResponse({
						web: {
							results: [
								{ title: "W", url: "https://example.com/w", description: "d" },
							],
						},
					}),
		);

		const hits = await adapter.search(request(), llmConfig);

		expect(calls).toHaveLength(2);
		expect(calls[0].url.startsWith(BRAVE_LLM_CONTEXT_URL)).toBe(true);
		expect(calls[1].url.startsWith(BRAVE_SEARCH_URL)).toBe(true);
		expect(hits).toEqual([
			{ title: "W", url: "https://example.com/w", snippet: "d" },
		]);
	});

	it("remembers the answer, so later searches skip the doomed call", async () => {
		stubFetch((call) =>
			call.url.startsWith(BRAVE_LLM_CONTEXT_URL)
				? optionNotInPlan()
				: jsonResponse({ web: { results: [] } }),
		);

		await adapter.search(request(), llmConfig);
		expect(calls).toHaveLength(2);

		await adapter.search(request(), llmConfig);
		// No second llm/context attempt: only the web/search call.
		expect(calls).toHaveLength(3);
		expect(calls[2].url.startsWith(BRAVE_SEARCH_URL)).toBe(true);
	});

	it("keeps the memory per row: another row still tries llm-context", async () => {
		stubFetch((call) =>
			call.url.startsWith(BRAVE_LLM_CONTEXT_URL)
				? optionNotInPlan()
				: jsonResponse({ web: { results: [] } }),
		);

		await adapter.search(request(), llmConfig);
		calls = [];
		await adapter.search(request(), { ...llmConfig, rowId: "other-row" });

		expect(calls[0].url.startsWith(BRAVE_LLM_CONTEXT_URL)).toBe(true);
	});

	it("does not fall back on a 400 that is not a plan problem", async () => {
		stubFetch(() =>
			jsonResponse(
				{ type: "ErrorResponse", error: { status: 400, code: "BAD_REQUEST" } },
				400,
			),
		);

		await expect(adapter.search(request(), llmConfig)).rejects.toBeInstanceOf(
			BraveSearchError,
		);
		expect(calls).toHaveLength(1);
	});

	it("does not fall back on a 429 (rate limit is not a plan problem)", async () => {
		stubFetch(() =>
			jsonResponse(
				{ type: "ErrorResponse", error: { status: 429, code: "RATE_LIMITED" } },
				429,
			),
		);

		await expect(adapter.search(request(), llmConfig)).rejects.toBeInstanceOf(
			BraveSearchError,
		);
		expect(calls).toHaveLength(1);
	});

	it("still throws when the web/search fallback itself fails", async () => {
		stubFetch((call) =>
			call.url.startsWith(BRAVE_LLM_CONTEXT_URL)
				? optionNotInPlan()
				: jsonResponse({ error: "nope" }, 500),
		);

		await expect(adapter.search(request(), llmConfig)).rejects.toBeInstanceOf(
			BraveSearchError,
		);
		expect(calls).toHaveLength(2);
	});

	it("carries the code on the error so the chain can tell what failed", async () => {
		stubFetch(() =>
			jsonResponse(
				{
					type: "ErrorResponse",
					error: { status: 400, code: "OPTION_NOT_IN_PLAN" },
				},
				400,
			),
		);

		// No rowId: the memory cannot be kept, so the error surfaces as-is.
		const error = await adapter
			.search(request(), { ...llmConfig, rowId: undefined })
			.catch((e: unknown) => e);

		expect(error).toBeInstanceOf(BraveSearchError);
		expect((error as BraveSearchError).code).toBe("OPTION_NOT_IN_PLAN");
	});

	it("reports ok from test() on a legacy plan", async () => {
		stubFetch((call) =>
			call.url.startsWith(BRAVE_LLM_CONTEXT_URL)
				? optionNotInPlan()
				: jsonResponse({ web: { results: [] } }),
		);

		const result = await adapter.test(llmConfig);

		expect(result.ok).toBe(true);
		expect(result.error).toBeUndefined();
		expect(calls[1].url.startsWith(BRAVE_SEARCH_URL)).toBe(true);
	});
});

describe("brave adapter — plan without LLM Context, reported as 429", () => {
	/** Brave's 429 for a plan that has no LLM Context access (Free AI). */
	function planExcludesEndpoint(): Response {
		return jsonResponse(
			{
				type: "ErrorResponse",
				error: {
					id: "7307041c-4966-46c1-a44b-857ef023e331",
					status: 429,
					detail: "Request rate limit exceeded for plan",
					meta: { plan: "Free AI", rate_limit: 1, rate_current: 1 },
				},
			},
			429,
		);
	}

	const llmConfig: WebToolAdapterConfig = {
		...baseConfig,
		// No `endpoint` key: this is the default llm-context row.
		extraConfig: {},
		rowId: "row-brave-free",
	};

	/** A different row, so the answer remembered for {@link llmConfig} cannot leak. */
	const otherConfig: WebToolAdapterConfig = {
		...llmConfig,
		rowId: "row-brave-2",
	};

	afterEach(() => {
		resetBravePlanMemory();
	});

	it("falls back when llm-context is refused with a 429", async () => {
		// This plan has no LLM Context access; `web/search` works.
		stubFetch((call) =>
			call.url.startsWith(BRAVE_LLM_CONTEXT_URL)
				? planExcludesEndpoint()
				: jsonResponse({
						web: {
							results: [{ title: "W", url: "https://example.com/w" }],
						},
					}),
		);

		const hits = await adapter.search(request(), llmConfig);

		expect(calls).toHaveLength(2);
		expect(calls[1].url.startsWith(BRAVE_SEARCH_URL)).toBe(true);
		expect(hits).toEqual([{ title: "W", url: "https://example.com/w" }]);
	});

	it("remembers the plan answer, so later searches skip llm-context", async () => {
		stubFetch((call) =>
			call.url.startsWith(BRAVE_LLM_CONTEXT_URL)
				? planExcludesEndpoint()
				: jsonResponse({ web: { results: [] } }),
		);

		await adapter.search(request(), llmConfig);
		expect(calls).toHaveLength(2);

		await adapter.search(request(), llmConfig);
		expect(calls).toHaveLength(3);
		expect(calls[2].url.startsWith(BRAVE_SEARCH_URL)).toBe(true);
	});

	it("passes the 429 through when web/search is what failed", async () => {
		stubFetch(() => planExcludesEndpoint());

		await expect(
			adapter.search(request(), {
				...llmConfig,
				extraConfig: { endpoint: "web" },
			}),
		).rejects.toBeInstanceOf(BraveSearchError);
		expect(calls).toHaveLength(1);
	});

	it("reports ok from test() when llm-context is refused with a 429", async () => {
		stubFetch((call) =>
			call.url.startsWith(BRAVE_LLM_CONTEXT_URL)
				? planExcludesEndpoint()
				: jsonResponse({ web: { results: [] } }),
		);

		const result = await adapter.test(otherConfig);

		expect(result.ok).toBe(true);
		expect(calls[1].url.startsWith(BRAVE_SEARCH_URL)).toBe(true);
	});

	it("still leaves the 429 to the chain when web/search fails too", async () => {
		stubFetch(() => planExcludesEndpoint());

		await expect(adapter.search(request(), llmConfig)).rejects.toBeInstanceOf(
			BraveSearchError,
		);
		expect(calls).toHaveLength(2);
	});
});

describe("brave adapter — replacing the key rescopes the plan memory", () => {
	function optionNotInPlan(): Response {
		return jsonResponse(
			{
				type: "ErrorResponse",
				error: { status: 400, code: "OPTION_NOT_IN_PLAN" },
			},
			400,
		);
	}

	afterEach(() => {
		resetBravePlanMemory();
	});

	it("a new key on the same row tries llm-context again", async () => {
		// Old key: no LLM Context, so the row is remembered as web-only.
		stubFetch((call) =>
			call.url.startsWith(BRAVE_LLM_CONTEXT_URL)
				? optionNotInPlan()
				: jsonResponse({ web: { results: [] } }),
		);
		const legacy: WebToolAdapterConfig = {
			...baseConfig,
			extraConfig: {},
			rowId: "row-1",
		};
		await adapter.search(request(), legacy);
		calls = [];

		// Same row id, upgraded key — must probe llm-context rather than stay
		// pinned to web/search until a restart.
		const upgraded: WebToolAdapterConfig = {
			...legacy,
			apiKey: "brave-upgraded-plan-key",
		};
		stubFetch(() =>
			jsonResponse({
				grounding: { generic: [{ url: "https://x.test/a", snippets: ["c"] }] },
			}),
		);
		await adapter.search(request(), upgraded);

		expect(calls).toHaveLength(1);
		expect(calls[0].url.startsWith(BRAVE_LLM_CONTEXT_URL)).toBe(true);
	});

	it("the legacy key stays on web/search after a different key is seen", async () => {
		stubFetch((call) =>
			call.url.startsWith(BRAVE_LLM_CONTEXT_URL)
				? optionNotInPlan()
				: jsonResponse({ web: { results: [] } }),
		);
		const legacy: WebToolAdapterConfig = {
			...baseConfig,
			extraConfig: {},
			rowId: "row-1",
		};
		await adapter.search(request(), legacy);
		await adapter.search(request(), { ...legacy, apiKey: "other-key" });

		calls = [];
		await adapter.search(request(), legacy);
		// Still remembered as web-only: one call, straight to web/search.
		expect(calls).toHaveLength(1);
		expect(calls[0].url.startsWith(BRAVE_SEARCH_URL)).toBe(true);
	});
});
