export type ProviderModelDefaultOverrides = Record<
	string,
	Record<string, string>
>;

const factoryDefaults: ProviderModelDefaultOverrides = {};
let overrides: ProviderModelDefaultOverrides = {};

function copyMappings(
	mappings: ProviderModelDefaultOverrides,
): ProviderModelDefaultOverrides {
	const copied: ProviderModelDefaultOverrides = {};
	for (const [provider, families] of Object.entries(mappings)) {
		const values: Record<string, string> = {};
		for (const [family, model] of Object.entries(families)) {
			if (typeof model === "string" && model.trim())
				values[family] = model.trim();
		}
		if (Object.keys(values).length > 0) copied[provider] = values;
	}
	return copied;
}

/** Register a provider-owned built-in map without coupling providers to config. */
export function registerProviderModelDefaultFactory(
	provider: string,
	mappings: Record<string, string>,
): void {
	factoryDefaults[provider] = { ...mappings };
}

/** Replace the process-wide overrides after config load or a successful POST. */
export function setProviderModelDefaultOverrides(
	value: ProviderModelDefaultOverrides | undefined,
): void {
	overrides = copyMappings(value ?? {});
}

/**
 * Defaults derived from what an account itself reported it can serve.
 *
 * Keyed by account because two accounts of the same provider can be on
 * different plans, and the whole point is to stop guessing on their behalf. In
 * memory only: it is a projection of a listing already cached on disk, so
 * persisting it again would create a second thing to invalidate.
 */
const derivedByAccount = new Map<string, Record<string, string>>();

/** Same, but for the provider as a whole — see setDerived… below. */
const derivedByProvider: ProviderModelDefaultOverrides = {};

function derivedKey(provider: string, accountId: string): string {
	return `${provider}\0${accountId}`;
}

/**
 * Record the family -> model map that an account's own listing implies. Called
 * whenever that listing is read, which is what keeps the defaults current
 * without anyone maintaining a table.
 */
export function setDerivedProviderModelDefaults(
	provider: string,
	accountId: string,
	families: Record<string, string>,
): void {
	derivedByAccount.set(derivedKey(provider, accountId), { ...families });
	// The same listing also refreshes the provider-wide default: what the
	// settings screen shows, and what an account without its own listing falls
	// back to. Safe because the models this resolves to — the provider's top
	// priorities — are the ones its own payload marks as available in every
	// plan; the ones that vary by plan sit far below and are never picked.
	//
	// Kept apart from `factoryDefaults` on purpose: providers with no dynamic
	// source of their own (xai, qwen) still rely on their compiled map, and
	// overwriting that would break them.
	derivedByProvider[provider] = { ...families };
}

/** True when this account already has a derived map — no listing needed. */
export function hasDerivedProviderModelDefaults(
	provider: string,
	accountId: string,
): boolean {
	return derivedByAccount.has(derivedKey(provider, accountId));
}

/** Test seam: both derived maps are process-wide and leak between cases. */
export function clearDerivedProviderModelDefaults(): void {
	derivedByAccount.clear();
	for (const provider of Object.keys(derivedByProvider)) {
		delete derivedByProvider[provider];
	}
}

/**
 * Order of authority, most specific first:
 *
 *   1. an operator's explicit override for that family
 *   2. what THIS account's own listing implies
 *   3. the provider's built-in map
 *
 * The built-in map is last for a reason: it is a guess frozen at build time, and
 * a guess about which models an account may call is exactly the thing that fails
 * silently when a plan does not include one.
 */
export function resolveProviderModelDefault(
	provider: string,
	family: string,
	accountId?: string | null,
): string | undefined {
	const derived = accountId
		? derivedByAccount.get(derivedKey(provider, accountId))?.[family]
		: undefined;
	return (
		overrides[provider]?.[family] ??
		derived ??
		derivedByProvider[provider]?.[family] ??
		factoryDefaults[provider]?.[family]
	);
}

/**
 * What the settings screen calls the default. For a provider whose models
 * are discovered, that is the derived map; for one with only a compiled map,
 * it is that map. A provider can have both, and the discovered one wins,
 * because it is the one that reflects reality.
 */
export function getProviderModelDefaultFactories(): ProviderModelDefaultOverrides {
	const merged: ProviderModelDefaultOverrides = {};
	for (const [provider, families] of Object.entries(factoryDefaults)) {
		merged[provider] = { ...families };
	}
	for (const [provider, families] of Object.entries(derivedByProvider)) {
		merged[provider] = { ...(merged[provider] ?? {}), ...families };
	}
	return copyMappings(merged);
}

export function getProviderModelDefaultOverrides(): ProviderModelDefaultOverrides {
	return copyMappings(overrides);
}
