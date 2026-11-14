import {
	CLAUDE_MODEL_IDS,
	getModelMappings,
	KNOWN_PATTERNS,
	listLocalCatalogueModelIds,
	stripModelRouting,
} from "@better-ccflare/core";
import type { DatabaseOperations } from "@better-ccflare/database";
import {
	getProvider,
	getProviderModelDefaultFactories,
	getProviderModelDefaultOverrides,
	listProviders,
	type ProviderModelDefaultOverrides,
} from "@better-ccflare/providers";
import { getModelCatalog } from "@better-ccflare/proxy";
import {
	type ApiKeyGenerationResult,
	type ApiKeyLimitInput,
	type ApiKeyLimitWindowMode,
	type ApiKeyRestrictions,
	type ApiKeyRole,
	PROVIDER_NAMES,
} from "@better-ccflare/types";
import { generateApiKey } from "./api-key";

export interface ApiKeyOptions {
	restrictions?: Partial<ApiKeyRestrictions>;
	limits?: ApiKeyLimitInput[];
	limitMode?: ApiKeyLimitWindowMode;
	familyComboOverrides?: Record<string, string> | null;
}

/** `*` removes a restriction; `none` explicitly denies every value. */
export function parseApiKeyAllowList(value: string): string[] | null {
	if (value === "*") return null;
	if (value === "none") return [];
	const entries = value.split(",").map((entry) => entry.trim());
	if (entries.some((entry) => !entry)) {
		throw new Error(
			"Allow lists must contain non-empty comma-separated values",
		);
	}
	return [...new Set(entries)];
}

export function parseApiKeyLimitMode(value: string): ApiKeyLimitWindowMode {
	if (value !== "calendar" && value !== "rolling") {
		throw new Error("--limit-mode must be calendar or rolling");
	}
	return value;
}

/** Parse a repeatable --limit window=day,usd=5[,model=opus][,warn]. */
export function parseApiKeyLimit(value: string): ApiKeyLimitInput {
	const fields = new Map<string, string>();
	for (const part of value.split(",")) {
		const separator = part.indexOf("=");
		const name = separator < 0 ? part : part.slice(0, separator);
		const fieldValue = separator < 0 ? "" : part.slice(separator + 1);
		if (
			!["window", "usd", "model", "warn"].includes(name) ||
			fields.has(name) ||
			(name === "warn" ? separator >= 0 : !fieldValue)
		) {
			throw new Error(`Invalid --limit field '${part}'`);
		}
		fields.set(name, fieldValue);
	}
	const window = fields.get("window");
	if (
		window !== "hour" &&
		window !== "day" &&
		window !== "week" &&
		window !== "month"
	) {
		throw new Error("--limit window must be hour, day, week or month");
	}
	const limitUsd = Number(fields.get("usd"));
	if (!Number.isFinite(limitUsd) || limitUsd <= 0) {
		throw new Error("--limit usd must be a finite number greater than 0");
	}
	const scopeModel = fields.get("model") ?? null;
	if (scopeModel !== null && !/^[\w./:+-]+$/.test(scopeModel)) {
		throw new Error("--limit model must be a model id or family name");
	}
	return {
		scopeModel,
		window,
		limitUsd,
		enforce: fields.has("warn") ? "warn" : "block",
	};
}

export function parseApiKeyRouting(value: string): [string, string] {
	const separator = value.indexOf("=");
	const family = value.slice(0, separator);
	const comboId = value.slice(separator + 1);
	if (
		separator < 1 ||
		!["fable", "opus", "sonnet", "haiku"].includes(family) ||
		!comboId.trim()
	) {
		throw new Error(
			"--routing must be family=combo-id (fable, opus, sonnet or haiku)",
		);
	}
	return [family, comboId];
}

/** Validate references before creation so invalid flags never leave a new key. */
export async function validateApiKeyOptions(
	dbOps: DatabaseOperations,
	options: ApiKeyOptions,
	providerDefaults: ProviderModelDefaultOverrides = {},
): Promise<void> {
	const providers = Object.values(PROVIDER_NAMES) as string[];
	for (const provider of options.restrictions?.allowedProviders ?? []) {
		if (!providers.includes(provider)) {
			throw new Error(`Unknown provider '${provider}'`);
		}
	}
	const seen = new Set<string>();
	for (const limit of options.limits ?? []) {
		const identity = JSON.stringify([limit.scopeModel, limit.window]);
		if (seen.has(identity)) {
			throw new Error("Duplicate --limit for the same model scope and window");
		}
		seen.add(identity);
	}
	const allowedAccounts = options.restrictions?.allowedAccounts ?? [];
	const scopes = (options.limits ?? [])
		.map((limit) => limit.scopeModel?.toLowerCase())
		.filter((scope): scope is string => !!scope);
	const knownScopes = new Set<string>([
		...KNOWN_PATTERNS,
		...Object.values(CLAUDE_MODEL_IDS),
	]);
	if (
		allowedAccounts.length ||
		scopes.some((scope) => !knownScopes.has(scope))
	) {
		const accounts = await dbOps.getAllAccounts();
		const accountIds = new Set(accounts.map((account) => account.id));
		for (const id of allowedAccounts) {
			if (!accountIds.has(id)) throw new Error(`Unknown account '${id}'`);
		}
		// Only local catalogue/cache and configured mappings are consulted. CLI
		// validation must never probe an upstream (especially a Claude account).
		for (const model of await listLocalCatalogueModelIds())
			knownScopes.add(model.toLowerCase());
		for (const model of (await getModelCatalog()).models)
			knownScopes.add(model.id.toLowerCase());
		for (const provider of listProviders()) {
			const model = getProvider(provider)?.getDefaultModel?.();
			if (model) knownScopes.add(stripModelRouting(model).toLowerCase());
		}
		for (const mappings of [
			...Object.values(getProviderModelDefaultFactories()),
			...Object.values(getProviderModelDefaultOverrides()),
			...Object.values(providerDefaults),
			...accounts.map((account) => getModelMappings(account)),
		]) {
			for (const value of Object.values(mappings))
				for (const model of Array.isArray(value) ? value : [value])
					if (typeof model === "string")
						knownScopes.add(stripModelRouting(model).toLowerCase());
		}
		// A combo pin is a routed model a scoped limit can match, even when no
		// catalogue or mapping names it.
		for (const combo of await dbOps.listCombos())
			for (const slot of await dbOps.getComboSlots(combo.id))
				if (slot.model?.trim())
					knownScopes.add(stripModelRouting(slot.model).trim().toLowerCase());
	}
	for (const scope of scopes) {
		if (!knownScopes.has(scope))
			throw new Error(
				`Unknown model scope '${scope}'; use a known family, catalogue model or configured account model`,
			);
	}
	for (const comboId of Object.values(options.familyComboOverrides ?? {})) {
		if (!(await dbOps.getCombo(comboId))) {
			throw new Error(`Combo '${comboId}' not found`);
		}
	}
}

/** Only explicitly supplied settings are replaced on an existing key. */
export async function configureApiKey(
	dbOps: DatabaseOperations,
	idOrName: string,
	options: ApiKeyOptions,
	providerDefaults: ProviderModelDefaultOverrides = {},
): Promise<void> {
	await validateApiKeyOptions(dbOps, options, providerDefaults);
	const key =
		(await dbOps.getApiKey(idOrName)) ??
		(await dbOps.getApiKeyByName(idOrName));
	if (!key) throw new Error(`API key '${idOrName}' not found`);
	if (options.restrictions) {
		const restrictions = {
			allowedAccounts: key.allowedAccounts,
			allowedModels: key.allowedModels,
			allowedProviders: key.allowedProviders,
			...options.restrictions,
		};
		if (!(await dbOps.updateApiKeyRestrictions(key.id, restrictions))) {
			throw new Error("Failed to update API key restrictions");
		}
	}
	if (options.limits !== undefined || options.limitMode !== undefined) {
		const limits = options.limits ?? (await dbOps.getApiKeyLimits(key.id));
		if (
			!(await dbOps.replaceApiKeyLimits(
				key.id,
				limits,
				options.limitMode ?? key.limitWindowMode ?? "calendar",
			))
		) {
			throw new Error("Failed to update API key limits");
		}
	}
	if (options.familyComboOverrides !== undefined) {
		if (
			!(await dbOps.updateApiKeyRouting(key.id, options.familyComboOverrides))
		) {
			throw new Error("Failed to update API key routing");
		}
	}
}

/** Return the one-time secret only after every CLI setting has been saved. */
export async function generateConfiguredApiKey(
	dbOps: DatabaseOperations,
	name: string,
	role: ApiKeyRole,
	options: ApiKeyOptions,
	providerDefaults: ProviderModelDefaultOverrides = {},
): Promise<ApiKeyGenerationResult> {
	await validateApiKeyOptions(dbOps, options, providerDefaults);
	const result = await generateApiKey(dbOps, name, role, options.restrictions);
	try {
		await configureApiKey(dbOps, result.id, options, providerDefaults);
	} catch (error) {
		try {
			if (!(await dbOps.deleteApiKey(result.id))) {
				throw new Error("API key was not removed");
			}
		} catch (cleanupError) {
			const message = error instanceof Error ? error.message : String(error);
			const cleanupMessage =
				cleanupError instanceof Error
					? cleanupError.message
					: String(cleanupError);
			throw new Error(
				`${message}; failed to remove newly created API key '${result.id}': ${cleanupMessage}`,
				{ cause: error },
			);
		}
		throw error;
	}
	return result;
}
