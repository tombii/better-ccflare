import { listCatalogueModels } from "@better-ccflare/core";
import { errorResponse, jsonResponse } from "@better-ccflare/http-common";
import { CODEX_KNOWN_MODELS } from "@better-ccflare/providers";
import type { APIContext } from "../types";

/**
 * Where a listed model id came from — the whole point of the endpoint.
 *
 *  - "builtin"   ccflare itself knows this model for that provider (it is in
 *                the provider adapter's own table). Strongest signal there is.
 *  - "catalog"   the provider's own live listing (Anthropic /v1/models),
 *                fetched with a real account's credentials.
 *  - "reference" the public models.dev catalogue. Says the model EXISTS at
 *                the vendor and says NOTHING about whether a given account's
 *                plan may call it: ChatGPT-subscription accounts reject
 *                gpt-5.3-codex with HTTP 400 while OpenAI lists it happily.
 *                Never collapse this into the other two.
 */
export type ModelListingSource = "builtin" | "catalog" | "reference";

export interface ProviderModelEntry {
	id: string;
	displayName: string;
	source: ModelListingSource;
}

/**
 * ccflare provider name -> models.dev top-level section. Only names that
 * differ need an entry; anything else falls through to the provider name
 * itself, which models.dev uses verbatim for "anthropic", "zai", "minimax",
 * and friends.
 */
const MODELS_DEV_SECTION_BY_PROVIDER: Record<string, string> = {
	codex: "openai",
};

/** Model ids ccflare ships knowledge of, per provider. */
const BUILTIN_MODELS_BY_PROVIDER: Record<string, readonly string[]> = {
	codex: CODEX_KNOWN_MODELS,
};

/**
 * Providers served by the live Anthropic catalog. Both auth modes (OAuth and
 * console API key) talk to the same /v1/models listing, so both get it.
 */
function isAnthropicProvider(provider: string): boolean {
	return provider === "anthropic" || provider === "claude-console-api";
}

/**
 * GET /api/models[?provider=<name>] — list the models available for one
 * provider, each entry tagged with where the knowledge came from.
 *
 * Without `provider` (and for the Anthropic providers) the body is exactly
 * what this endpoint has always returned — the cached live catalog, or the
 * bundled static fallback — so existing callers keep working; `provider` and
 * the per-entry `source` are purely additive fields.
 *
 * For every other provider the answer is the union of what ccflare knows
 * built in and what the public models.dev catalogue lists, deduplicated by
 * id with the stronger marking winning, builtin entries first. A failed or
 * unavailable catalogue fetch degrades to the builtin list plus a warning —
 * it never fails the request.
 */
export function createModelsHandler(context: APIContext) {
	return async (url?: URL): Promise<Response> => {
		const requested = url?.searchParams.get("provider")?.trim() || "";

		if (requested === "" || isAnthropicProvider(requested)) {
			if (!context.modelCatalog) {
				return errorResponse("Model catalog is not available");
			}
			const catalog = await context.modelCatalog.get();
			return jsonResponse({
				...catalog,
				provider: requested || "anthropic",
				models: catalog.models.map((model) => ({
					...model,
					source: "catalog" as const,
				})),
			});
		}

		const builtinIds = BUILTIN_MODELS_BY_PROVIDER[requested] ?? [];
		const section = MODELS_DEV_SECTION_BY_PROVIDER[requested] ?? requested;
		const reference = await listCatalogueModels(section);

		const builtinById = new Map<string, ProviderModelEntry>();
		for (const id of builtinIds) {
			builtinById.set(id, { id, displayName: id, source: "builtin" });
		}

		// A reference entry never overwrites a builtin one — the stronger
		// marking wins, and the UI shows the two groups apart on purpose.
		const referenceById = new Map<string, ProviderModelEntry>();
		for (const entry of reference) {
			if (!entry.id) continue;
			if (builtinById.has(entry.id) || referenceById.has(entry.id)) continue;
			referenceById.set(entry.id, {
				id: entry.id,
				displayName: entry.name || entry.id,
				source: "reference",
			});
		}

		const referenceEntries = Array.from(referenceById.values()).sort((a, b) =>
			a.id.localeCompare(b.id),
		);
		const models = [...builtinById.values(), ...referenceEntries];

		const hasBuiltin = builtinById.size > 0;
		const hasReference = referenceEntries.length > 0;
		const source = hasBuiltin
			? hasReference
				? "mixed"
				: "builtin"
			: hasReference
				? "reference"
				: "unavailable";

		return jsonResponse({
			provider: requested,
			models,
			fetchedAt: Date.now(),
			source,
			referenceSection: section,
			...(hasReference
				? {}
				: {
						warning: `No reference models for "${section}" in the models.dev catalogue (unknown provider, catalogue offline, or fetch failed)`,
					}),
		});
	};
}

/**
 * POST /api/models/refresh — force an immediate live model catalog refresh.
 * Never throws: refreshModelCatalog is fail-open, so this always returns
 * 200 with the outcome (success flag + optional error) plus the resulting
 * catalog.
 */
export function createModelsRefreshHandler(context: APIContext) {
	return async (): Promise<Response> => {
		if (!context.modelCatalog) {
			return errorResponse("Model catalog is not available");
		}
		const result = await context.modelCatalog.refresh();
		const catalog = await context.modelCatalog.get();
		return jsonResponse({ ...result, catalog });
	};
}
