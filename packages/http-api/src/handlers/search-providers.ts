import {
	BadRequest,
	Conflict,
	errorResponse,
	HttpClient,
	InternalServerError,
	jsonResponse,
	NotFound,
} from "@better-ccflare/http-common";
import { Logger } from "@better-ccflare/logger";
import {
	SEARCH_PROVIDER_CATALOG,
	type SearchProviderCatalogEntry,
	type SearchProviderId,
	type SearchProviderInput,
	type SearchProviderPublic,
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
	meta(): Response;
}

const LABEL_MAX_LENGTH = 64;
const PRIORITY_MIN = 0;
const PRIORITY_MAX = 1000;
const MAX_RESULTS_MIN = 1;
const MAX_RESULTS_MAX = 50;
const TEST_TIMEOUT_MS = 10_000;
export const TAVILY_SEARCH_URL = "https://api.tavily.com/search";

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

/** Run a connectivity test for a stored provider. */
export async function runSearchProviderTest(row: {
	provider: string;
	apiKey: string | null;
}): Promise<SearchProviderTestResult> {
	// Phase 1 only implements Tavily's URL/auth. Every other provider must
	// report "not implemented" WITHOUT any outbound call.
	if (row.provider !== "tavily") {
		return { ok: false, latencyMs: 0, error: "provider not implemented yet" };
	}
	if (!row.apiKey) {
		return { ok: false, latencyMs: 0, error: "no apiKey configured" };
	}

	// HttpClient goes through the global egress proxy configured in
	// http-common. Non-2xx responses throw an HttpError.
	const client = new HttpClient({ timeout: TEST_TIMEOUT_MS });
	const started = Date.now();
	try {
		const data = await client.post<{ results?: unknown }>(
			TAVILY_SEARCH_URL,
			{ query: "better-ccflare connectivity test", max_results: 1 },
			{ headers: { Authorization: `Bearer ${row.apiKey}` } },
		);
		const latencyMs = Date.now() - started;
		if (!data || !Array.isArray(data.results)) {
			return { ok: false, latencyMs, error: "unexpected response shape" };
		}
		return { ok: true, latencyMs };
	} catch (error) {
		const latencyMs = Date.now() - started;
		const message = error instanceof Error ? error.message : String(error);
		log.warn(`Search provider test failed (${row.provider}): ${message}`);
		return { ok: false, latencyMs, error: message };
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
			if (entry.requiresKey && apiKey.length === 0) {
				return errorResponse(
					BadRequest(`provider '${provider}' requires an apiKey`),
				);
			}

			const input: SearchProviderInput = {
				// Narrowed by the catalog lookup above.
				provider: provider as SearchProviderId,
				label: patch.label as string,
				apiKey: apiKey.length > 0 ? apiKey : undefined,
				priority: patch.priority,
				maxResults: patch.maxResults,
				extraConfig: patch.extraConfig,
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

				const validated = validateFields(body, { creating: false });
				if (!validated.ok) return validated.response;
				const { patch } = validated;

				if (patch.apiKey === "") {
					const entry = catalogEntry(existing.provider);
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
					provider: row.provider,
					apiKey,
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
	};
}
