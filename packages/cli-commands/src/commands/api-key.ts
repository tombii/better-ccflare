import type { DatabaseOperations } from "@better-ccflare/database";
import {
	type ApiKeyGenerationResult,
	type ApiKeyResponse,
	type ApiKeyRole,
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
	if (dbOps.apiKeyNameExists(trimmedName)) {
		throw new Error(`API key with name '${trimmedName}' already exists`);
	}

	// Generate API key
	const crypto = new NodeCryptoUtils();
	const apiKey = await crypto.generateApiKey();
	const hashedKey = await crypto.hashApiKey(apiKey);
	const prefixLast8 = apiKey.slice(-8);

	// Create database record
	const id = globalThis.crypto.randomUUID();
	const now = Date.now();

	dbOps.createApiKey({
		id,
		name: trimmedName,
		hashedKey,
		prefixLast8,
		createdAt: now,
		isActive: true,
		role,
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
export function listApiKeys(dbOps: DatabaseOperations): ApiKeyResponse[] {
	const apiKeys = dbOps.getApiKeys();
	return apiKeys.map(toApiKeyResponse);
}

/**
 * Get details about a specific API key
 */
export function getApiKey(
	dbOps: DatabaseOperations,
	name: string,
): ApiKeyResponse | null {
	const apiKey = dbOps.getApiKeyByName(name);
	if (!apiKey) {
		return null;
	}
	return toApiKeyResponse(apiKey);
}

/**
 * Disable an API key (soft delete)
 */
export function disableApiKey(
	dbOps: DatabaseOperations,
	name: string,
): boolean {
	const apiKey = dbOps.getApiKeyByName(name);
	if (!apiKey) {
		throw new Error(`API key '${name}' not found`);
	}

	if (!apiKey.isActive) {
		throw new Error(`API key '${name}' is already disabled`);
	}

	const success = dbOps.disableApiKey(apiKey.id);
	if (!success) {
		throw new Error(`Failed to disable API key '${name}'`);
	}

	return true;
}

/**
 * Enable a previously disabled API key
 */
export function enableApiKey(dbOps: DatabaseOperations, name: string): boolean {
	const apiKey = dbOps.getApiKeyByName(name);
	if (!apiKey) {
		throw new Error(`API key '${name}' not found`);
	}

	if (apiKey.isActive) {
		throw new Error(`API key '${name}' is already active`);
	}

	const success = dbOps.enableApiKey(apiKey.id);
	if (!success) {
		throw new Error(`Failed to enable API key '${name}'`);
	}

	return true;
}

/**
 * Delete an API key permanently
 */
export function deleteApiKey(dbOps: DatabaseOperations, name: string): boolean {
	const apiKey = dbOps.getApiKeyByName(name);
	if (!apiKey) {
		throw new Error(`API key '${name}' not found`);
	}

	const success = dbOps.deleteApiKey(apiKey.id);
	if (!success) {
		throw new Error(`Failed to delete API key '${name}'`);
	}

	return true;
}

/**
 * Get API key statistics
 */
export function getApiKeyStats(dbOps: DatabaseOperations): {
	total: number;
	active: number;
	inactive: number;
} {
	const total = dbOps.countAllApiKeys();
	const active = dbOps.countActiveApiKeys();
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
export function formatApiKeyForDisplay(apiKey: ApiKeyResponse): string {
	const status = apiKey.isActive ? "Active" : "Disabled";
	const role = apiKey.role === "admin" ? "Admin" : "API-only";
	const lastUsed = apiKey.lastUsed
		? new Date(apiKey.lastUsed).toLocaleDateString()
		: "Never";

	return `  ${apiKey.name} (${apiKey.prefixLast8})
    Status: ${status}
    Role: ${role}
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
	return `✅ API Key Generated Successfully!

Name: ${result.name}
Role: ${role}
Key: ${result.apiKey}  ⚠️  Save this key now - it won't be shown again
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
