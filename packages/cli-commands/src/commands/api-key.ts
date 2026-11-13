import type { DatabaseOperations } from "@better-ccflare/database";
import {
	type ApiKeyGenerationResult,
	type ApiKeyLimitInput,
	type ApiKeyResponse,
	type ApiKeyRestrictions,
	type ApiKeyRole,
	type ApiKeySpendLimit,
	NodeCryptoUtils,
	toApiKeyResponse,
} from "@better-ccflare/types";

/**
 * Generate a new API key
 */
export async function generateApiKey(
	dbOps: DatabaseOperations,
	name: string,
	role: ApiKeyRole = "api-only",
	restrictions?: Partial<ApiKeyRestrictions>,
	spendLimit?: ApiKeySpendLimit | null,
): Promise<ApiKeyGenerationResult> {
	// Validate name
	if (!name || name.trim().length === 0) {
		throw new Error("API key name cannot be empty");
	}

	const trimmedName = name.trim();

	// Validate name length
	if (trimmedName.length > 100) {
		throw new Error("API key name cannot exceed 100 characters");
	}

	// Check if name already exists
	if (await dbOps.apiKeyNameExists(trimmedName)) {
		throw new Error(`API key with name '${trimmedName}' already exists`);
	}

	// Prevent creating api-only key when no other keys exist (would lock user out of dashboard)
	if (role === "api-only" && (await dbOps.countActiveApiKeys()) === 0) {
		throw new Error(
			"Cannot create an API-only key as your first key. " +
				"API-only keys cannot access the dashboard, which would lock you out. " +
				"Please create an Admin key first using: --role admin",
		);
	}

	// Generate API key
	const crypto = new NodeCryptoUtils();
	const apiKey = await crypto.generateApiKey();
	const hashedKey = await crypto.hashApiKey(apiKey);
	const prefixLast8 = apiKey.slice(-8);

	// Create database record
	const id = globalThis.crypto.randomUUID();
	const now = Date.now();

	await dbOps.createApiKey({
		id,
		name: trimmedName,
		hashedKey,
		prefixLast8,
		createdAt: now,
		isActive: true,
		role,
		restrictions,
		spendLimit,
	});

	return {
		id,
		name: trimmedName,
		apiKey,
		prefixLast8,
		createdAt: new Date(now).toISOString(),
		role,
	};
}

/**
 * List all API keys
 */
export async function listApiKeys(
	dbOps: DatabaseOperations,
): Promise<ApiKeyResponse[]> {
	const apiKeys = await dbOps.getApiKeys();
	return apiKeys.map(toApiKeyResponse);
}

/**
 * Get details about a specific API key
 */
export async function getApiKey(
	dbOps: DatabaseOperations,
	name: string,
): Promise<ApiKeyResponse | null> {
	const apiKey = await dbOps.getApiKeyByName(name);
	if (!apiKey) {
		return null;
	}
	return toApiKeyResponse(apiKey);
}

/**
 * Disable an API key (soft delete)
 */
export async function disableApiKey(
	dbOps: DatabaseOperations,
	name: string,
): Promise<boolean> {
	const apiKey = await dbOps.getApiKeyByName(name);
	if (!apiKey) {
		throw new Error(`API key '${name}' not found`);
	}

	if (!apiKey.isActive) {
		throw new Error(`API key '${name}' is already disabled`);
	}

	// Prevent disabling the last active admin key if other keys exist
	if (apiKey.role === "admin") {
		const allKeys = await dbOps.getApiKeys();
		const activeAdminKeys = allKeys.filter(
			(k) => k.isActive && k.role === "admin",
		);

		// If this is the only admin key but there are other non-admin keys
		if (activeAdminKeys.length === 1) {
			const otherActiveKeys = allKeys.filter(
				(k) => k.isActive && k.id !== apiKey.id,
			);

			if (otherActiveKeys.length > 0) {
				// There are other keys, so this admin key is needed for dashboard access
				throw new Error(
					"Cannot disable the last active admin key. " +
						"This would lock you out of the dashboard. " +
						"Create another admin key first, or disable an API-only key instead.",
				);
			}
			// If this is the only key (last key overall), we allow disabling
			// which will effectively disable authentication and unlock the dashboard
		}
	}

	const success = await dbOps.disableApiKey(apiKey.id);
	if (!success) {
		throw new Error(`Failed to disable API key '${name}'`);
	}

	return true;
}

/**
 * Enable a previously disabled API key
 */
export async function enableApiKey(
	dbOps: DatabaseOperations,
	name: string,
): Promise<boolean> {
	const apiKey = await dbOps.getApiKeyByName(name);
	if (!apiKey) {
		throw new Error(`API key '${name}' not found`);
	}

	if (apiKey.isActive) {
		throw new Error(`API key '${name}' is already active`);
	}

	const success = await dbOps.enableApiKey(apiKey.id);
	if (!success) {
		throw new Error(`Failed to enable API key '${name}'`);
	}

	return true;
}

/**
 * Delete an API key permanently
 */
export async function deleteApiKey(
	dbOps: DatabaseOperations,
	name: string,
): Promise<boolean> {
	const apiKey = await dbOps.getApiKeyByName(name);
	if (!apiKey) {
		throw new Error(`API key '${name}' not found`);
	}

	// Prevent deleting the last active admin key if other keys exist
	if (apiKey.isActive && apiKey.role === "admin") {
		const allKeys = await dbOps.getApiKeys();
		const activeAdminKeys = allKeys.filter(
			(k) => k.isActive && k.role === "admin",
		);

		// If this is the only admin key but there are other non-admin keys
		if (activeAdminKeys.length === 1) {
			const otherActiveKeys = allKeys.filter(
				(k) => k.isActive && k.id !== apiKey.id,
			);

			if (otherActiveKeys.length > 0) {
				// There are other keys, so this admin key is needed for dashboard access
				throw new Error(
					"Cannot delete the last active admin key. " +
						"This would lock you out of the dashboard. " +
						"Create another admin key first, or delete an API-only key instead.",
				);
			}
			// If this is the only key (last key overall), we allow deletion
			// which will disable authentication and unlock the dashboard
		}
	}

	const success = await dbOps.deleteApiKey(apiKey.id);
	if (!success) {
		throw new Error(`Failed to delete API key '${name}'`);
	}

	return true;
}

/**
 * Update an API key's role
 */
export async function updateApiKeyRole(
	dbOps: DatabaseOperations,
	id: string,
	role: ApiKeyRole,
	currentApiKeyId?: string,
): Promise<boolean> {
	const apiKey = await dbOps.getApiKey(id);
	if (!apiKey) {
		throw new Error("API key not found");
	}

	// Prevent modifying the currently authenticated key
	if (currentApiKeyId && apiKey.id === currentApiKeyId) {
		throw new Error(
			"Cannot modify the role of the currently authenticated API key to prevent lockouts",
		);
	}

	// Prevent changing the first API key from admin (it should always remain admin)
	// Get all keys ordered by creation date
	const allKeys = await dbOps.getApiKeys();
	const firstKey = allKeys.sort((a, b) => a.createdAt - b.createdAt)[0];

	if (firstKey && apiKey.id === firstKey.id && role === "api-only") {
		throw new Error(
			"Cannot change the first API key to api-only. The first key must remain an admin key to prevent lockouts.",
		);
	}

	// Prevent changing the last active admin key to api-only if other keys exist
	if (apiKey.role === "admin" && role === "api-only") {
		const activeAdminKeys = allKeys.filter(
			(k) => k.isActive && k.role === "admin",
		);

		// If this is the only admin key but there are other non-admin keys
		if (activeAdminKeys.length === 1) {
			const otherActiveKeys = allKeys.filter(
				(k) => k.isActive && k.id !== apiKey.id,
			);

			if (otherActiveKeys.length > 0) {
				// There are other keys, so this admin key is needed for dashboard access
				throw new Error(
					"Cannot change the last active admin key to api-only. " +
						"This would lock you out of the dashboard. " +
						"Create another admin key first, or change an API-only key to admin instead.",
				);
			}
		}
	}

	const success = await dbOps.updateApiKeyRole(apiKey.id, role);
	if (!success) {
		throw new Error("Failed to update API key role");
	}

	return true;
}

/**
 * Replace an API key's account / model / provider restrictions.
 *
 * Accepts an id or a name, like the other admin operations reached through
 * `/api/api-keys/:idOrName/...`.
 *
 * No lockout guard here, deliberately, unlike `updateApiKeyRole`: these
 * restrictions only narrow which upstream accounts and models a key may route
 * to. Dashboard access is decided by `role` alone, so restricting a key — even
 * the caller's own, even the last admin key — cannot lock anyone out.
 */
export async function updateApiKeyRestrictions(
	dbOps: DatabaseOperations,
	idOrName: string,
	restrictions: ApiKeyRestrictions,
): Promise<boolean> {
	const apiKey =
		(await dbOps.getApiKey(idOrName)) ??
		(await dbOps.getApiKeyByName(idOrName));
	if (!apiKey) {
		throw new Error("API key not found");
	}

	const success = await dbOps.updateApiKeyRestrictions(apiKey.id, restrictions);
	if (!success) {
		throw new Error("Failed to update API key restrictions");
	}

	return true;
}

/**
 * Replace an API key's spend limit. `null` clears it.
 *
 * Accepts an id or a name, like the other admin operations reached through
 * `/api/api-keys/:idOrName/...`. No lockout guard, for the same reason
 * `updateApiKeyRestrictions` has none: dashboard access is decided by `role`
 * alone, so a budget — even a caller's own, even the last admin key's —
 * cannot lock anyone out of the dashboard.
 *
 * Returns the key's id so the caller can drop its cached spend total: the
 * in-memory counter is keyed by id, and leaving a stale entry behind would
 * keep measuring a window the operator has just replaced.
 */
export async function updateApiKeySpendLimit(
	dbOps: DatabaseOperations,
	idOrName: string,
	spendLimit: ApiKeySpendLimit | null,
): Promise<string> {
	const apiKey =
		(await dbOps.getApiKey(idOrName)) ??
		(await dbOps.getApiKeyByName(idOrName));
	if (!apiKey) {
		throw new Error("API key not found");
	}

	const success = await dbOps.updateApiKeySpendLimit(apiKey.id, spendLimit);
	if (!success) {
		throw new Error("Failed to update API key spend limit");
	}

	return apiKey.id;
}

/**
 * Describe a key's spend limit in one short line, for CLI summaries.
 *
 * "warn only" is said out loud: a limit that never refuses looks identical to
 * one that does in every other field, and that is the one thing an operator
 * reading this line most needs to know.
 */
export function formatApiKeySpendLimit(apiKey: ApiKeyResponse): string {
	if (apiKey.limitUsd == null) return "none";
	const window = apiKey.limitWindow ?? "rolling_30d";
	const enforce = apiKey.limitEnforce ?? "block";
	return `$${apiKey.limitUsd} per ${window}${enforce === "warn" ? " (warn only)" : ""}`;
}

/**
 * Describe a key's restrictions in one short line, for CLI and dashboard
 * summaries. `null` reads as unrestricted; `[]` reads as a deny-all, which is
 * a legitimate but drastic setting and must never look like "unrestricted".
 */
export function formatApiKeyRestrictions(apiKey: ApiKeyResponse): string {
	const parts: string[] = [];
	const describe = (
		list: string[] | null,
		singular: string,
		plural: string,
	) => {
		if (list === null) return;
		if (list.length === 0) {
			parts.push(`no ${plural} (denies all requests)`);
			return;
		}
		parts.push(
			list.length === 1
				? `1 ${singular}: ${list[0]}`
				: `${list.length} ${plural}`,
		);
	};
	describe(apiKey.allowedAccounts, "account", "accounts");
	describe(apiKey.allowedModels, "model", "models");
	describe(apiKey.allowedProviders, "provider", "providers");
	return parts.length === 0 ? "unrestricted" : parts.join(", ");
}

/**
 * Get API key statistics
 */
export async function getApiKeyStats(dbOps: DatabaseOperations): Promise<{
	total: number;
	active: number;
	inactive: number;
}> {
	const total = await dbOps.countAllApiKeys();
	const active = await dbOps.countActiveApiKeys();
	const inactive = total - active;

	return {
		total,
		active,
		inactive,
	};
}

/**
 * Format API key for display in CLI
 */
export function formatApiKeyForDisplay(
	apiKey: ApiKeyResponse,
	limits?: ApiKeyLimitInput[],
): string {
	const status = apiKey.isActive ? "Active" : "Disabled";
	const role = apiKey.role === "admin" ? "Admin" : "API-only";
	const lastUsed = apiKey.lastUsed
		? new Date(apiKey.lastUsed).toLocaleDateString()
		: "Never";
	const limitSummary = limits
		? limits.length === 0
			? "none"
			: limits
					.map(
						(limit) =>
							`$${limit.limitUsd}/${limit.window} (${limit.scopeModel ?? "whole key"}, ${limit.enforce})`,
					)
					.join("; ")
		: formatApiKeySpendLimit(apiKey);

	return `  ${apiKey.name} (${apiKey.prefixLast8})
    Status: ${status}
    Role: ${role}
    Restrictions: ${formatApiKeyRestrictions(apiKey)}
    Spend limits (${apiKey.limitWindowMode ?? "calendar"}): ${limitSummary}
    Routing: ${
			apiKey.familyComboOverrides
				? Object.entries(apiKey.familyComboOverrides)
						.map(([family, combo]) => `${family}=${combo}`)
						.join(", ")
				: "global assignments"
		}
    Created: ${new Date(apiKey.createdAt).toLocaleDateString()}
    Last Used: ${lastUsed}
    Usage Count: ${apiKey.usageCount}`;
}

/**
 * Format API key generation result for display
 */
export function formatApiKeyGenerationResult(
	result: ApiKeyGenerationResult,
): string {
	const role = result.role === "admin" ? "Admin" : "API-only";
	return `API Key Generated Successfully!

Name: ${result.name}
Role: ${role}
Key: ${result.apiKey}  Save this key now - it won't be shown again
Prefix: ${result.prefixLast8}
Created: ${new Date(result.createdAt).toLocaleString()}

Usage:
  Include this key in your requests using the 'x-api-key' header:
  x-api-key: ${result.apiKey}

Example:
  curl -X POST http://localhost:8080/v1/messages \\
    -H "Content-Type: application/json" \\
    -H "x-api-key: ${result.apiKey}" \\
    -d '{"model": "claude-3-haiku-20240307", "messages": [{"role": "user", "content": "Hello"}]}'
`;
}
