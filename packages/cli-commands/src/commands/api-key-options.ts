import type { DatabaseOperations } from "@better-ccflare/database";
import {
	type ApiKeyLimitInput,
	type ApiKeyLimitWindowMode,
	type ApiKeyRestrictions,
	PROVIDER_NAMES,
} from "@better-ccflare/types";

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
): Promise<void> {
	await validateApiKeyOptions(dbOps, options);
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
