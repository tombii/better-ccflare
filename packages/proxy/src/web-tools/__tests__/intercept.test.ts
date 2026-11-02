/**
 * Tests for the web-search interception orchestrator.
 *
 * No network: the real provider chain runs against a fake repository whose
 * "provider" is a stubbed `globalThis.fetch`, so the ok / error / fallthrough
 * decisions — and the `web_tool_calls` trace each one writes — are exercised
 * end to end. No module is mocked: a `mock.module("../chain", …)` stub leaks
 * into the other web-tools test files through Bun's process-global module
 * registry. What matters here is the decision and the trace, not adapter
 * behaviour (covered by `chain.test.ts` and `tavily.test.ts`).
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type {
	SearchProvider,
	WebToolCallWriteInput,
} from "@better-ccflare/types";
import {
	maybeInterceptWebSearch,
	type WebSearchInterceptDeps,
} from "../intercept";

const originalFetch = globalThis.fetch;

afterEach(() => {
	globalThis.fetch = originalFetch;
});

const QUERY = "how do bun test mocks work";

/** The "API key" of the fake provider row. */
const PROVIDER_KEY = "tvly-fake-key";
const PROVIDER_ROW_ID = "row-tavily-1";

let chainCalls: Array<Record<string, unknown>> = [];
let providersForTest: SearchProvider[] = [];

beforeEach(() => {
	chainCalls = [];
	providersForTest = [makeProvider()];
});

function makeProvider(overrides: Partial<SearchProvider> = {}): SearchProvider {
	return {
		id: PROVIDER_ROW_ID,
		provider: "tavily",
		label: "Tavily",
		apiKey: PROVIDER_KEY,
		priority: 0,
		enabled: true,
		maxResults: 5,
		extraConfig: {},
		status: "unknown",
		statusMessage: null,
		statusCheckedAt: null,
		cooldownUntil: null,
		createdAt: 0,
		updatedAt: 0,
		...overrides,
	};
}

function tavilyResponse(urls: string[]): Response {
	return new Response(
		JSON.stringify({
			results: urls.map((url) => ({
				title: url,
				url,
				content: `about ${url}`,
			})),
		}),
		{ status: 200, headers: { "Content-Type": "application/json" } },
	);
}

/** Point the chain's fake provider at a fetch stub. */
function stubProvider(
	handler: () => Response | Promise<Response> = () =>
		tavilyResponse(["https://a.example/1", "https://b.example/1"]),
): void {
	chainCalls = [];
	globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
		// The chain POSTs `{query, max_results, ...}`; record it so tests can
		// assert the query reached the provider unchanged.
		if (init?.body) {
			chainCalls.push(JSON.parse(String(init.body)) as Record<string, unknown>);
		}
		return handler();
	}) as typeof fetch;
}

interface MessageBody {
	content: Array<{
		type: string;
		text?: string;
		name?: string;
		content?: unknown;
	}>;
}

function searchBody(
	options: { toolType?: string; query?: string; stream?: boolean } = {},
): unknown {
	return {
		model: "claude-3-5-haiku-20241022",
		max_tokens: 1024,
		tools: [
			{ type: options.toolType ?? "web_search_20250305", name: "web_search" },
		],
		messages: [
			{
				role: "user",
				content: `Perform a web search for the query: ${options.query ?? QUERY}`,
			},
		],
		...(options.stream ? { stream: true } : {}),
	};
}

function textBlock(body: MessageBody): string {
	const block = body.content.find((entry) => entry.type === "text");
	return block?.text ?? "";
}

/**
 * In-memory stand-in for `recordWebToolCall`. Writes settle as microtasks, so
 * `settle()` lets fire-and-forget traces land before assertions.
 */
function makeTraceSink(
	options: { failWrites?: boolean; throwSync?: boolean } = {},
) {
	const traces: WebToolCallWriteInput[] = [];
	const pending: Promise<void>[] = [];
	const dbOps = {
		getSearchProviderRepository: () => ({
			listActiveByPriority: async () => providersForTest,
			updateHealth: async () => {},
		}),
		recordWebToolCall: (input: WebToolCallWriteInput) => {
			if (options.throwSync) throw new Error("sync trace failure");
			traces.push(input);
			const write = options.failWrites
				? Promise.reject(new Error("trace write failed"))
				: Promise.resolve();
			pending.push(write.catch(() => {}));
			return write;
		},
	} as unknown as WebSearchInterceptDeps["dbOps"];
	return { traces, dbOps, settle: () => Promise.all(pending) };
}

interface Harness {
	deps: WebSearchInterceptDeps;
	info: string[];
	warn: string[];
}

function makeHarness(
	options: {
		body?: unknown;
		pathname?: string;
		headers?: Headers;
		enabled?: boolean;
		bypassHeader?: boolean;
		maxResultChars?: number;
		trace?: ReturnType<typeof makeTraceSink>;
		project?: string | null;
		accountId?: string | null;
	} = {},
): Harness {
	const info: string[] = [];
	const warn: string[] = [];
	const deps: WebSearchInterceptDeps = {
		body: options.body ?? searchBody(),
		pathname: options.pathname ?? "/v1/messages",
		headers: options.headers ?? new Headers(),
		config: {
			getWebSearchEnabled: () => options.enabled ?? true,
			getWebSearchBypassHeader: () => options.bypassHeader ?? true,
			getWebSearchMaxResultChars: () => options.maxResultChars ?? 4000,
		},
		dbOps: (options.trace ?? makeTraceSink()).dbOps,
		project: options.project,
		accountId: options.accountId,
		log: {
			info: (message: string) => info.push(message),
			warn: (message: string) => warn.push(message),
		},
	};
	return { deps, info, warn };
}

/** Make the fake repository throw, as a broken database would. */
function breakProviderRepository(deps: WebSearchInterceptDeps): void {
	(
		deps.dbOps as unknown as {
			getSearchProviderRepository: () => unknown;
		}
	).getSearchProviderRepository = () => {
		throw new Error("chain exploded");
	};
}

describe("maybeInterceptWebSearch", () => {
	it("returns null and never runs the chain when the master toggle is off", async () => {
		stubProvider();
		const { deps } = makeHarness({ enabled: false });

		expect(await maybeInterceptWebSearch(deps)).toBeNull();
		expect(chainCalls).toHaveLength(0);
	});

	it("returns null for paths other than /v1/messages", async () => {
		stubProvider();
		const { deps } = makeHarness({ pathname: "/v1/complete" });

		expect(await maybeInterceptWebSearch(deps)).toBeNull();
		expect(chainCalls).toHaveLength(0);
	});

	it("returns null when the bypass header says off", async () => {
		stubProvider();
		const headers = new Headers({ "x-better-ccflare-web-tools": "off" });
		const { deps } = makeHarness({ headers });

		expect(await maybeInterceptWebSearch(deps)).toBeNull();
		expect(chainCalls).toHaveLength(0);
	});

	it("synthesises the server-tool response and passes the query through", async () => {
		stubProvider();
		const { deps } = makeHarness();

		const response = await maybeInterceptWebSearch(deps);
		expect(response).not.toBeNull();
		if (!response) throw new Error("expected an intercepted response");

		const body = (await response.json()) as MessageBody;
		expect(body.content.map((block) => block.type)).toEqual([
			"server_tool_use",
			"web_search_tool_result",
			"text",
		]);

		expect(chainCalls).toHaveLength(1);
		expect(chainCalls[0]?.query).toBe(QUERY);
		// The row's maxResults (5) caps the requested 10.
		expect(chainCalls[0]?.max_results).toBe(5);
	});

	it("honours maxResultChars from config", async () => {
		stubProvider();
		const { deps } = makeHarness({ maxResultChars: 120 });

		const response = await maybeInterceptWebSearch(deps);
		if (!response) throw new Error("expected an intercepted response");

		const text = textBlock((await response.json()) as MessageBody);
		expect(text.length).toBeLessThanOrEqual(120);
		expect(text.endsWith("…[truncated]")).toBe(true);
	});

	it("returns null exactly once when no provider could serve the search", async () => {
		stubProvider();
		const { deps, info } = makeHarness();
		providersForTest = [];

		expect(await maybeInterceptWebSearch(deps)).toBeNull();
		expect(chainCalls).toHaveLength(0);
		expect(info.join("\n")).toContain("no provider available");
	});

	it("does not throw out of a misbehaving provider repository", async () => {
		stubProvider();
		const { deps, warn } = makeHarness();
		breakProviderRepository(deps);

		expect(await maybeInterceptWebSearch(deps)).toBeNull();
		expect(warn.join("\n")).toContain("chain exploded");
	});

	it("logs provider and hit count but never the query text", async () => {
		stubProvider();
		const canary = "canary-query-9e7f";
		const { deps, info } = makeHarness({
			body: searchBody({ query: canary }),
		});

		const response = await maybeInterceptWebSearch(deps);
		expect(response).not.toBeNull();

		const logged = info.join("\n");
		expect(logged).not.toContain(canary);
		expect(logged).toContain("tavily");
		expect(logged).toContain("2 hit(s)");
	});

	it("intercepts a future web_search tool version end to end", async () => {
		stubProvider();
		const { deps } = makeHarness({
			body: searchBody({ toolType: "web_search_20261231" }),
		});

		const response = await maybeInterceptWebSearch(deps);
		if (!response) throw new Error("expected an intercepted response");

		const body = (await response.json()) as MessageBody;
		expect(body.content[0]?.type).toBe("server_tool_use");
		expect(body.content[1]?.type).toBe("web_search_tool_result");
		expect(chainCalls).toHaveLength(1);
	});
});

describe("maybeInterceptWebSearch — traceability", () => {
	it("records an ok row with provider, hits and attribution", async () => {
		stubProvider();
		const sink = makeTraceSink();
		const { deps } = makeHarness({
			trace: sink,
			project: "/repo/project-a",
		});

		const response = await maybeInterceptWebSearch(deps);
		await sink.settle();

		expect(response).not.toBeNull();
		expect(sink.traces).toHaveLength(1);
		expect(sink.traces[0]).toEqual({
			tool: "web_search",
			providerId: PROVIDER_ROW_ID,
			providerKind: "tavily",
			accountId: null,
			project: "/repo/project-a",
			queryText: QUERY,
			queryChars: QUERY.length,
			resultCount: 2,
			latencyMs: expect.any(Number),
			status: "ok",
			errorCode: null,
		});
	});

	it("records an error row when every provider failed", async () => {
		stubProvider(() => new Response("upstream down", { status: 503 }));
		const sink = makeTraceSink();
		const { deps } = makeHarness({ trace: sink });

		expect(await maybeInterceptWebSearch(deps)).toBeNull();
		await sink.settle();

		expect(sink.traces).toHaveLength(1);
		expect(sink.traces[0]).toMatchObject({
			tool: "web_search",
			status: "error",
			// A failure names the row that failed, not just its kind: with two
			// Tavily rows configured, the kind alone says nothing about which
			// one broke.
			providerId: PROVIDER_ROW_ID,
			providerKind: "tavily",
			resultCount: null,
			queryText: QUERY,
		});
		expect(sink.traces[0]?.errorCode).toContain("503");
		expect(sink.traces[0]?.errorCode).not.toContain(PROVIDER_KEY);
	});

	it("records a fallthrough row when nothing was eligible", async () => {
		stubProvider();
		const sink = makeTraceSink();
		const { deps } = makeHarness({ trace: sink });
		providersForTest = [];

		expect(await maybeInterceptWebSearch(deps)).toBeNull();
		await sink.settle();

		expect(sink.traces).toHaveLength(1);
		expect(sink.traces[0]).toMatchObject({
			tool: "web_search",
			status: "fallthrough",
			providerId: null,
			providerKind: null,
			resultCount: null,
			errorCode: null,
		});
	});

	it("records a fallthrough row when the repository throws", async () => {
		const sink = makeTraceSink();
		const { deps } = makeHarness({ trace: sink });
		breakProviderRepository(deps);

		expect(await maybeInterceptWebSearch(deps)).toBeNull();
		await sink.settle();

		expect(sink.traces).toHaveLength(1);
		// The provider list never loaded, so nothing was attempted.
		expect(sink.traces[0]?.status).toBe("fallthrough");
	});

	it("records nothing when the request is not a helper request", async () => {
		stubProvider();
		for (const [enabled, pathname] of [
			[false, "/v1/messages"],
			[true, "/v1/complete"],
		] as const) {
			const sink = makeTraceSink();
			const { deps } = makeHarness({ enabled, pathname, trace: sink });

			expect(await maybeInterceptWebSearch(deps)).toBeNull();
			await sink.settle();
			expect(sink.traces).toHaveLength(0);
		}
		expect(chainCalls).toHaveLength(0);
	});

	it("does not change the response when the trace write fails, and only warns", async () => {
		stubProvider();
		const sink = makeTraceSink({ failWrites: true });
		const { deps, warn } = makeHarness({ trace: sink });

		const response = await maybeInterceptWebSearch(deps);
		await sink.settle();

		expect(response).not.toBeNull();
		const body = (await response?.json()) as MessageBody;
		expect(body.content.map((block) => block.type)).toEqual([
			"server_tool_use",
			"web_search_tool_result",
			"text",
		]);
		expect(warn.join("\n")).toContain("trace write failed");
	});

	it("does not change the response when the write throws synchronously", async () => {
		stubProvider();
		const sink = makeTraceSink({ throwSync: true });
		const { deps, warn } = makeHarness({ trace: sink });

		expect(await maybeInterceptWebSearch(deps)).not.toBeNull();
		expect(warn.join("\n")).toContain("sync trace failure");
	});

	it("stores the query in query_text but never the api key", async () => {
		const apiKeyCanary = "tvly-CANARY-api-key-1234567890";
		stubProvider();
		providersForTest = [makeProvider({ apiKey: apiKeyCanary })];
		const sink = makeTraceSink();
		const { deps, info } = makeHarness({ trace: sink });

		expect(await maybeInterceptWebSearch(deps)).not.toBeNull();
		await sink.settle();

		const row = sink.traces[0];
		expect(row?.queryText).toBe(QUERY);
		expect(row?.queryChars).toBe(QUERY.length);
		const flat = JSON.stringify(row);
		expect(flat).not.toContain(apiKeyCanary);
		expect(flat).not.toContain("apiKey");
		expect(info.join("\n")).not.toContain(apiKeyCanary);
	});
});
