import { describe, expect, it } from "bun:test";
import {
	SEARCH_PROVIDER_CATALOG,
	type SearchProvider,
	type SearchProviderInput,
	type SearchProviderPublic,
	type SearchProviderUpdate,
} from "@better-ccflare/types";
import {
	createSearchProviderHandlers,
	DuplicateLabelError,
	runSearchProviderTest,
	type SearchProviderStore,
	TAVILY_SEARCH_URL,
} from "../search-providers";

const SECRET = "tvly-SECRET-value-1234567890";

/**
 * In-memory store that mimics what the DB layer will do: mask the key on
 * reads, enforce unique labels, and treat apiKey "" / null as "clear".
 */
function createFakeStore(seed: Partial<SearchProvider>[] = []): {
	store: SearchProviderStore;
	rows: Map<string, SearchProvider>;
} {
	const rows = new Map<string, SearchProvider>();
	let nextId = 1;

	const toPublic = (row: SearchProvider): SearchProviderPublic => {
		const { apiKey: _key, ...rest } = row;
		return {
			...rest,
			apiKey: null,
			hasApiKey: Boolean(_key),
		} as unknown as SearchProviderPublic;
	};

	const findByLabel = (label: string) =>
		[...rows.values()].find((r) => r.label === label);

	const make = (input: SearchProviderInput): SearchProvider =>
		({
			id: `sp-${nextId++}`,
			provider: input.provider,
			label: input.label,
			apiKey: input.apiKey ?? null,
			priority: input.priority ?? 100,
			maxResults: input.maxResults ?? 5,
			extraConfig: input.extraConfig ?? null,
			tier: input.tier ?? "paid",
			enabled: input.enabled ?? true,
			createdAt: new Date().toISOString(),
			updatedAt: new Date().toISOString(),
		}) as unknown as SearchProvider;

	for (const s of seed) {
		const row = make(s as SearchProviderInput);
		Object.assign(row, s);
		rows.set(row.id, row);
	}

	const store: SearchProviderStore = {
		async getApiKey(id) {
			return rows.get(id)?.apiKey ?? null;
		},
		async list() {
			return [...rows.values()]
				.sort((a, b) => a.priority - b.priority)
				.map(toPublic);
		},
		async get(id) {
			const row = rows.get(id);
			return row ? toPublic(row) : null;
		},
		async create(input) {
			const row = make(input);
			if (findByLabel(row.label)) throw new DuplicateLabelError(row.label);
			rows.set(row.id, row);
			// API key is never echoed back
			return { ...toPublic(row), apiKey: null } as SearchProviderPublic;
		},
		async update(id, patch: SearchProviderUpdate) {
			const row = rows.get(id);
			if (!row) return null;
			const next = { ...row } as SearchProvider & Record<string, unknown>;
			if (patch.label !== undefined) {
				const other = findByLabel(patch.label);
				if (other && other.id !== id)
					throw new DuplicateLabelError(patch.label);
				next.label = patch.label;
			}
			if (patch.priority !== undefined) next.priority = patch.priority;
			if (patch.maxResults !== undefined) next.maxResults = patch.maxResults;
			if (patch.extraConfig !== undefined) next.extraConfig = patch.extraConfig;
			if (patch.enabled !== undefined) next.enabled = patch.enabled;
			if (patch.tier !== undefined) next.tier = patch.tier;
			if (patch.apiKey !== undefined) {
				next.apiKey =
					patch.apiKey === null || patch.apiKey === "" ? null : patch.apiKey;
			}
			rows.set(id, next as SearchProvider);
			return toPublic(next as SearchProvider);
		},
		async setFreeTierEnabled(enabled) {
			let changed = 0;
			for (const row of rows.values()) {
				if (row.tier === "free" && !row.apiKey && row.enabled !== enabled) {
					row.enabled = enabled;
					changed += 1;
				}
			}
			return changed;
		},
		async remove(id) {
			return rows.delete(id);
		},
		async listActiveByPriority() {
			return [...rows.values()]
				.filter((r) => r.enabled)
				.sort((a, b) => a.priority - b.priority);
		},
	};

	return { store, rows };
}

const PROVIDER_WITHOUT_KEY = SEARCH_PROVIDER_CATALOG.find(
	(entry) => !entry.requiresKey,
)?.id;
const PROVIDER_WITH_KEY =
	SEARCH_PROVIDER_CATALOG.find((entry) => entry.requiresKey)?.id ?? "tavily";

function jsonRequest(body: unknown, method = "POST"): Request {
	return new Request("http://localhost/api/search-providers", {
		method,
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
}

async function readJson(res: Response): Promise<Record<string, any>> {
	return (await res.json()) as Record<string, any>;
}

describe("search provider handlers", () => {
	it("lists providers with count", async () => {
		const { store } = createFakeStore([
			{ provider: "tavily", label: "Tavily", apiKey: SECRET },
		]);
		const handlers = createSearchProviderHandlers(store);
		const res = await handlers.list();
		expect(res.status).toBe(200);
		const body = await readJson(res);
		expect(body.success).toBe(true);
		expect(body.count).toBe(1);
		expect(body.data[0].label).toBe("Tavily");
	});

	it("creates a valid provider and returns 201 with a masked row", async () => {
		const { store } = createFakeStore();
		const handlers = createSearchProviderHandlers(store);
		const res = await handlers.create(
			jsonRequest({
				provider: PROVIDER_WITH_KEY,
				label: "  Primary  ",
				apiKey: SECRET,
				priority: 10,
				maxResults: 3,
			}),
		);
		expect(res.status).toBe(201);
		const text = await res.text();
		expect(text).not.toContain(SECRET);
		const body = JSON.parse(text);
		expect(body.data.label).toBe("Primary");
		expect(body.data.priority).toBe(10);
		expect(body.data.hasApiKey).toBe(true);
	});

	it("rejects an unknown provider with 400", async () => {
		const { store } = createFakeStore();
		const handlers = createSearchProviderHandlers(store);
		const res = await handlers.create(
			jsonRequest({ provider: "nope", label: "x", apiKey: "k" }),
		);
		expect(res.status).toBe(400);
	});

	it("rejects a missing apiKey for a provider that requires one", async () => {
		const { store } = createFakeStore();
		const handlers = createSearchProviderHandlers(store);
		const res = await handlers.create(
			jsonRequest({ provider: PROVIDER_WITH_KEY, label: "x" }),
		);
		expect(res.status).toBe(400);
		const body = await readJson(res);
		expect(String(body.error)).toContain("apiKey");
	});

	it("rejects an empty label and an over-long label", async () => {
		const { store } = createFakeStore();
		const handlers = createSearchProviderHandlers(store);
		const empty = await handlers.create(
			jsonRequest({ provider: PROVIDER_WITH_KEY, label: "   ", apiKey: "k" }),
		);
		expect(empty.status).toBe(400);
		const long = await handlers.create(
			jsonRequest({
				provider: PROVIDER_WITH_KEY,
				label: "a".repeat(65),
				apiKey: "k",
			}),
		);
		expect(long.status).toBe(400);
	});

	it("rejects out-of-range priority and maxResults", async () => {
		const { store } = createFakeStore();
		const handlers = createSearchProviderHandlers(store);
		for (const bad of [
			{ priority: -1 },
			{ priority: 1001 },
			{ priority: 1.5 },
			{ maxResults: 0 },
			{ maxResults: 51 },
		]) {
			const res = await handlers.create(
				jsonRequest({
					provider: PROVIDER_WITH_KEY,
					label: `l${Math.random()}`,
					apiKey: "k",
					...bad,
				}),
			);
			expect(res.status).toBe(400);
		}
	});

	it("rejects non-object extraConfig", async () => {
		const { store } = createFakeStore();
		const handlers = createSearchProviderHandlers(store);
		const res = await handlers.create(
			jsonRequest({
				provider: PROVIDER_WITH_KEY,
				label: "x",
				apiKey: "k",
				extraConfig: [1, 2],
			}),
		);
		expect(res.status).toBe(400);
	});

	it("surfaces a duplicate label as 409", async () => {
		const { store } = createFakeStore([
			{ provider: PROVIDER_WITH_KEY, label: "Dup", apiKey: SECRET },
		]);
		const handlers = createSearchProviderHandlers(store);
		const res = await handlers.create(
			jsonRequest({ provider: PROVIDER_WITH_KEY, label: "Dup", apiKey: "k" }),
		);
		expect(res.status).toBe(409);
	});

	it("toggles enabled via PATCH", async () => {
		const { store, rows } = createFakeStore([
			{ provider: PROVIDER_WITH_KEY, label: "A", apiKey: SECRET },
		]);
		const handlers = createSearchProviderHandlers(store);
		const id = [...rows.keys()][0];
		const res = await handlers.update(
			jsonRequest({ enabled: false }, "PATCH"),
			id,
		);
		expect(res.status).toBe(200);
		const body = await readJson(res);
		expect(body.data.enabled).toBe(false);
		expect((await store.listActiveByPriority()).length).toBe(0);
	});

	it("replaces apiKey on PATCH without echoing it", async () => {
		const { store, rows } = createFakeStore([
			{ provider: PROVIDER_WITH_KEY, label: "A", apiKey: SECRET },
		]);
		const handlers = createSearchProviderHandlers(store);
		const id = [...rows.keys()][0];
		const res = await handlers.update(
			jsonRequest({ apiKey: "tvly-new-key" }, "PATCH"),
			id,
		);
		expect(res.status).toBe(200);
		const text = await res.text();
		expect(text).not.toContain("tvly-new-key");
		expect(rows.get(id)?.apiKey).toBe("tvly-new-key");
	});

	it("clears apiKey on PATCH when the provider does not require one", async () => {
		if (!PROVIDER_WITHOUT_KEY) return;
		const { store, rows } = createFakeStore([
			{ provider: PROVIDER_WITHOUT_KEY, label: "B", apiKey: "old" },
		]);
		const handlers = createSearchProviderHandlers(store);
		const id = [...rows.keys()][0];
		const res = await handlers.update(jsonRequest({ apiKey: "" }, "PATCH"), id);
		expect(res.status).toBe(200);
		expect(rows.get(id)?.apiKey).toBeNull();
	});

	it("rejects clearing apiKey when the provider requires one", async () => {
		const { store, rows } = createFakeStore([
			{ provider: PROVIDER_WITH_KEY, label: "A", apiKey: SECRET },
		]);
		const handlers = createSearchProviderHandlers(store);
		const id = [...rows.keys()][0];
		const res = await handlers.update(jsonRequest({ apiKey: "" }, "PATCH"), id);
		expect(res.status).toBe(400);
		expect(rows.get(id)?.apiKey).toBe(SECRET);
	});

	it("rejects provider changes on PATCH", async () => {
		const { store, rows } = createFakeStore([
			{ provider: PROVIDER_WITH_KEY, label: "A", apiKey: SECRET },
		]);
		const handlers = createSearchProviderHandlers(store);
		const id = [...rows.keys()][0];
		const res = await handlers.update(
			jsonRequest({ provider: "other" }, "PATCH"),
			id,
		);
		expect(res.status).toBe(400);
	});

	it("returns 404 on PATCH of an unknown id", async () => {
		const { store } = createFakeStore();
		const handlers = createSearchProviderHandlers(store);
		const res = await handlers.update(
			jsonRequest({ enabled: true }, "PATCH"),
			"nope",
		);
		expect(res.status).toBe(404);
	});

	it("deletes a present provider and 404s an absent one", async () => {
		const { store, rows } = createFakeStore([
			{ provider: PROVIDER_WITH_KEY, label: "A", apiKey: SECRET },
		]);
		const handlers = createSearchProviderHandlers(store);
		const id = [...rows.keys()][0];
		const ok = await handlers.remove(id);
		expect(ok.status).toBe(200);
		expect(await readJson(ok)).toEqual({ success: true });
		const again = await handlers.remove(id);
		expect(again.status).toBe(404);
	});

	it("reorders via priority", async () => {
		const { store, rows } = createFakeStore([
			{ provider: PROVIDER_WITH_KEY, label: "A", apiKey: SECRET },
		]);
		const handlers = createSearchProviderHandlers(store);
		const id = [...rows.keys()][0];
		const ok = await handlers.reorder(jsonRequest({ priority: 7 }), id);
		expect(ok.status).toBe(200);
		expect((await readJson(ok)).data.priority).toBe(7);
		const bad = await handlers.reorder(jsonRequest({ priority: -5 }), id);
		expect(bad.status).toBe(400);
	});

	it("meta returns the catalog without touching the store", async () => {
		const store: SearchProviderStore = {
			getApiKey: async () => {
				throw new Error("store must not be called");
			},
			list: async () => {
				throw new Error("store must not be called");
			},
			get: async () => {
				throw new Error("store must not be called");
			},
			create: async () => {
				throw new Error("store must not be called");
			},
			update: async () => {
				throw new Error("store must not be called");
			},
			remove: async () => {
				throw new Error("store must not be called");
			},
			listActiveByPriority: async () => {
				throw new Error("store must not be called");
			},
		};
		const handlers = createSearchProviderHandlers(store);
		const res = handlers.meta();
		expect(res.status).toBe(200);
		const body = await readJson(res);
		expect(body.success).toBe(true);
		expect(body.data).toEqual(SEARCH_PROVIDER_CATALOG);
	});

	it("never echoes an apiKey across list/get/create/patch responses", async () => {
		const { store } = createFakeStore();
		const handlers = createSearchProviderHandlers(store);
		const created = await handlers.create(
			jsonRequest({
				provider: PROVIDER_WITH_KEY,
				label: "Secret",
				apiKey: SECRET,
			}),
		);
		const createdBody = await readJson(created);
		const id = createdBody.data.id;
		const responses = [
			await handlers.list(),
			await handlers.get(id),
			await handlers.update(
				jsonRequest({ apiKey: "another-secret" }, "PATCH"),
				id,
			),
		];
		for (const res of responses) {
			const text = await res.text();
			expect(text).not.toContain(SECRET);
			expect(text).not.toContain("another-secret");
		}
	});
});

describe("search provider /test", () => {
	const originalFetch = globalThis.fetch;
	const restore = () => {
		globalThis.fetch = originalFetch;
	};

	it("tavily test returns ok on a stubbed 200 with results", async () => {
		const calls: { url: string; init?: RequestInit }[] = [];
		globalThis.fetch = (async (
			input: RequestInfo | URL,
			init?: RequestInit,
		) => {
			calls.push({ url: String(input), init });
			return new Response(JSON.stringify({ results: [{ title: "x" }] }), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		}) as typeof fetch;

		try {
			const { store, rows } = createFakeStore([
				{ provider: "tavily", label: "T", apiKey: SECRET },
			]);
			const handlers = createSearchProviderHandlers(store);
			// The store only exposes the masked public row, so the handler
			// resolves the secret key through getApiKey(id) for the outbound call.
			let requestedId: string | null = null;
			const res = await handlers.test([...rows.keys()][0], (id) => {
				requestedId = id;
				return Promise.resolve(SECRET);
			});
			expect(requestedId).toBe([...rows.keys()][0]);
			expect(res.status).toBe(200);
			const body = await readJson(res);
			expect(body.data.latencyMs).toBeGreaterThanOrEqual(0);
			expect(calls.length).toBe(1);
			expect(calls[0]?.url).toBe(TAVILY_SEARCH_URL);
			const headers = calls[0]?.init?.headers as Record<string, string>;
			expect(headers.Authorization).toBe(`Bearer ${SECRET}`);
			expect(calls[0]?.init?.method).toBe("POST");
		} finally {
			restore();
		}
	});

	it("tavily test reports failure on a non-2xx response", async () => {
		globalThis.fetch = (async () =>
			new Response(JSON.stringify({ error: "unauthorized" }), {
				status: 401,
				headers: { "content-type": "application/json" },
			})) as typeof fetch;
		try {
			const { store, rows } = createFakeStore([
				{ provider: "tavily", label: "T", apiKey: SECRET },
			]);
			const handlers = createSearchProviderHandlers(store);
			const res = await handlers.test([...rows.keys()][0]);
			const body = await readJson(res);
			expect(body.data.ok).toBe(false);
		} finally {
			restore();
		}
	});

	it("unimplemented providers return ok:false without any fetch call", async () => {
		let called = false;
		globalThis.fetch = (async () => {
			called = true;
			return new Response("{}", { status: 200 });
		}) as typeof fetch;

		try {
			const otherProvider = Object.keys(SEARCH_PROVIDER_CATALOG).find(
				(p) => p !== "tavily",
			);
			if (!otherProvider) return;
			const { store, rows } = createFakeStore([
				{ provider: otherProvider, label: "O", apiKey: "k" },
			]);
			const handlers = createSearchProviderHandlers(store);
			const res = await handlers.test([...rows.keys()][0]);
			const body = await readJson(res);
			expect(body.data).toEqual({
				ok: false,
				latencyMs: 0,
				error: "provider not implemented yet",
			});
			expect(called).toBe(false);
		} finally {
			restore();
		}
	});

	it("returns 404 for an unknown provider id", async () => {
		const { store } = createFakeStore();
		const handlers = createSearchProviderHandlers(store);
		const res = await handlers.test("nope");
		expect(res.status).toBe(404);
	});
});

describe("search provider handlers — edit and create round-trips", () => {
	it("accepts an unchanged `provider` on PATCH instead of rejecting it", async () => {
		const { store, rows } = createFakeStore([
			{ provider: PROVIDER_WITH_KEY, label: "Round-trip", apiKey: SECRET },
		]);
		const handlers = createSearchProviderHandlers(store);
		const id = [...rows.keys()][0];

		// A dashboard edit sends the whole row back, including `provider`.
		const res = await handlers.update(
			jsonRequest(
				{ provider: PROVIDER_WITH_KEY, label: "Renamed", maxResults: 3 },
				"PATCH",
			),
			id,
		);

		expect(res.status).toBe(200);
		const body = await readJson(res);
		expect(body.data.label).toBe("Renamed");
		expect(body.data.maxResults).toBe(3);
	});

	it("still rejects an actual provider change on PATCH", async () => {
		const otherProvider = SEARCH_PROVIDER_CATALOG.find(
			(entry) => entry.id !== PROVIDER_WITH_KEY,
		)?.id as string;
		const { store, rows } = createFakeStore([
			{ provider: PROVIDER_WITH_KEY, label: "Fixed", apiKey: SECRET },
		]);
		const handlers = createSearchProviderHandlers(store);
		const id = [...rows.keys()][0];

		const res = await handlers.update(
			jsonRequest({ provider: otherProvider, label: "Fixed" }, "PATCH"),
			id,
		);
		expect(res.status).toBe(400);
	});

	it("passes `enabled: false` through to create", async () => {
		const seen: SearchProviderInput[] = [];
		const { store } = createFakeStore();
		const spyStore: SearchProviderStore = {
			...store,
			async create(input) {
				seen.push(input);
				return store.create(input);
			},
		};
		const handlers = createSearchProviderHandlers(spyStore);

		const res = await handlers.create(
			jsonRequest({
				provider: PROVIDER_WITH_KEY,
				label: "Disabled from birth",
				apiKey: "k",
				enabled: false,
			}),
		);

		expect(res.status).toBe(201);
		expect(seen[0]?.enabled).toBe(false);
	});
});

describe("search provider test — adapter delegation", () => {
	// The Test button used to hard-code Tavily and answer "not implemented"
	// for every other provider, even once they had adapters. It now runs the
	// adapter's own test(), so the button exercises the real URL and auth.
	it("tests a non-Tavily provider through its adapter", async () => {
		const calls: Array<{ url: string; init?: RequestInit }> = [];
		const original = globalThis.fetch;
		globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
			calls.push({ url: String(url), init });
			return new Response(JSON.stringify({ organic: [] }), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		}) as unknown as typeof fetch;

		try {
			const result = await runSearchProviderTest({
				provider: "serper",
				apiKey: "serper-canary-key",
			});

			expect(result.ok).toBe(true);
			expect(calls).toHaveLength(1);
			expect(calls[0]?.url).toContain("google.serper.dev");
			const headers = calls[0]?.init?.headers as Record<string, string>;
			// Serper's non-Bearer header is the whole point of delegating.
			expect(headers["X-API-KEY"]).toBe("serper-canary-key");
			expect(headers.Authorization).toBeUndefined();
		} finally {
			globalThis.fetch = original;
		}
	});

	it("still reports a provider with no adapter without making a call", async () => {
		let called = false;
		const original = globalThis.fetch;
		globalThis.fetch = (async () => {
			called = true;
			return new Response("{}", { status: 200 });
		}) as unknown as typeof fetch;
		try {
			const result = await runSearchProviderTest({
				provider: "perplexity",
				apiKey: "k",
			});
			expect(result.ok).toBe(false);
			expect(result.error).toContain("not implemented");
			expect(called).toBe(false);
		} finally {
			globalThis.fetch = original;
		}
	});
});

describe("keyless (free-tier) search providers", () => {
	it("lets a keyless-capable provider be created without a key", async () => {
		if (!PROVIDER_WITHOUT_KEY) return;
		const { store, rows } = createFakeStore();
		const handlers = createSearchProviderHandlers(store);

		const res = await handlers.create(
			jsonRequest({
				provider: PROVIDER_WITHOUT_KEY,
				label: "Free",
				tier: "free",
			}),
		);

		expect(res.status).toBe(201);
		const row = [...rows.values()][0];
		expect(row.apiKey).toBeNull();
		expect(row.tier).toBe("free");
	});

	it("still refuses a keyed-only provider with no key", async () => {
		const { store } = createFakeStore();
		const handlers = createSearchProviderHandlers(store);

		const res = await handlers.create(
			jsonRequest({ provider: PROVIDER_WITH_KEY, label: "No key" }),
		);

		expect(res.status).toBe(400);
	});

	it("tests a keyless row unauthenticated instead of refusing it", async () => {
		// A real adapter call would hit the network; assert only that the
		// "no apiKey configured" short-circuit no longer fires.
		const result = await runSearchProviderTest({
			provider: "perplexity-implemented-check",
			apiKey: null,
		});
		// Unknown provider → "not implemented", never "no apiKey configured".
		expect(result.error).not.toBe("no apiKey configured");
	});

	it("toggles every free-tier row and leaves keyed rows alone", async () => {
		if (!PROVIDER_WITHOUT_KEY) return;
		const { store, rows } = createFakeStore([
			{
				provider: PROVIDER_WITHOUT_KEY,
				label: "A (free)",
				apiKey: null,
				tier: "free",
				enabled: false,
			},
			{
				provider: PROVIDER_WITHOUT_KEY,
				label: "B (free)",
				apiKey: null,
				tier: "free",
				enabled: false,
			},
			{ provider: PROVIDER_WITH_KEY, label: "Paid", apiKey: SECRET },
		]);
		const handlers = createSearchProviderHandlers(store);

		const on = await handlers.setFreeTier(
			jsonRequest({ enabled: true }, "PATCH"),
		);
		expect(on.status).toBe(200);
		expect((await readJson(on)).data.changed).toBe(2);
		expect(
			[...rows.values()]
				.filter((r) => r.tier === "free")
				.every((r) => r.enabled),
		).toBe(true);
		expect([...rows.values()].find((r) => r.label === "Paid")?.enabled).toBe(
			true,
		);

		const off = await handlers.setFreeTier(
			jsonRequest({ enabled: false }, "PATCH"),
		);
		expect(off.status).toBe(200);
		expect(
			[...rows.values()]
				.filter((r) => r.tier === "free")
				.every((r) => !r.enabled),
		).toBe(true);
		expect([...rows.values()].find((r) => r.label === "Paid")?.enabled).toBe(
			true,
		);
	});

	it("rejects a toggle body without a boolean enabled", async () => {
		const { store } = createFakeStore();
		const handlers = createSearchProviderHandlers(store);

		const res = await handlers.setFreeTier(
			jsonRequest({ enabled: "yes" }, "PATCH"),
		);

		expect(res.status).toBe(400);
	});
});

describe("free/paid tier is derived from the key, never trusted from the client", () => {
	it("adding a key to a free row turns it paid, so the toggle can no longer reach it", async () => {
		if (!PROVIDER_WITHOUT_KEY) return;
		const { store, rows } = createFakeStore([
			{ provider: PROVIDER_WITHOUT_KEY, label: "Free", tier: "free" },
		]);
		const handlers = createSearchProviderHandlers(store);
		const id = [...rows.keys()][0];

		const res = await handlers.update(
			jsonRequest({ apiKey: "k-1234" }, "PATCH"),
			id,
		);
		expect(res.status).toBe(200);
		expect(rows.get(id)?.tier).toBe("paid");
		expect(rows.get(id)?.apiKey).toBe("k-1234");

		// Disabling the free tier must not switch this (now paid) row off.
		await handlers.setFreeTier(jsonRequest({ enabled: false }, "PATCH"));
		expect(rows.get(id)?.enabled).toBe(true);
	});

	it("clearing the key turns a paid row back into a free row", async () => {
		if (!PROVIDER_WITHOUT_KEY) return;
		const { store, rows } = createFakeStore([
			{ provider: PROVIDER_WITHOUT_KEY, label: "Paid", apiKey: "k-old" },
		]);
		const handlers = createSearchProviderHandlers(store);
		const id = [...rows.keys()][0];
		expect(rows.get(id)?.tier).toBe("paid");

		const res = await handlers.update(jsonRequest({ apiKey: "" }, "PATCH"), id);
		expect(res.status).toBe(200);
		expect(rows.get(id)?.tier).toBe("free");
	});

	it("a keyless-capable row created with no key is stored as free", async () => {
		if (!PROVIDER_WITHOUT_KEY) return;
		const { store, rows } = createFakeStore();
		const handlers = createSearchProviderHandlers(store);

		await handlers.create(
			jsonRequest({ provider: PROVIDER_WITHOUT_KEY, label: "Free" }),
		);

		expect([...rows.values()][0]?.tier).toBe("free");
	});

	it("rejects a client claiming 'free' while supplying a key", async () => {
		if (!PROVIDER_WITHOUT_KEY) return;
		const { store } = createFakeStore();
		const handlers = createSearchProviderHandlers(store);

		const res = await handlers.create(
			jsonRequest({
				provider: PROVIDER_WITHOUT_KEY,
				label: "X",
				apiKey: "k-1",
				tier: "free",
			}),
		);

		expect(res.status).toBe(400);
	});

	it("rejects a client claiming 'paid' with no key", async () => {
		if (!PROVIDER_WITHOUT_KEY) return;
		const { store } = createFakeStore();
		const handlers = createSearchProviderHandlers(store);

		const res = await handlers.create(
			jsonRequest({
				provider: PROVIDER_WITHOUT_KEY,
				label: "X",
				tier: "paid",
			}),
		);

		expect(res.status).toBe(400);
	});

	it("refuses 'free' for a provider that has no keyless endpoint", async () => {
		const { store } = createFakeStore();
		const handlers = createSearchProviderHandlers(store);

		const res = await handlers.create(
			jsonRequest({
				provider: PROVIDER_WITH_KEY,
				label: "X",
				apiKey: "k-1",
				tier: "free",
			}),
		);

		expect(res.status).toBe(400);
	});
});
