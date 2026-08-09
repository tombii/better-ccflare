import { api } from "../api";

/**
 * Adapter for ONE endpoint: the per-provider-and-family default model map
 * currently embedded in code (codex, xai, qwen, ...) and used as the LAST
 * word when neither the combo slot nor account mapping supplies a model. One
 * of these hardcoded maps caused the incident
 * `400 The 'gpt-5.3-codex' model is not supported when using Codex with a
 * ChatGPT account` — the account subscription cannot use that model, and
 * until now rebuilding was the only possible fix.
 *
 * Everything the dashboard knows about these response shapes lives here: if
 * the backend changes the contract, this is the only file to update.
 *
 *   GET  /api/config/provider-model-defaults
 *     -> per provider and family: factory value, override (if any), and
 *        effective value. Expected shape (tolerant of shape variation):
 *        { providers: [ { provider, fields: [
 *            { family, factory, override, effective },
 *        ] } ] }
 *   POST /api/config/provider-model-defaults   body { overrides: [{ provider, family, model }] }
 *     -> saves overrides; model === "" removes the override for that
 *        provider and family (returns to the factory value).
 *
 * Authentication comes for free from the shared `api` client, which injects
 * `x-api-key` into every request and opens the auth dialog on 401.
 */

export interface ProviderModelDefaultField {
	family: string;
	/** Value embedded in code — what applies with no override. */
	factory: string;
	/** Override saved today; null when there is no customization. */
	override: string | null;
	/** What the proxy actually uses now (override if present, otherwise factory). */
	effective: string;
}

export interface ProviderModelDefaults {
	provider: string;
	fields: ProviderModelDefaultField[];
}

export interface ProviderModelDefaultOverrideInput {
	provider: string;
	family: string;
	/** An empty string removes the override (returns to the factory value). */
	model: string;
}

function asRecord(raw: unknown): Record<string, unknown> {
	return raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
}

function asString(raw: unknown): string {
	return typeof raw === "string" ? raw.trim() : "";
}

function normalizeField(raw: unknown): ProviderModelDefaultField | null {
	const entry = asRecord(raw);
	const family = asString(entry.family);
	if (!family) return null;
	const factory = asString(entry.factory);
	const overrideRaw = entry.override;
	const override =
		typeof overrideRaw === "string" && overrideRaw.trim()
			? overrideRaw.trim()
			: null;
	// effective tolerates being absent: falls back to override, then factory.
	const effective = asString(entry.effective) || override || factory;
	return { family, factory, override, effective };
}

function normalizeProvider(raw: unknown): ProviderModelDefaults | null {
	const entry = asRecord(raw);
	const provider = asString(entry.provider);
	if (!provider) return null;
	const list: unknown[] = Array.isArray(entry.fields) ? entry.fields : [];
	const fields: ProviderModelDefaultField[] = [];
	for (const item of list) {
		const field = normalizeField(item);
		if (field) fields.push(field);
	}
	return { provider, fields };
}

/** Default model map for all providers. Malformed input becomes an empty list. */
export async function fetchProviderModelDefaults(): Promise<
	ProviderModelDefaults[]
> {
	const body = asRecord(
		await api.get<unknown>("/api/config/provider-model-defaults"),
	);
	const list: unknown[] = Array.isArray(body.providers) ? body.providers : [];
	const providers: ProviderModelDefaults[] = [];
	for (const item of list) {
		const provider = normalizeProvider(item);
		if (provider) providers.push(provider);
	}
	return providers;
}

/**
 * Saves overrides in one operation, triggered by explicit action (the Save
 * button): this card does not save on every keystroke. A field with
 * model === "" removes that provider-and-family override (returns to factory).
 */
export async function saveProviderModelDefaultOverrides(
	overrides: ProviderModelDefaultOverrideInput[],
): Promise<void> {
	await api.post("/api/config/provider-model-defaults", { overrides });
}
