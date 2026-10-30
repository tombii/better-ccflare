import { HttpError } from "@better-ccflare/http-common";
import { api } from "../api";
import type {
	CreateSearchProviderInput,
	SearchProviderCatalogEntry,
	SearchProviderExtraConfigField,
	SearchProviderPublic,
	SearchProviderStatus,
	SearchProviderTestResult,
	UpdateSearchProviderInput,
} from "./search-provider-types";

/**
 * Fetch wrappers for /api/search-providers.
 *
 * Every response is normalized defensively: a missing or malformed field
 * degrades to a safe default rather than crashing the page, so the UI keeps
 * working (with muted values) if the server contract drifts.
 *
 * Authentication comes from the shared `api` client, which injects
 * `x-api-key` and opens the auth dialog on 401.
 */

interface Envelope<T> {
	success?: boolean;
	data?: T;
	count?: number;
}

function asRecord(raw: unknown): Record<string, unknown> {
	return raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
}

function asString(raw: unknown, fallback = ""): string {
	return typeof raw === "string" ? raw : fallback;
}

function asNumber(raw: unknown, fallback = 0): number {
	return typeof raw === "number" && Number.isFinite(raw) ? raw : fallback;
}

function asNullableNumber(raw: unknown): number | null {
	return typeof raw === "number" && Number.isFinite(raw) ? raw : null;
}

function asNullableString(raw: unknown): string | null {
	return typeof raw === "string" && raw.length > 0 ? raw : null;
}

const STATUSES: SearchProviderStatus[] = ["unknown", "ok", "error", "cooldown"];

function asStatus(raw: unknown): SearchProviderStatus {
	return STATUSES.includes(raw as SearchProviderStatus)
		? (raw as SearchProviderStatus)
		: "unknown";
}

function normalizeProvider(raw: unknown): SearchProviderPublic | null {
	const entry = asRecord(raw);
	const id = asString(entry.id);
	if (!id) return null;
	const extraConfig = entry.extraConfig;
	return {
		id,
		provider: asString(entry.provider) as SearchProviderPublic["provider"],
		label: asString(entry.label, asString(entry.provider)),
		// We only ever surface what the server sent; there is no client-side
		// way to obtain the raw key.
		apiKeyMasked: asNullableString(entry.apiKeyMasked),
		priority: asNumber(entry.priority),
		enabled: entry.enabled !== false,
		maxResults: asNumber(entry.maxResults, 0),
		extraConfig:
			extraConfig && typeof extraConfig === "object"
				? asRecord(extraConfig)
				: {},
		status: asStatus(entry.status),
		statusMessage: asNullableString(entry.statusMessage),
		statusCheckedAt: asNullableNumber(entry.statusCheckedAt),
		cooldownUntil: asNullableNumber(entry.cooldownUntil),
		createdAt: asNumber(entry.createdAt),
		updatedAt: asNumber(entry.updatedAt),
	};
}

function normalizeCatalogEntry(
	raw: unknown,
): SearchProviderCatalogEntry | null {
	const entry = asRecord(raw);
	const id = asString(entry.id);
	if (!id) return null;
	const fields = Array.isArray(entry.extraConfigFields)
		? entry.extraConfigFields
				.map((f) => {
					const field = asRecord(f);
					const key = asString(field.key);
					if (!key) return null;
					const type = field.type;
					return {
						key,
						label: asString(field.label, key),
						type: (type === "number" || type === "select" || type === "boolean"
							? type
							: "text") as SearchProviderExtraConfigField["type"],
						options: Array.isArray(field.options)
							? field.options.filter((o): o is string => typeof o === "string")
							: undefined,
					};
				})
				.filter((f): f is NonNullable<typeof f> => f !== null)
		: undefined;
	return {
		id: id as SearchProviderCatalogEntry["id"],
		label: asString(entry.label, id),
		requiresKey: entry.requiresKey !== false,
		docsUrl: asString(entry.docsUrl),
		extraConfigFields: fields ?? [],
		implemented: entry.implemented === true,
	};
}

export async function listSearchProviders(): Promise<SearchProviderPublic[]> {
	const body = await api.get<Envelope<unknown[]>>("/api/search-providers");
	const rows = Array.isArray(body?.data) ? body.data : [];
	return rows
		.map(normalizeProvider)
		.filter((p): p is SearchProviderPublic => p !== null)
		.sort((a, b) => a.priority - b.priority);
}

export async function createSearchProvider(
	input: CreateSearchProviderInput,
): Promise<SearchProviderPublic> {
	const body = await api.post<Envelope<unknown>>(
		"/api/search-providers",
		input,
	);
	const row = normalizeProvider(body?.data);
	if (!row) throw new Error("The server did not return the created provider.");
	return row;
}

export async function updateSearchProvider(
	id: string,
	patch: UpdateSearchProviderInput,
): Promise<SearchProviderPublic> {
	const body = await api.patch<Envelope<unknown>>(
		`/api/search-providers/${encodeURIComponent(id)}`,
		patch,
	);
	const row = normalizeProvider(body?.data);
	if (!row) throw new Error("The server did not return the updated provider.");
	return row;
}

export async function deleteSearchProvider(id: string): Promise<void> {
	await api.delete(`/api/search-providers/${encodeURIComponent(id)}`);
}

export async function reorderSearchProvider(
	id: string,
	priority: number,
): Promise<SearchProviderPublic> {
	const body = await api.post<Envelope<unknown>>(
		`/api/search-providers/${encodeURIComponent(id)}/reorder`,
		{ priority },
	);
	const row = normalizeProvider(body?.data);
	if (!row) throw new Error("The server did not return the updated provider.");
	return row;
}

/**
 * Runs a live test against the provider. A failing test is a normal,
 * reportable outcome, so an HTTP error is converted into `{ ok: false }` with
 * the server's message instead of being thrown.
 */
export async function testSearchProvider(
	id: string,
): Promise<SearchProviderTestResult> {
	try {
		const body = await api.post<{
			data?: Partial<SearchProviderTestResult>;
		}>(`/api/search-providers/${encodeURIComponent(id)}/test`);
		// The handler wraps the result in the standard success envelope:
		// `{ success: true, data: { ok, latencyMs, error? } }`. Tolerate a
		// bare result too, so the adapter survives an envelope change.
		const envelope = asRecord(body);
		const raw = asRecord(envelope.data ?? envelope);
		return {
			ok: raw.ok === true,
			latencyMs: asNumber(raw.latencyMs),
			error: asNullableString(raw.error) ?? undefined,
		};
	} catch (error) {
		if (error instanceof HttpError) {
			return {
				ok: false,
				latencyMs: 0,
				error: error.message || `Request failed (${error.status})`,
			};
		}
		return {
			ok: false,
			latencyMs: 0,
			error: error instanceof Error ? error.message : "Request failed",
		};
	}
}

export async function getSearchProviderCatalog(): Promise<
	SearchProviderCatalogEntry[]
> {
	const body = await api.get<Envelope<unknown[]>>("/api/search-providers/meta");
	const rows = Array.isArray(body?.data) ? body.data : [];
	return rows
		.map(normalizeCatalogEntry)
		.filter((e): e is SearchProviderCatalogEntry => e !== null);
}
