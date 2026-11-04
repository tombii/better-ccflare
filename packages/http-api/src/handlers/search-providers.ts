import {
	BadRequest,
	Conflict,
	errorResponse,
	InternalServerError,
	jsonResponse,
	NotFound,
} from "@better-ccflare/http-common";
import { Logger } from "@better-ccflare/logger";
import { getWebToolAdapter } from "@better-ccflare/proxy";

/** Tavily's search endpoint, re-exported for tests that assert on it. */
export { TAVILY_SEARCH_URL } from "@better-ccflare/proxy";

import {
	resolveSearchProviderTier,
	SEARCH_PROVIDER_CATALOG,
	type SearchProviderCatalogEntry,
	type SearchProviderId,
	type SearchProviderInput,
	type SearchProviderPublic,
	type SearchProviderTier,
	type SearchProviderUpdate,
} from "@better-ccflare/types";

const log = new Logger("SearchProvidersHandler");

/**
 * Narrow dependency surface the handlers talk to. The database layer adapts
 * its repository methods onto this (see services/search-providers.ts), and
 * tests substitute a fake, so handlers never touch dbOps directly.
 */
export interface SearchProviderStore {
	list(): Promise<SearchProviderPublic[]>;
	get(id: string): Promise<SearchProviderPublic | null>;
	/** Unmasked apiKey for the outbound /test call; never returned over HTTP. */
	getApiKey(id: string): Promise<string | null>;
	create(input: SearchProviderInput): Promise<SearchProviderPublic>;
	/** Enable/disable all free-tier rows; returns how many changed. */
	setFreeTierEnabled(enabled: boolean): Promise<number>;
	update(
		id: string,
		patch: SearchProviderUpdate,
	): Promise<SearchProviderPublic | null>;
	remove(id: string): Promise<boolean>;
}

/** The store rejected a create because the label is already taken. */
export class DuplicateLabelError extends Error {
	constructor(label: string) {
		super(`A search provider labelled '${label}' already exists`);
		this.name = "DuplicateLabelError";
	}
}

/**
 * The storage layer owns the duplicate-label signal and names its error
 * `SearchProviderLabelTakenError`; older adapter versions threw the local
 * `DuplicateLabelError` above. Accept either so the handler does not depend
 * on which side of the adapter boundary the throw originates from.
 */
function isDuplicateLabelError(error: unknown): boolean {
	if (error instanceof DuplicateLabelError) return true;
	if (!(error instanceof Error)) return false;
	return (
		error.name === "DuplicateLabelError" ||
		error.name === "SearchProviderLabelTakenError" ||
		(error as { code?: unknown }).code === "SEARCH_PROVIDER_LABEL_TAKEN"
	);
}

export interface SearchProviderTestResult {
	ok: boolean;
	latencyMs: number;
	error?: string;
}

export interface SearchProviderHandlers {
	list(): Promise<Response>;
	create(req: Request): Promise<Response>;
	get(id: string): Promise<Response>;
	update(req: Request, id: string): Promise<Response>;
	remove(id: string): Promise<Response>;
	/**
	 * `getApiKey` is passed separately (defaults to store.getApiKey) so the
	 * handler layer never needs the unmasked row anywhere else.
	 */
	test(
		id: string,
		getApiKey?: (id: string) => Promise<string | null>,
	): Promise<Response>;
	reorder(req: Request, id: string): Promise<Response>;
	/** Enable or disable every free-tier row at once (the "use free tier" toggle). */
	setFreeTier(req: Request): Promise<Response>;
	meta(): Response;
}

/** Body of the free-tier toggle: `{ enabled: boolean }`. */
async function readFreeTierToggle(req: Request): Promise<boolean | null> {
	let body: Record<string, unknown>;
	try {
		body = await readJsonObject(req);
	} catch {
		return null;
	}
	return typeof body.enabled === "boolean" ? body.enabled : null;
}

const LABEL_MAX_LENGTH = 64;
const PRIORITY_MIN = 0;
const PRIORITY_MAX = 1000;
const MAX_RESULTS_MIN = 1;
const MAX_RESULTS_MAX = 50;

type ValidationResult =
	| { ok: true; patch: SearchProviderUpdate }
	| { ok: false; response: Response };

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function failure(message: string): { ok: false; response: Response } {
	return { ok: false, response: errorResponse(BadRequest(message)) };
}

function invalidPriority(): Response {
	return errorResponse(
		BadRequest(
			`priority must be an integer between ${PRIORITY_MIN} and ${PRIORITY_MAX}`,
		),
	);
}

/**
 * Validate the fields shared by create and update. `provider` is create-only
 * (it identifies the catalog entry) and is rejected on update.
 */
function validateFields(
	body: Record<string, unknown>,
	options: { creating: boolean },
): ValidationResult {
	if (body.provider !== undefined && !options.creating) {
		return failure("provider cannot be changed after creation");
	}

	const patch: SearchProviderUpdate = {};

	if (body.label !== undefined) {
		if (typeof body.label !== "string" || body.label.trim().length === 0) {
			return failure("label is required and must be a non-empty string");
		}
		const label = body.label.trim();
		if (label.length > LABEL_MAX_LENGTH) {
			return failure(`label must be at most ${LABEL_MAX_LENGTH} characters`);
		}
		patch.label = label;
	} else if (options.creating) {
		return failure("label is required");
	}

	if (body.priority !== undefined) {
		const priority = body.priority;
		if (
			typeof priority !== "number" ||
			!Number.isInteger(priority) ||
			priority < PRIORITY_MIN ||
			priority > PRIORITY_MAX
		) {
			return failure(
				`priority must be an integer between ${PRIORITY_MIN} and ${PRIORITY_MAX}`,
			);
		}
		patch.priority = priority;
	}

	if (body.maxResults !== undefined) {
		const maxResults = body.maxResults;
		if (
			typeof maxResults !== "number" ||
			!Number.isInteger(maxResults) ||
			maxResults < MAX_RESULTS_MIN ||
			maxResults > MAX_RESULTS_MAX
		) {
			return failure(
				`maxResults must be an integer between ${MAX_RESULTS_MIN} and ${MAX_RESULTS_MAX}`,
			);
		}
		patch.maxResults = maxResults;
	}

	if (body.extraConfig !== undefined) {
		if (body.extraConfig !== null && !isPlainObject(body.extraConfig)) {
			return failure("extraConfig must be an object or null");
		}
		patch.extraConfig = body.extraConfig as Record<string, unknown> | null;
	}

	if (body.enabled !== undefined) {
		if (typeof body.enabled !== "boolean") {
			return failure("enabled must be a boolean");
		}
		patch.enabled = body.enabled;
	}

	if (body.tier !== undefined) {
		if (body.tier !== "free" && body.tier !== "paid") {
			return failure("tier must be 'free' or 'paid'");
		}
		patch.tier = body.tier;
	}

	// apiKey is write-only. On create an empty/absent key means "none"; on
	// update "" (or null) means "clear the stored key". Trimming avoids
	// storing a key with a stray newline pasted from a UI.
	if (body.apiKey !== undefined && body.apiKey !== null) {
		if (typeof body.apiKey !== "string") {
			return failure("apiKey must be a string");
		}
		patch.apiKey = body.apiKey.trim();
	}

	return { ok: true, patch };
}

function catalogEntry(
	provider: string,
): SearchProviderCatalogEntry | undefined {
	return SEARCH_PROVIDER_CATALOG.find((entry) => entry.id === provider);
}

async function readJsonObject(req: Request): Promise<Record<string, unknown>> {
	const body = (await req.json()) as unknown;
	if (!isPlainObject(body)) {
		throw new Error("__bad_body__");
	}
	return body;
}

/**
 * Reject a requested tier that the stored key cannot honour, and say what to
 * change. Keeping this strict is the point: the toggle and the per-row badge
 * both read `tier`, so a row whose tier disagrees with its key would let
 * "use free tier" switch a paid search on/off (or leave a free one running).
 */
function tierConflict(
	entry: SearchProviderCatalogEntry | undefined,
	apiKey: string | null | undefined,
	tier: SearchProviderTier,
): Response | null {
	if (tier === "free") {
		if (apiKey) {
			return errorResponse(
				BadRequest(
					"A search provider with an API key is the paid tier. Clear the key first to use the free (keyless) endpoint.",
				),
			);
		}
		if (!entry?.keyless) {
			return errorResponse(
				BadRequest(
					"This provider has no free (keyless) endpoint; its tier is always paid.",
				),
			);
		}
		return null;
	}
	if (!apiKey) {
		const freeAvailable = entry?.keyless
			? " Omit tier to use the free endpoint, or add a key."
			: "";
		return errorResponse(
			BadRequest(`The paid tier needs an API key.${freeAvailable}`),
		);
	}
	return null;
}

/**
 * Run a connectivity test for a stored provider.
 *
 * Delegates to the adapter's own `test()` so the dashboard exercises exactly
 * the URL, auth header and response mapping a real search uses — one
 * implementation, not a second copy that can drift. Adapters without an
 * implementation (Perplexity today) still report `ok: false` and make NO
 * outbound call.
 */
export async function runSearchProviderTest(row: {
	/** `search_providers.id`; adapters use it for per-row memory, when given. */
	id?: string;
	provider: string;
	apiKey: string | null;
	maxResults?: number;
	extraConfig?: Record<string, unknown> | null;
}): Promise<SearchProviderTestResult> {
	const adapter = getWebToolAdapter(row.provider as SearchProviderId);
	if (!adapter || adapter.implemented === false) {
		return { ok: false, latencyMs: 0, error: "provider not implemented yet" };
	}
	// Only providers that cannot run without a key are refused here. A
	// keyless-capable provider is tested unauthenticated, which is exactly the
	// call a real search would make for a row with no key.
	const entry = catalogEntry(row.provider);
	if (!row.apiKey && entry?.requiresKey !== false) {
		return { ok: false, latencyMs: 0, error: "no apiKey configured" };
	}
	try {
		// `test()` is contractually non-throwing; the catch is belt-and-braces
		// so a broken adapter can never turn the dashboard into a 500.
		return await adapter.test({
			apiKey: row.apiKey,
			maxResults: row.maxResults ?? 5,
			extraConfig: row.extraConfig ?? {},
			rowId: row.id,
		});
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		log.warn(`Search provider test failed (${row.provider}): ${message}`);
		return { ok: false, latencyMs: 0, error: message };
	}
}

export function createSearchProviderHandlers(
	store: SearchProviderStore,
): SearchProviderHandlers {
	return {
		meta: (): Response =>
			jsonResponse({ success: true, data: SEARCH_PROVIDER_CATALOG }),

		list: async (): Promise<Response> => {
			try {
				const data = await store.list();
				return jsonResponse({ success: true, data, count: data.length });
			} catch (error) {
				log.error("Search providers list error:", error);
				return errorResponse(
					InternalServerError("Failed to list search providers"),
				);
			}
		},

		create: async (req: Request): Promise<Response> => {
			let body: Record<string, unknown>;
			try {
				body = await readJsonObject(req);
			} catch {
				return errorResponse(BadRequest("Request body must be a JSON object"));
			}

			const provider = body.provider;
			if (typeof provider !== "string" || !provider) {
				return errorResponse(BadRequest("provider is required"));
			}
			const entry = catalogEntry(provider);
			if (!entry) {
				return errorResponse(
					BadRequest(`Unknown search provider '${provider}'`),
				);
			}

			const validated = validateFields(body, { creating: true });
			if (!validated.ok) return validated.response;
			const { patch } = validated;

			const apiKey = patch.apiKey ?? "";
			// `requiresKey` is false only for providers with a keyless path, so
			// an empty key there means "use the free tier", not "incomplete".
			if (entry.requiresKey && apiKey.length === 0) {
				return errorResponse(
					BadRequest(`provider '${provider}' requires an apiKey`),
				);
			}

			// The tier is derived, never trusted from the client: a key means
			// the paid endpoint, no key means the free one. A client may send
			// the derived value (the dashboard round-trips rows) but not a
			// contradictory one.
			const tier = resolveSearchProviderTier(entry, apiKey);
			if (patch.tier !== undefined && patch.tier !== tier) {
				const conflict = tierConflict(entry, apiKey, patch.tier);
				if (conflict) return conflict;
			}

			const input: SearchProviderInput = {
				// Narrowed by the catalog lookup above.
				provider: provider as SearchProviderId,
				label: patch.label as string,
				apiKey: apiKey.length > 0 ? apiKey : undefined,
				priority: patch.priority,
				enabled: patch.enabled,
				maxResults: patch.maxResults,
				extraConfig: patch.extraConfig,
				tier,
			};

			try {
				const row = await store.create(input);
				return new Response(JSON.stringify({ success: true, data: row }), {
					status: 201,
					headers: { "Content-Type": "application/json" },
				});
			} catch (error) {
				if (isDuplicateLabelError(error)) {
					return errorResponse(
						Conflict(
							`A search provider labelled '${input.label}' already exists`,
						),
					);
				}
				log.error("Search provider create error:", error);
				return errorResponse(
					InternalServerError("Failed to create search provider"),
				);
			}
		},

		get: async (id: string): Promise<Response> => {
			try {
				const row = await store.get(id);
				if (!row) {
					return errorResponse(NotFound(`Search provider '${id}' not found`));
				}
				return jsonResponse({ success: true, data: row });
			} catch (error) {
				log.error("Search provider get error:", error);
				return errorResponse(
					InternalServerError("Failed to get search provider"),
				);
			}
		},

		update: async (req: Request, id: string): Promise<Response> => {
			let body: Record<string, unknown>;
			try {
				body = await readJsonObject(req);
			} catch {
				return errorResponse(BadRequest("Request body must be a JSON object"));
			}

			try {
				const existing = await store.get(id);
				if (!existing) {
					return errorResponse(NotFound(`Search provider '${id}' not found`));
				}

				// Clients round-trip the whole row on edit, so an unchanged
				// `provider` is a no-op rather than an error. Only an actual
				// change is rejected.
				let patchBody = body;
				if (body.provider !== undefined) {
					if (body.provider !== existing.provider) {
						return errorResponse(
							BadRequest("provider cannot be changed after creation"),
						);
					}
					const { provider: _unchanged, ...rest } = body;
					patchBody = rest;
				}

				const validated = validateFields(patchBody, { creating: false });
				if (!validated.ok) return validated.response;
				const { patch } = validated;

				const entry = catalogEntry(existing.provider);
				if (patch.apiKey === "") {
					if (entry?.requiresKey) {
						return errorResponse(
							BadRequest(
								`provider '${existing.provider}' requires an apiKey and it cannot be cleared`,
							),
						);
					}
					// Explicit "" clears the stored key; absent leaves it untouched.
					patch.apiKey = null;
				}

				// Re-derive the tier from the key the row will HAVE after this
				// patch (absent `apiKey` keeps the stored one — the public row
				// is masked, so the stored key comes from `getApiKey`). Adding a
				// key therefore turns a free row into a paid one, and clearing
				// it turns a paid row back into the free one: `tier` and the
				// endpoint the adapter calls can never disagree.
				const storedApiKey =
					patch.apiKey !== undefined ? patch.apiKey : await store.getApiKey(id);
				const tier = resolveSearchProviderTier(entry, storedApiKey);
				if (patch.tier !== undefined && patch.tier !== tier) {
					const conflict = tierConflict(entry, storedApiKey, patch.tier);
					if (conflict) return conflict;
				}
				patch.tier = tier;

				const row = await store.update(id, patch);
				if (!row) {
					return errorResponse(NotFound(`Search provider '${id}' not found`));
				}
				return jsonResponse({ success: true, data: row });
			} catch (error) {
				if (isDuplicateLabelError(error)) {
					return errorResponse(Conflict("label already in use"));
				}
				log.error("Search provider update error:", error);
				return errorResponse(
					InternalServerError("Failed to update search provider"),
				);
			}
		},

		remove: async (id: string): Promise<Response> => {
			try {
				const removed = await store.remove(id);
				if (!removed) {
					return errorResponse(NotFound(`Search provider '${id}' not found`));
				}
				return jsonResponse({ success: true });
			} catch (error) {
				log.error("Search provider remove error:", error);
				return errorResponse(
					InternalServerError("Failed to remove search provider"),
				);
			}
		},

		test: async (
			id: string,
			getApiKey: (id: string) => Promise<string | null> = (keyId) =>
				store.getApiKey(keyId),
		): Promise<Response> => {
			try {
				const row = await store.get(id);
				if (!row) {
					return errorResponse(NotFound(`Search provider '${id}' not found`));
				}
				// The public row is masked; resolve the real key only for the
				// outbound call and never place it in the response.
				const apiKey = await getApiKey(id);
				const result = await runSearchProviderTest({
					id: row.id,
					provider: row.provider,
					apiKey,
					maxResults: row.maxResults,
					extraConfig: row.extraConfig,
				});
				return jsonResponse({ success: true, data: result });
			} catch (error) {
				log.error("Search provider test error:", error);
				return errorResponse(
					InternalServerError("Failed to test search provider"),
				);
			}
		},

		reorder: async (req: Request, id: string): Promise<Response> => {
			let body: Record<string, unknown>;
			try {
				body = await readJsonObject(req);
			} catch {
				return errorResponse(BadRequest("Request body must be a JSON object"));
			}
			const priority = body.priority;
			if (
				typeof priority !== "number" ||
				!Number.isInteger(priority) ||
				priority < PRIORITY_MIN ||
				priority > PRIORITY_MAX
			) {
				return invalidPriority();
			}
			try {
				const row = await store.update(id, { priority });
				if (!row) {
					return errorResponse(NotFound(`Search provider '${id}' not found`));
				}
				return jsonResponse({ success: true, data: row });
			} catch (error) {
				log.error("Search provider reorder error:", error);
				return errorResponse(
					InternalServerError("Failed to reorder search provider"),
				);
			}
		},

		setFreeTier: async (req: Request): Promise<Response> => {
			const enabled = await readFreeTierToggle(req);
			if (enabled === null) {
				return errorResponse(
					BadRequest("body must be a JSON object with a boolean 'enabled'"),
				);
			}
			try {
				// Bulk update rather than a flag: the toggle's state IS the rows'
				// enabled column, so it survives restarts and sits in the same
				// table the chain reads.
				const changed = await store.setFreeTierEnabled(enabled);
				return jsonResponse({ success: true, data: { enabled, changed } });
			} catch (error) {
				log.error("Search provider free-tier toggle error:", error);
				return errorResponse(
					InternalServerError("Failed to toggle free-tier search providers"),
				);
			}
		},
	};
}
