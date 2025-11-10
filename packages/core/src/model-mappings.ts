import { Logger } from "@better-ccflare/logger";
import type { Account } from "@better-ccflare/types";
import { safeJsonParse, validateModelMappings } from "./validation";

const log = new Logger("ModelMappings");

// Inline types to avoid Bun import issues
// Types are now defined in index.ts and exported from there

// Known model family patterns for O(1) direct matching
// Pattern order: Check "opus" before "haiku" before "sonnet" to avoid substring collisions
// in edge cases like "claude-opus-haiku-test" (though we would never see this pattern from the client)
export const KNOWN_PATTERNS = ["opus", "haiku", "sonnet"] as const;

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
 * Map Anthropic model name to provider-specific model name
 * Optimized for known model patterns with direct matching (O(1) vs O(n log n))
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

	// Direct pattern matching for known model families (O(1) constant time)
	// Use KNOWN_PATTERNS to ensure consistent order and avoid magic strings
	const normalizedModel = anthropicModel.toLowerCase();

	for (const pattern of KNOWN_PATTERNS) {
		if (normalizedModel.includes(pattern)) {
			const defaultModels = {
				opus: "openai/gpt-5",
				haiku: "openai/gpt-5-mini",
				sonnet: "openai/gpt-5",
			};
			const mappedModel = mappings[pattern] || defaultModels[pattern];

			if (
				process.env.DEBUG?.includes("model") ||
				process.env.DEBUG === "true" ||
				process.env.NODE_ENV === "development"
			) {
				log.info(
					`${pattern.charAt(0).toUpperCase() + pattern.slice(1)} model mapping: ${anthropicModel} -> ${mappedModel}`,
				);
			}
			return mappedModel;
		}
	}

	// Default fallback - use sonnet as the mid-tier default
	const fallbackModel = mappings.sonnet || DEFAULT_MODEL_MAPPINGS.sonnet;
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
