/**
 * Tests for the web-search provider fallback chain.
 *
 * A fake repository and a stubbed `globalThis.fetch` keep every test off the
 * network. Providers are keyed by their API key in the fetch stub so the
 * assertions can prove which row was attempted and in what order.
 */
import { afterEach, describe, expect, it } from "bun:test";
import type { SearchProvider } from "@better-ccflare/types";
import { runWebSearchChain, type WebToolChainDeps } from "../chain";
import type { WebToolSearchRequest } from "../types";

const originalFetch = globalThis.fetch;

afterEach(() => {
	globalThis.fetch = originalFetch;
});

const NOW = 1_000_000;

function makeProvider(overrides: Partial<SearchProvider> = {}): SearchProvider {
	return {
		id: "provider-1",
		provider: "tavily",
		label: "Tavily",
		apiKey: "key-default",
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

interface HealthWrite {
	id: string;
	status: string;
	statusMessage: string | null;
	cooldownUntil: number | null;
}

function makeDeps(
	providers: SearchProvider[] | Error,
	options: { failHealthWrites?: boolean } = {},
): {
	deps: WebToolChainDeps;
	health: HealthWrite[];
	warnings: string[];
} {
	const health: HealthWrite[] = [];
	const warnings: string[] = [];
	const repo = {
		listActiveByPriority: async () => {
			if (providers instanceof Error) throw providers;
			return providers;
		},
		updateHealth: async (
			id: string,
			update: {
				status: string;
				statusMessage?: string | null;
				cooldownUntil?: number | null;
			},
		) => {
			if (options.failHealthWrites) throw new Error("health write failed");
			health.push({
				id,
				status: update.status,
				statusMessage: update.statusMessage ?? null,
				cooldownUntil: update.cooldownUntil ?? null,
			});
		},
	};
	const deps = {
		dbOps: { getSearchProviderRepository: () => repo },
		now: () => NOW,
		log: { warn: (message: string) => warnings.push(message) },
	} as unknown as WebToolChainDeps;
	return { deps, health, warnings };
}

function stubFetchByKey(
	handlers: Record<string, () => Response | Promise<Response>>,
): { attempted: string[] } {
	const attempted: string[] = [];
	globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
		const headers = new Headers(init?.headers as HeadersInit | undefined);
		const key = (headers.get("Authorization") ?? "").replace(/^Bearer /, "");
		attempted.push(key);
		const handler = handlers[key];
		if (!handler) throw new Error(`unexpected api key: ${key}`);
		return handler();
	}) as typeof fetch;
	return { attempted };
}

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

function results(...urls: string[]): Response {
	return jsonResponse({
		results: urls.map((url) => ({ title: url, url, content: `about ${url}` })),
	});
}

const searchRequest: WebToolSearchRequest = {
	query: "how do bun test mocks work",
	maxResults: 3,
};

describe("runWebSearchChain — provider selection", () => {
	it("returns the first successful provider's hits", async () => {
		const { deps, health } = makeDeps([
			makeProvider({ id: "a", label: "A", apiKey: "key-a" }),
			makeProvider({ id: "b", label: "B", apiKey: "key-b" }),
		]);
		const { attempted } = stubFetchByKey({
			"key-a": () => results("https://a.example/1"),
			"key-b": () => results("https://b.example/1"),
		});

		const result = await runWebSearchChain(deps, searchRequest);

		expect(attempted).toEqual(["key-a"]);
		expect(result).not.toBeNull();
		expect(result?.providerId).toBe("tavily");
		expect(result?.providerLabel).toBe("A");
		expect(result?.hits).toHaveLength(1);
		expect(result?.hits[0].url).toBe("https://a.example/1");
		expect(result?.latencyMs).toBeGreaterThanOrEqual(0);
		expect(health).toEqual([
			{
				id: "a",
				status: "ok",
				statusMessage: null,
				cooldownUntil: null,
			},
		]);
	});

	it("preserves the repository's ordering between providers", async () => {
		// The repository sorts by priority; the chain must not reorder.
		const { deps } = makeDeps([
			makeProvider({ id: "second", label: "Second", apiKey: "key-second" }),
			makeProvider({ id: "first", label: "First", apiKey: "key-first" }),
		]);
		const { attempted } = stubFetchByKey({
			"key-second": () => results("https://second.example"),
			"key-first": () => results("https://first.example"),
		});

		const result = await runWebSearchChain(deps, searchRequest);

		expect(attempted).toEqual(["key-second"]);
		expect(result?.providerLabel).toBe("Second");
	});

	it("skips a provider whose cooldown is still in the future", async () => {
		const { deps, health } = makeDeps([
			makeProvider({
				id: "cooling",
				label: "Cooling",
				apiKey: "key-cooling",
				cooldownUntil: NOW + 60_000,
			}),
			makeProvider({ id: "ready", label: "Ready", apiKey: "key-ready" }),
		]);
		const { attempted } = stubFetchByKey({
			"key-ready": () => results("https://ready.example"),
		});

		const result = await runWebSearchChain(deps, searchRequest);

		expect(attempted).toEqual(["key-ready"]);
		expect(result?.providerLabel).toBe("Ready");
		// No attempt means no health write for the skipped row.
		expect(health.map((write) => write.id)).toEqual(["ready"]);
	});

	it("retries a provider whose cooldown has expired", async () => {
		const { deps } = makeDeps([
			makeProvider({
				id: "expired",
				label: "Expired",
				apiKey: "key-expired",
				cooldownUntil: NOW - 1,
			}),
		]);
		const { attempted } = stubFetchByKey({
			"key-expired": () => results("https://expired.example"),
		});

		const result = await runWebSearchChain(deps, searchRequest);

		expect(attempted).toEqual(["key-expired"]);
		expect(result).not.toBeNull();
	});

	it("skips providers with no adapter (not yet implemented)", async () => {
		const { deps } = makeDeps([
			makeProvider({
				id: "exa",
				provider: "exa",
				label: "Exa",
				apiKey: "key-exa",
			}),
			makeProvider({ id: "tavily", label: "Tavily", apiKey: "key-tavily" }),
		]);
		const { attempted } = stubFetchByKey({
			"key-tavily": () => results("https://tavily.example"),
		});

		const result = await runWebSearchChain(deps, searchRequest);

		expect(attempted).toEqual(["key-tavily"]);
		expect(result?.providerLabel).toBe("Tavily");
	});

	it("skips a key-requiring provider that has no key stored", async () => {
		const { deps } = makeDeps([
			makeProvider({ id: "keyless", label: "Keyless", apiKey: null }),
			makeProvider({ id: "keyed", label: "Keyed", apiKey: "key-keyed" }),
		]);
		const { attempted } = stubFetchByKey({
			"key-keyed": () => results("https://keyed.example"),
		});

		const result = await runWebSearchChain(deps, searchRequest);

		expect(attempted).toEqual(["key-keyed"]);
		expect(result?.providerLabel).toBe("Keyed");
	});

	it("returns null when no provider is eligible", async () => {
		const { deps } = makeDeps([
			makeProvider({ id: "keyless", apiKey: null }),
			makeProvider({ id: "cooling", cooldownUntil: NOW + 1 }),
		]);
		const { attempted } = stubFetchByKey({});

		expect(await runWebSearchChain(deps, searchRequest)).toBeNull();
		expect(attempted).toEqual([]);
	});

	it("returns null when the caller signal is already aborted", async () => {
		const { deps } = makeDeps([makeProvider({ apiKey: "key-a" })]);
		const { attempted } = stubFetchByKey({
			"key-a": () => results("https://a.example"),
		});

		const result = await runWebSearchChain(
			{ ...deps, signal: AbortSignal.abort() },
			searchRequest,
		);

		expect(result).toBeNull();
		expect(attempted).toEqual([]);
	});

	it("returns null when the provider list cannot be loaded", async () => {
		const { deps, warnings } = makeDeps(new Error("db offline"));

		expect(await runWebSearchChain(deps, searchRequest)).toBeNull();
		expect(warnings.join("\n")).toContain("db offline");
	});
});

describe("runWebSearchChain — fallback behaviour", () => {
	it("falls through to the next provider when one throws", async () => {
		const { deps, health } = makeDeps([
			makeProvider({ id: "a", label: "A", apiKey: "key-a" }),
			makeProvider({ id: "b", label: "B", apiKey: "key-b" }),
		]);
		const { attempted } = stubFetchByKey({
			"key-a": () => jsonResponse({ detail: "rate limited" }, 429),
			"key-b": () => results("https://b.example/1"),
		});

		const result = await runWebSearchChain(deps, searchRequest);

		expect(attempted).toEqual(["key-a", "key-b"]);
		expect(result?.providerLabel).toBe("B");
		expect(result?.hits[0].url).toBe("https://b.example/1");
		expect(health).toEqual([
			{
				id: "a",
				status: "error",
				statusMessage: expect.stringContaining("429"),
				cooldownUntil: NOW + 5 * 60_000,
			},
			{
				id: "b",
				status: "ok",
				statusMessage: null,
				cooldownUntil: null,
			},
		]);
	});

	it("does not fall through when a provider returns no hits", async () => {
		const { deps, health } = makeDeps([
			makeProvider({ id: "a", label: "A", apiKey: "key-a" }),
			makeProvider({ id: "b", label: "B", apiKey: "key-b" }),
		]);
		const { attempted } = stubFetchByKey({
			"key-a": () => results(),
			"key-b": () => results("https://b.example/1"),
		});

		const result = await runWebSearchChain(deps, searchRequest);

		expect(attempted).toEqual(["key-a"]);
		expect(result).not.toBeNull();
		expect(result?.providerLabel).toBe("A");
		expect(result?.hits).toEqual([]);
		expect(health).toEqual([
			{ id: "a", status: "ok", statusMessage: null, cooldownUntil: null },
		]);
	});

	it("returns null when every provider fails", async () => {
		const { deps, health } = makeDeps([
			makeProvider({ id: "a", label: "A", apiKey: "key-a" }),
			makeProvider({ id: "b", label: "B", apiKey: "key-b" }),
		]);
		const { attempted } = stubFetchByKey({
			"key-a": () => jsonResponse({ detail: "boom" }, 500),
			"key-b": () => jsonResponse({ detail: "boom again" }, 503),
		});

		const result = await runWebSearchChain(deps, searchRequest);

		expect(result).toBeNull();
		expect(attempted).toEqual(["key-a", "key-b"]);
		expect(health).toHaveLength(2);
		expect(health.every((write) => write.status === "error")).toBe(true);
	});

	it("reports a successful search even when the health write fails", async () => {
		const { deps } = makeDeps([makeProvider({ apiKey: "key-a" })], {
			failHealthWrites: true,
		});
		stubFetchByKey({ "key-a": () => results("https://a.example/1") });

		const result = await runWebSearchChain(deps, searchRequest);

		expect(result?.hits).toHaveLength(1);
	});
});

describe("runWebSearchChain — health accounting", () => {
	const expectedCooldowns: Array<[number, number | null]> = [
		[401, 10 * 60_000],
		[402, 30 * 60_000],
		[429, 5 * 60_000],
		[500, null],
	];

	for (const [status, cooldownMs] of expectedCooldowns) {
		it(`maps a ${status} failure to ${cooldownMs ?? "no"} cooldown`, async () => {
			const { deps, health } = makeDeps([
				makeProvider({ id: "a", apiKey: "key-a" }),
			]);
			stubFetchByKey({
				"key-a": () => jsonResponse({ detail: "failure" }, status),
			});

			await runWebSearchChain(deps, searchRequest);

			expect(health).toHaveLength(1);
			expect(health[0].status).toBe("error");
			expect(health[0].cooldownUntil).toBe(
				cooldownMs === null ? null : NOW + cooldownMs,
			);
		});
	}

	it("never leaks the API key into health messages or logs", async () => {
		const canary = "tvly-CANARY-secret-value";
		const { deps, health, warnings } = makeDeps([
			makeProvider({ id: "a", label: "A", apiKey: canary }),
		]);
		globalThis.fetch = (async () => {
			// Simulates a badly behaved adapter/upstream echoing the credential.
			throw new Error(`upstream rejected ${canary}`);
		}) as typeof fetch;

		await runWebSearchChain(deps, searchRequest);

		expect(health).toHaveLength(1);
		expect(health[0].statusMessage).not.toContain(canary);
		expect(health[0].statusMessage).toContain("[redacted]");
		expect(warnings.join("\n")).not.toContain(canary);
	});
});

describe("runWebSearchChain — request pass-through", () => {
	it("uses the request's fields and the row's config", async () => {
		const { deps } = makeDeps([
			makeProvider({ id: "a", apiKey: "key-a", maxResults: 9 }),
		]);
		let sentBody: Record<string, unknown> | undefined;
		globalThis.fetch = (async (
			_input: RequestInfo | URL,
			init?: RequestInit,
		) => {
			sentBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
			return results("https://a.example/1");
		}) as typeof fetch;

		await runWebSearchChain(deps, {
			query: "bun abort signal any",
			maxResults: 4,
			allowedDomains: ["bun.sh"],
		});

		expect(sentBody).toEqual({
			query: "bun abort signal any",
			max_results: 4,
			search_depth: "basic",
			include_domains: ["bun.sh"],
		});
	});

	it("forwards the row's extraConfig to the adapter", async () => {
		const { deps } = makeDeps([
			makeProvider({
				id: "a",
				apiKey: "key-a",
				extraConfig: { topic: "news", includeRawContent: true },
			}),
		]);
		let sentBody: Record<string, unknown> | undefined;
		globalThis.fetch = (async (
			_input: RequestInfo | URL,
			init?: RequestInit,
		) => {
			sentBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
			return results("https://news.example/1");
		}) as typeof fetch;

		await runWebSearchChain(deps, searchRequest);

		expect(sentBody?.topic).toBe("news");
		expect(sentBody?.include_raw_content).toBe(true);
	});
});
