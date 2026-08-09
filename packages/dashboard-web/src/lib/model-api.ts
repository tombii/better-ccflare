import { HttpError } from "@better-ccflare/http-common";
import { api } from "../api";

/**
 * Adapter for the two endpoints used by the model selector.
 *
 * Everything the dashboard knows about these response shapes lives here: if
 * the backend changes the contract, this is the only file to update.
 *
 *   GET  /api/models?provider=<anthropic|codex|...>
 *     -> { provider, fetchedAt, source, models: [{ id, displayName, source }] }
 *   POST /api/accounts/:id/test-model    body { model }
 *     -> { ok, inconclusive?, status, error?, durationMs }
 *
 * Authentication comes for free from the shared `api` client, which injects
 * `x-api-key` into every request and opens the auth dialog on 401.
 */

export type ProviderModelSource = "builtin" | "catalog" | "reference";

export interface ProviderModel {
	id: string;
	displayName: string;
	/**
	 * "builtin"/"catalog": ccflare knows this model for the provider.
	 * "reference": it exists in the provider public catalog — which is NOT a
	 * promise that the account plan can call it.
	 */
	source: ProviderModelSource;
}

export interface ProviderModels {
	provider: string;
	fetchedAt: number | null;
	source: string | null;
	models: ProviderModel[];
}

const MODEL_SOURCES: ProviderModelSource[] = [
	"builtin",
	"catalog",
	"reference",
];

function normalizeSource(value: unknown): ProviderModelSource {
	return MODEL_SOURCES.includes(value as ProviderModelSource)
		? (value as ProviderModelSource)
		: "catalog";
}

function normalizeModel(raw: unknown): ProviderModel | null {
	if (typeof raw === "string") {
		const id = raw.trim();
		return id ? { id, displayName: id, source: "catalog" } : null;
	}
	if (!raw || typeof raw !== "object") return null;
	const entry = raw as Record<string, unknown>;
	const id = typeof entry.id === "string" ? entry.id.trim() : "";
	if (!id) return null;
	const displayName =
		typeof entry.displayName === "string" && entry.displayName.trim()
			? entry.displayName.trim()
			: id;
	return { id, displayName, source: normalizeSource(entry.source) };
}

function asRecord(raw: unknown): Record<string, unknown> {
	return raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
}

/** Model list for a provider. Tolerant: malformed input becomes an empty list. */
export async function fetchProviderModels(
	provider: string,
): Promise<ProviderModels> {
	const body = asRecord(
		await api.get<unknown>(
			`/api/models?provider=${encodeURIComponent(provider)}`,
		),
	);
	const list: unknown[] = Array.isArray(body.models) ? body.models : [];
	const seen = new Set<string>();
	const models: ProviderModel[] = [];
	for (const item of list) {
		const model = normalizeModel(item);
		if (!model || seen.has(model.id)) continue;
		seen.add(model.id);
		models.push(model);
	}
	return {
		provider: typeof body.provider === "string" ? body.provider : provider,
		fetchedAt: typeof body.fetchedAt === "number" ? body.fetchedAt : null,
		source: typeof body.source === "string" ? body.source : null,
		models,
	};
}

export function parseModelList(value: string): string[] {
	return value
		.split(",")
		.map((part) => part.trim())
		.filter(Boolean);
}

export function formatModelList(models: string[]): string {
	return models.join(", ");
}

/** First model in the list — the one the proxy tries before the others. */
export function firstModelInList(value: string): string {
	return parseModelList(value)[0] ?? "";
}
