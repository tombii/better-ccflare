import { listCatalogueModels } from "@better-ccflare/core";
import { errorResponse, jsonResponse } from "@better-ccflare/http-common";
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
export type ModelListingSource =
	| "builtin"
	| "catalog"
	| "reference"
	/**
	 * The provider's own listing for THIS account. The only source that can
	 * tell an entitled model from one the plan does not reach — which is the
	 * distinction that matters when the choice ends up in a request.
	 */
	| "account";

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
	// Intentionally empty for providers that answer with a listing of their
	// own. Add an entry only for a provider whose models ccflare cannot ask
	// for — the catalogue is the fallback of last resort, not a second opinion.
};

/**
 * Model ids ccflare ships knowledge of, per provider.
 *
 * Empty for codex on purpose: the account's own listing supersedes anything
 * compiled in, and the compiled list contained `gpt-5.3-codex`, which a
 * ChatGPT-subscription account refuses. A built-in list is a guess about
 * entitlement, and a guess is exactly what fails silently.
 */
const BUILTIN_MODELS_BY_PROVIDER: Record<string, readonly string[]> = {};

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
		const accountId = url?.searchParams.get("accountId")?.trim() || "";

		// An account's own listing beats every catalogue: it is the only one
		// that knows what this subscription may call. Providers without such a
		// listing fall through to the generic path below, unchanged.
		if (accountId && context.modelCatalog?.codexModels) {
			const listing = await context.modelCatalog.codexModels(accountId);
			if (listing) {
				return jsonResponse({
					provider: requested,
					models: listing.models.map((model) => ({
						id: model.id,
						displayName: model.displayName,
						source: "account" as const,
						description: model.description,
						contextWindow: model.contextWindow,
						supersededBy: model.supersededBy,
					})),
					fetchedAt: listing.fetchedAt,
					source: listing.source,
					...(listing.source === "shared"
						? {
								warning:
									"This account cannot read its own model list, so this is " +
									"another account of the same provider. Accounts on " +
									"different plans can differ.",
							}
						: {}),
				});
			}
		}

		if (accountId && context.modelCatalog?.openaiCompatibleModels) {
			const listing =
				await context.modelCatalog.openaiCompatibleModels(accountId);
			if (listing) {
				return jsonResponse({
					provider: requested,
					models: listing.models.map((model) => ({
						id: model.id,
						displayName: model.displayName,
						source: "account" as const,
					})),
					fetchedAt: listing.fetchedAt,
					source: listing.source,
				});
			}
		}

		if (requested === "" || isAnthropicProvider(requested)) {
			if (!context.modelCatalog) {
				return errorResponse("Model catalog is not available");
			}
			const catalog = await context.modelCatalog.get();
			// `fallback` means an on-disk copy or the list bundled into the binary
			// answered — not the provider. After a restart that would make the
			// field look answered when nothing has been read.
			const live = catalog.source === "live";
			return jsonResponse({
				provider: requested || "anthropic",
				models: live
					? catalog.models.map((model) => ({
							...model,
							source: "catalog" as const,
						}))
					: [],
				fetchedAt: catalog.fetchedAt,
				source: live ? "live" : "unavailable",
				...(live
					? {}
					: {
							warning:
								"No listing read from the provider yet. The field takes any model id meanwhile.",
						}),
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
