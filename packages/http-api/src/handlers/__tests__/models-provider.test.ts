import { afterAll, beforeEach, describe, expect, it, mock } from "bun:test";
import { CODEX_KNOWN_MODELS } from "@better-ccflare/providers";
import type { APIContext } from "@better-ccflare/types";

// listCatalogueModels is the seam to the shared models.dev catalogue, and the
// real one performs network I/O. Stub it so these tests are offline and
// deterministic.
//
// mock.module must run at top level and replaces the WHOLE module globally
// and across file boundaries in Bun (no per-file isolation without
// --isolate), so we capture the real @better-ccflare/core exports first,
// spread them, and restore them in afterAll — same discipline as
// oauth.test.ts. The handler is then imported dynamically, AFTER the mock is
// registered, so its `listCatalogueModels` binding is the stub beyond any
// doubt about import ordering.
const actualCore = await import("@better-ccflare/core");

/** What the stubbed catalogue returns; set per test. */
let catalogueEntries: Array<{ id: string; name: string }> = [];
/** Every models.dev section the handler asked for, in order. */
let catalogueCalls: string[] = [];

const stubListCatalogueModels = async (section: string) => {
	catalogueCalls.push(section);
	return catalogueEntries;
};

mock.module("@better-ccflare/core", () => ({
	...actualCore,
	listCatalogueModels: stubListCatalogueModels,
}));

afterAll(() => {
	mock.module("@better-ccflare/core", () => actualCore);
});

const { createModelsHandler } = await import("../models");

interface ListedModel {
	id: string;
	displayName: string;
	source: string;
	createdAt?: string | null;
}

interface ModelsBody {
	models: ListedModel[];
	fetchedAt: number;
	source: string;
	provider: string;
	referenceSection?: string;
	warning?: string;
}

const CATALOG_FETCHED_AT = 1_700_000_000_000;

/** Context carrying a canned Anthropic catalog — the only dependency of the
 * no-provider / anthropic branch. */
function makeContext(): APIContext {
	return {
		modelCatalog: {
			get: async () => ({
				models: [
					{
						id: "claude-sonnet-4-5-20250929",
						displayName: "Claude Sonnet 4.5",
						createdAt: "2025-09-29T00:00:00Z",
					},
				],
				fetchedAt: CATALOG_FETCHED_AT,
				source: "live" as const,
			}),
			refresh: async () => ({ success: true }),
		},
	} as unknown as APIContext;
}

/** Find one listed model, failing loudly instead of returning undefined. */
function listed(body: ModelsBody, id: string): ListedModel {
	const found = body.models.find((model) => model.id === id);
	if (!found) {
		throw new Error(
			`Expected model "${id}" in listing, got: ${body.models
				.map((model) => model.id)
				.join(", ")}`,
		);
	}
	return found;
}

describe("GET /api/models", () => {
	beforeEach(() => {
		catalogueEntries = [];
		catalogueCalls = [];
	});

	// Non-regression: the agents screen consumes this body. `provider` and the
	// per-entry `source` are additive; nothing that was there may move.
	it("without ?provider keeps the legacy Anthropic body shape", async () => {
		const handler = createModelsHandler(makeContext());

		const response = await handler(new URL("http://localhost/api/models"));
		const body = (await response.json()) as ModelsBody;

		expect(response.status).toBe(200);
		expect(body.fetchedAt).toBe(CATALOG_FETCHED_AT);
		expect(body.source).toBe("live");
		expect(body.models).toHaveLength(1);
		expect(body.models[0]).toMatchObject({
			id: "claude-sonnet-4-5-20250929",
			displayName: "Claude Sonnet 4.5",
			createdAt: "2025-09-29T00:00:00Z",
			source: "catalog",
		});
		expect(body.provider).toBe("anthropic");
		// The Anthropic branch must never consult the models.dev catalogue.
		expect(catalogueCalls).toEqual([]);

		// The URL argument is optional — calling with none behaves identically.
		const bare = (await (await handler()).json()) as ModelsBody;
		expect(bare.provider).toBe("anthropic");
		expect(bare.models).toHaveLength(1);
	});

	it("?provider=codex lists the builtins first, in map order, tagged builtin", async () => {
		catalogueEntries = [
			{ id: "gpt-4.1", name: "GPT-4.1" },
			{ id: "gpt-4o", name: "GPT-4o" },
		];
		const handler = createModelsHandler(makeContext());

		const response = await handler(
			new URL("http://localhost/api/models?provider=codex"),
		);
		const body = (await response.json()) as ModelsBody;

		expect(response.status).toBe(200);
		expect(body.provider).toBe("codex");
		// codex is served by the "openai" section of models.dev.
		expect(catalogueCalls).toEqual(["openai"]);
		expect(body.referenceSection).toBe("openai");
		expect(body.source).toBe("mixed");

		const ids = body.models.map((model) => model.id);
		// Builtins come first and in the declaration order of the provider's
		// own context-window table.
		expect(ids.slice(0, CODEX_KNOWN_MODELS.length)).toEqual([
			...CODEX_KNOWN_MODELS,
		]);
		// The model at the heart of the incident this endpoint exists for.
		expect(ids).toContain("gpt-5.3-codex");
		for (const id of CODEX_KNOWN_MODELS) {
			expect(listed(body, id).source).toBe("builtin");
		}
		// Reference entries follow, alphabetically.
		expect(ids.slice(CODEX_KNOWN_MODELS.length)).toEqual(["gpt-4.1", "gpt-4o"]);
		expect(listed(body, "gpt-4.1").source).toBe("reference");
		expect(listed(body, "gpt-4.1").displayName).toBe("GPT-4.1");
	});

	// listCatalogueModels is contractually non-throwing: it swallows fetch
	// failures and an unknown section alike, and reports both as an empty
	// list. That empty list is therefore the "catalogue unavailable" signal
	// the handler has to survive — the endpoint must degrade, never fail.
	it("?provider=codex degrades to builtins plus a warning when the catalogue is unavailable", async () => {
		catalogueEntries = [];
		const handler = createModelsHandler(makeContext());

		const response = await handler(
			new URL("http://localhost/api/models?provider=codex"),
		);
		const body = (await response.json()) as ModelsBody;

		expect(response.status).toBe(200);
		expect(body.source).toBe("builtin");
		expect(body.models).toHaveLength(CODEX_KNOWN_MODELS.length);
		expect(body.models.every((model) => model.source === "builtin")).toBe(true);
		expect(body.warning).toBeDefined();
		expect(body.warning).toContain("openai");
	});

	it("deduplicates by id, keeping the stronger marking", async () => {
		catalogueEntries = [
			// Also a builtin: must survive once, as builtin.
			{ id: "gpt-5.6-sol", name: "GPT-5.6 Sol (catalogue name)" },
			{ id: "gpt-4.1", name: "GPT-4.1" },
			// Repeated inside the reference list itself.
			{ id: "gpt-4.1", name: "GPT-4.1 (again)" },
		];
		const handler = createModelsHandler(makeContext());

		const response = await handler(
			new URL("http://localhost/api/models?provider=codex"),
		);
		const body = (await response.json()) as ModelsBody;

		const ids = body.models.map((model) => model.id);
		expect(ids.filter((id) => id === "gpt-5.6-sol")).toHaveLength(1);
		expect(ids.filter((id) => id === "gpt-4.1")).toHaveLength(1);

		const sol = listed(body, "gpt-5.6-sol");
		expect(sol.source).toBe("builtin");
		// The builtin entry wins whole — the catalogue's display name must not
		// leak in and make a builtin look like a catalogue find.
		expect(sol.displayName).toBe("gpt-5.6-sol");
		expect(listed(body, "gpt-4.1").source).toBe("reference");
		expect(body.models).toHaveLength(CODEX_KNOWN_MODELS.length + 1);
	});

	it("an unknown provider yields an empty listing rather than an error", async () => {
		catalogueEntries = [];
		const handler = createModelsHandler(makeContext());

		const response = await handler(
			new URL("http://localhost/api/models?provider=nope"),
		);
		const body = (await response.json()) as ModelsBody;

		expect(response.status).toBe(200);
		expect(body.provider).toBe("nope");
		// No override in the section map: the provider name is used verbatim.
		expect(catalogueCalls).toEqual(["nope"]);
		expect(body.models).toEqual([]);
		expect(body.source).toBe("unavailable");
		expect(body.warning).toBeDefined();
	});
});
