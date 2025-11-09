import { Logger } from "@better-ccflare/logger";
import type { Account } from "@better-ccflare/types";
import { safeJsonParse, validateModelMappings } from "./validation";

const log = new Logger("ModelMappings");

// Centralized cache for sorted model mapping keys
// Shared across all providers to avoid redundant sorting
const MODEL_MAPPING_CACHE = new Map<string, string[]>();
const MAX_CACHE_SIZE = 1000; // Prevent memory leaks

// Inline types to avoid Bun import issues
// Types are now defined in index.ts and exported from there

/**
 * Default model mappings for OpenAI-compatible providers
 */
export const DEFAULT_MODEL_MAPPINGS = {
	// Generic mappings by model family - these support wildcards
	opus: "openai/gpt-5",
	sonnet: "openai/gpt-5",
	haiku: "openai/gpt-5-mini",
};

/**
 * Parse custom endpoint data from account's custom_endpoint field
 */
export function parseCustomEndpointData(
	customEndpoint: string | null,
): { endpoint?: string; modelMappings?: Record<string, string> } | null {
	if (!customEndpoint) {
		return null;
	}

	const trimmed = customEndpoint.trim();
	if (!trimmed.startsWith("{")) {
		// Return plain string as endpoint
		return { endpoint: trimmed };
	}

	try {
		return safeJsonParse<{
			endpoint?: string;
			modelMappings?: Record<string, string>;
		}>(trimmed, "custom_endpoint");
	} catch (error) {
		log.warn(
			`Failed to parse custom_endpoint JSON, treating as plain string: ${error instanceof Error ? error.message : String(error)}`,
		);
		return { endpoint: trimmed };
	}
}

/**
 * Normalize model mappings string for consistent cache keys
 * Only normalizes whitespace/formatting, preserves case sensitivity for JSON keys
 */
function normalizeModelMappings(modelMappings: string): string {
	return modelMappings
		.trim()
		.replace(/\r\n/g, "\n") // Normalize line endings
		.replace(/\n\s+/g, "\n") // Remove leading spaces
		.replace(/\s+\n/g, "\n") // Remove trailing spaces
		.replace(/\s+/g, " ")    // Normalize multiple spaces to single space
		.replace(/\s*([{}:,])\s*/g, "$1"); // Remove spaces around JSON syntax
}

/**
 * Get sorted model mapping keys with caching
 * This eliminates redundant sorting operations across all providers
 */
function getSortedModelMappingKeys(mappings: Record<string, string>): string[] {
	// Create cache key from mappings content
	const mappingsString = JSON.stringify(mappings);
	const normalizedKey = normalizeModelMappings(mappingsString);

	// Check cache first
	if (MODEL_MAPPING_CACHE.has(normalizedKey)) {
		const cachedKeys = MODEL_MAPPING_CACHE.get(normalizedKey);
		return cachedKeys || [];
	}

	// Cache miss - sort and cache
	const sortedKeys = Object.keys(mappings).sort((a, b) => b.length - a.length); // Longest first

	// Implement LRU eviction to prevent memory leaks
	if (MODEL_MAPPING_CACHE.size >= MAX_CACHE_SIZE) {
		const firstKey = MODEL_MAPPING_CACHE.keys().next().value;
		if (firstKey) {
			MODEL_MAPPING_CACHE.delete(firstKey);
		}

		if (process.env.DEBUG?.includes("model") || process.env.DEBUG === "true") {
			log.debug(
				`Model mapping cache: Evicted oldest entry (cache size: ${MODEL_MAPPING_CACHE.size})`,
			);
		}
	}

	MODEL_MAPPING_CACHE.set(normalizedKey, sortedKeys);

	if (process.env.DEBUG?.includes("model") || process.env.DEBUG === "true") {
		log.debug(
			`Model mapping cache: Cached new entry (cache size: ${MODEL_MAPPING_CACHE.size})`,
		);
	}

	return sortedKeys;
}

/**
 * Parse model mappings from account's model_mappings field
 */
export function parseModelMappings(
	modelMappings: string | null,
): Record<string, string> | null {
	if (!modelMappings) {
		return null;
	}

	try {
		return safeJsonParse<Record<string, string>>(
			modelMappings,
			"model_mappings",
		);
	} catch (error) {
		log.warn(
			`Failed to parse model_mappings JSON: ${error instanceof Error ? error.message : String(error)}`,
		);
		return null;
	}
}

/**
 * Get effective model mappings for an account
 */
export function getModelMappings(account: Account): Record<string, string> {
	const mappings: Record<string, string> = { ...DEFAULT_MODEL_MAPPINGS };

	// Check for environment variable overrides (only in Node.js)
	if (
		typeof process !== "undefined" &&
		process.env?.OPENAI_COMPATIBLE_MODEL_MAPPINGS
	) {
		try {
			const envMappings = safeJsonParse<Record<string, string>>(
				process.env.OPENAI_COMPATIBLE_MODEL_MAPPINGS,
				"OPENAI_COMPATIBLE_MODEL_MAPPINGS environment variable",
			);
			Object.assign(mappings, envMappings);
		} catch (error) {
			log.warn(
				"Failed to parse OPENAI_COMPATIBLE_MODEL_MAPPINGS environment variable:",
				error,
			);
		}
	}

	// Check for account-specific mappings in model_mappings field
	const accountMappings = parseModelMappings(account.model_mappings);
	if (accountMappings) {
		Object.assign(mappings, accountMappings);
	}

	// Check for legacy mappings in custom_endpoint JSON payload (fallback)
	const customEndpointData = parseCustomEndpointData(account.custom_endpoint);
	if (customEndpointData?.modelMappings) {
		log.warn(
			`Found model mappings in custom_endpoint for account ${account.name} - this is deprecated. Use model_mappings field instead.`,
		);
		Object.assign(mappings, customEndpointData.modelMappings);
	}

	return mappings;
}

/**
 * Get sorted keys for model mappings with caching (for external use)
 * This function provides the cached sorting capability to other providers
 */
export function getSortedMappingKeysForAccount(
	modelMappings: string | null,
): string[] {
	if (!modelMappings) {
		return [];
	}

	const parsedMappings = parseModelMappings(modelMappings);
	if (!parsedMappings) {
		return [];
	}

	return getSortedModelMappingKeys(parsedMappings);
}

/**
 * Map Anthropic model name to provider-specific model name
 */
export function mapModelName(anthropicModel: string, account: Account): string {
	const mappings = getModelMappings(account);

	// First try exact match
	if (mappings[anthropicModel]) {
		if (
			process.env.DEBUG?.includes("model") ||
			process.env.DEBUG === "true" ||
			process.env.NODE_ENV === "development"
		) {
			log.info(
				`Exact model mapping: ${anthropicModel} -> ${mappings[anthropicModel]}`,
			);
		}
		return mappings[anthropicModel];
	}

	// Try partial matches (wildcard-style matching)
	const modelKeys = getSortedModelMappingKeys(mappings); // Use cached sorted keys

	for (const key of modelKeys) {
		if (anthropicModel.includes(key)) {
			if (
				process.env.DEBUG?.includes("model") ||
				process.env.DEBUG === "true" ||
				process.env.NODE_ENV === "development"
			) {
				log.info(
					`Wildcard model mapping: ${anthropicModel} (contains '${key}') -> ${mappings[key]}`,
				);
			}
			return mappings[key];
		}
	}

	// Default pattern matching as fallback
	if (anthropicModel.includes("opus")) {
		const mappedModel = mappings.opus || "openai/gpt-5";
		if (
			process.env.DEBUG?.includes("model") ||
			process.env.DEBUG === "true" ||
			process.env.NODE_ENV === "development"
		) {
			log.info(`Default opus mapping: ${anthropicModel} -> ${mappedModel}`);
		}
		return mappedModel;
	}
	if (anthropicModel.includes("sonnet")) {
		const mappedModel = mappings.sonnet || "openai/gpt-5";
		if (
			process.env.DEBUG?.includes("model") ||
			process.env.DEBUG === "true" ||
			process.env.NODE_ENV === "development"
		) {
			log.info(`Default sonnet mapping: ${anthropicModel} -> ${mappedModel}`);
		}
		return mappedModel;
	}
	if (anthropicModel.includes("haiku")) {
		const mappedModel = mappings.haiku || "openai/gpt-5-mini";
		if (
			process.env.DEBUG?.includes("model") ||
			process.env.DEBUG === "true" ||
			process.env.NODE_ENV === "development"
		) {
			log.info(`Default haiku mapping: ${anthropicModel} -> ${mappedModel}`);
		}
		return mappedModel;
	}

	// Default fallback - use a mid-tier model
	const fallbackModel = mappings.sonnet || "openai/gpt-5";
	if (
		process.env.DEBUG?.includes("model") ||
		process.env.DEBUG === "true" ||
		process.env.NODE_ENV === "development"
	) {
		log.info(`Fallback model mapping: ${anthropicModel} -> ${fallbackModel}`);
	}
	return fallbackModel;
}

/**
 * Get endpoint URL from account, falling back to default
 */
export function getEndpointUrl(account: Account): string {
	const defaultEndpoint = "https://api.openai.com";
	const customEndpointData = parseCustomEndpointData(account.custom_endpoint);

	if (customEndpointData?.endpoint) {
		// Use the parsed endpoint from JSON
		return customEndpointData.endpoint;
	}

	if (
		account.custom_endpoint &&
		!account.custom_endpoint.trim().startsWith("{")
	) {
		// Plain string URL
		return account.custom_endpoint.trim();
	}

	// No custom endpoint - use default
	return defaultEndpoint;
}

/**
 * Create custom endpoint data with endpoint and model mappings
 */
export function createCustomEndpointData(
	endpoint: string,
	modelMappings?: Record<string, string>,
): string {
	const data: { endpoint?: string; modelMappings?: Record<string, string> } = {
		endpoint,
	};

	if (modelMappings && Object.keys(modelMappings).length > 0) {
		data.modelMappings = modelMappings;
	}

	return JSON.stringify(data);
}

/**
 * Validate model mappings for storage
 */
export function validateAndSanitizeModelMappings(
	mappings: unknown,
): Record<string, string> | null {
	if (!mappings) {
		return null;
	}

	try {
		return validateModelMappings(mappings, "modelMappings");
	} catch (error) {
		log.warn(
			`Invalid model mappings: ${error instanceof Error ? error.message : String(error)}`,
		);
		return null;
	}
}
