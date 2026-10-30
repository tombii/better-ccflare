/**
 * Tests for the web-search interception orchestrator.
 *
 * No network: the provider chain is stubbed (see the `beforeAll` note below)
 * and the config/dbOps are hand-rolled fakes. What matters here is the
 * decision — intercept, fall through, or bail out — plus the shape handed back
 * to the proxy, not provider behaviour (covered by `chain.test.ts`).
 */

import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	mock,
} from "bun:test";
import type { WebToolChainResult } from "../chain";
import type { WebSearchInterceptDeps } from "../intercept";
import type { WebToolSearchRequest } from "../types";

type ChainImplementation = (
	request: WebToolSearchRequest,
) => Promise<WebToolChainResult | null>;

let chainCalls: WebToolSearchRequest[] = [];
let chainImplementation: ChainImplementation = async () => null;

let actualChain: typeof import("../chain");
let maybeInterceptWebSearch: typeof import("../intercept").maybeInterceptWebSearch;

// mock.module is process-global across test files in Bun, so the stub is
// registered in `beforeAll` and reverted in `afterAll` rather than at module
// top level — a top-level call would replace the real chain for
// `chain.test.ts` as well. The import of `../intercept` therefore happens
// after the stub is in place, so its binding points at the stub.
beforeAll(async () => {
	actualChain = await import("../chain");
	mock.module("../chain", () => ({
		...actualChain,
		runWebSearchChain: async (
			_deps: unknown,
			request: WebToolSearchRequest,
		): Promise<WebToolChainResult | null> => {
			chainCalls.push(request);
			return chainImplementation(request);
		},
	}));
	({ maybeInterceptWebSearch } = await import("../intercept"));
});

afterAll(() => {
	mock.module("../chain", () => actualChain);
});

beforeEach(() => {
	chainCalls = [];
	chainImplementation = async () => null;
});

const QUERY = "how do bun test mocks work";

const CHAIN_RESULT: WebToolChainResult = {
	hits: [
		{
			title: "bun:test docs",
			url: "https://bun.com/docs/test",
			snippet: "The bun:test API reference.",
		},
		{
			title: "Mocking modules",
			url: "https://bun.com/docs/test/mocks",
			snippet: "mock.module replaces a module in the registry.",
		},
	],
	providerId: "tavily",
	providerLabel: "Tavily",
	latencyMs: 42,
};

/** The chain is stubbed, so dbOps must never be touched. */
const FAKE_DB_OPS = {
	getSearchProviderRepository: () => {
		throw new Error("dbOps must not be used while the chain is stubbed");
	},
} as unknown as WebSearchInterceptDeps["dbOps"];

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
		dbOps: FAKE_DB_OPS,
		log: {
			info: (message: string) => info.push(message),
			warn: (message: string) => warn.push(message),
		},
	};
	return { deps, info, warn };
}

function textBlock(body: MessageBody): string {
	const block = body.content.find((entry) => entry.type === "text");
	return block?.text ?? "";
}

describe("maybeInterceptWebSearch", () => {
	it("returns null and never runs the chain when the master toggle is off", async () => {
		chainImplementation = async () => CHAIN_RESULT;
		const { deps } = makeHarness({ enabled: false });

		expect(await maybeInterceptWebSearch(deps)).toBeNull();
		expect(chainCalls).toHaveLength(0);
	});

	it("returns null for paths other than /v1/messages", async () => {
		chainImplementation = async () => CHAIN_RESULT;
		const { deps } = makeHarness({ pathname: "/v1/complete" });

		expect(await maybeInterceptWebSearch(deps)).toBeNull();
		expect(chainCalls).toHaveLength(0);
	});

	it("returns null when the bypass header says off", async () => {
		chainImplementation = async () => CHAIN_RESULT;
		const headers = new Headers({ "x-better-ccflare-web-tools": "off" });
		const { deps } = makeHarness({ headers });

		expect(await maybeInterceptWebSearch(deps)).toBeNull();
		expect(chainCalls).toHaveLength(0);
	});

	it("synthesises the server-tool response and passes the query through", async () => {
		chainImplementation = async () => CHAIN_RESULT;
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
		expect(chainCalls[0]?.maxResults).toBe(10);
	});

	it("honours maxResultChars from config", async () => {
		chainImplementation = async () => CHAIN_RESULT;
		const { deps } = makeHarness({ maxResultChars: 120 });

		const response = await maybeInterceptWebSearch(deps);
		if (!response) throw new Error("expected an intercepted response");

		const text = textBlock((await response.json()) as MessageBody);
		expect(text.length).toBeLessThanOrEqual(120);
		expect(text.endsWith("…[truncated]")).toBe(true);
	});

	it("returns null exactly once when no provider could serve the search", async () => {
		const { deps, info } = makeHarness();

		expect(await maybeInterceptWebSearch(deps)).toBeNull();
		expect(chainCalls).toHaveLength(1);
		expect(info.join("\n")).toContain("no provider available");
	});

	it("swallows a chain throw and falls through with a warning", async () => {
		chainImplementation = async () => {
			throw new Error("chain exploded");
		};
		const { deps, warn } = makeHarness();

		expect(await maybeInterceptWebSearch(deps)).toBeNull();
		expect(warn).toHaveLength(1);
		expect(warn[0]).toContain("chain exploded");
	});

	it("logs provider and hit count but never the query text", async () => {
		chainImplementation = async () => CHAIN_RESULT;
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
		chainImplementation = async () => CHAIN_RESULT;
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
