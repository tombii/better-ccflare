import { afterAll, describe, expect, it, mock } from "bun:test";
import type { APIContext } from "@better-ccflare/types";

// The shared models.dev catalogue is the last-resort source for providers
// ccflare cannot ask directly, and the real one performs network I/O. Stub it
// so these tests are offline and deterministic — same discipline as the rest
// of this suite. The handler is imported after the mock is registered.
const actualCore = await import("@better-ccflare/core");

mock.module("@better-ccflare/core", () => ({
	...actualCore,
	listCatalogueModels: async () => [],
}));

afterAll(() => {
	mock.module("@better-ccflare/core", () => actualCore);
});

const { createModelsHandler } = await import("../models");

/**
 * `GET /api/models` answers one question: which models can THIS account serve?
 *
 * It used to answer a wider one — built-in lists, the models.dev catalogue, the
 * provider's documentation — and that width was the defect. Every model in a
 * catalogue is one click away from being chosen, and choosing one the plan does
 * not cover is what produced `400 The 'gpt-5.3-codex' model is not supported
 * when using Codex with a ChatGPT account`. So the only source left is the
 * account's own listing, and an empty answer is a real answer: nothing has been
 * read yet.
 */

interface ListedModel {
	id: string;
	displayName: string;
	source: string;
}

interface Body {
	provider: string;
	models: ListedModel[];
	source: string;
	warning?: string;
}

function makeContext(opts: {
	codex?: {
		models: Array<{
			id: string;
			displayName: string;
			description?: string | null;
			contextWindow?: number | null;
			supersededBy?: string | null;
		}>;
	} | null;
	anthropic?: {
		models: Array<{ id: string; displayName: string }>;
		source: string;
	};
}): APIContext {
	return {
		modelCatalog: {
			codexModels: async () =>
				opts.codex
					? {
							models: opts.codex.models.map((m) => ({
								description: null,
								contextWindow: null,
								supersededBy: null,
								...m,
							})),
							fetchedAt: 1_000,
							source: "live" as const,
						}
					: null,
			get: async () => ({
				models: (opts.anthropic?.models ?? []).map((m) => ({
					...m,
					createdAt: null,
				})),
				fetchedAt: 1_000,
				source: (opts.anthropic?.source ?? "fallback") as "live" | "fallback",
			}),
			refresh: async () => ({ success: true }),
		},
	} as unknown as APIContext;
}

async function ask(context: APIContext, query: string): Promise<Body> {
	const handler = createModelsHandler(context);
	const response = await handler(new URL(`http://local/api/models?${query}`));
	return (await response.json()) as Body;
}

describe("GET /api/models", () => {
	it("returns what the codex account itself reported", async () => {
		const context = makeContext({
			codex: {
				models: [
					{ id: "gpt-5.6-sol", displayName: "GPT-5.6-Sol" },
					{ id: "gpt-5.6-terra", displayName: "GPT-5.6-Terra" },
				],
			},
		});

		const body = await ask(context, "provider=codex&accountId=acc-1");

		expect(body.models.map((m) => m.id)).toEqual([
			"gpt-5.6-sol",
			"gpt-5.6-terra",
		]);
		expect(body.models.every((m) => m.source === "account")).toBe(true);
		expect(body.warning).toBeUndefined();
	});

	// Nothing is substituted here on purpose. A catalogue would fill the gap with
	// models this account may not be able to call, which is worse than an honest
	// blank.
	it("returns an empty list, not a catalogue, when nothing was read yet", async () => {
		const body = await ask(
			makeContext({ codex: null }),
			"provider=codex&accountId=acc-1",
		);

		// The contract is the empty list: nothing is substituted for a listing
		// that was not read. The wording of the warning is not the point.
		expect(body.models).toEqual([]);
		expect(body.source).toBe("unavailable");
		expect(body.warning).toBeTruthy();
	});

	it("cannot answer for codex without an account", async () => {
		const body = await ask(makeContext({ codex: null }), "provider=codex");

		expect(body.models).toEqual([]);
		expect(body.source).toBe("unavailable");
	});

	it("returns the Anthropic listing when it came from the provider", async () => {
		const context = makeContext({
			anthropic: {
				models: [{ id: "claude-opus-5", displayName: "Claude Opus 5" }],
				source: "live",
			},
		});

		const body = await ask(context, "provider=anthropic");

		expect(body.models.map((m) => m.id)).toEqual(["claude-opus-5"]);
		expect(body.source).toBe("live");
	});

	// `fallback` means the bundled list or an on-disk copy answered — a catalogue
	// wearing the listing's clothes. Same rule as everywhere else: it does not
	// reach the field.
	it("refuses to pass off the bundled Anthropic list as a listing", async () => {
		const context = makeContext({
			anthropic: {
				models: [{ id: "claude-opus-5", displayName: "Claude Opus 5" }],
				source: "fallback",
			},
		});

		const body = await ask(context, "provider=anthropic");

		expect(body.models).toEqual([]);
		expect(body.source).toBe("unavailable");
	});

	it("says plainly that it cannot read a list from an unknown provider", async () => {
		const body = await ask(makeContext({}), "provider=whatever");

		expect(body.models).toEqual([]);
		expect(body.warning).toContain("whatever");
	});
});
