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

/** Factory first, then a configured override when that exact family has one. */
export function resolveProviderModelDefault(
	provider: string,
	family: string,
): string | undefined {
	return overrides[provider]?.[family] ?? factoryDefaults[provider]?.[family];
}

export function getProviderModelDefaultFactories(): ProviderModelDefaultOverrides {
	return copyMappings(factoryDefaults);
}

export function getProviderModelDefaultOverrides(): ProviderModelDefaultOverrides {
	return copyMappings(overrides);
}
