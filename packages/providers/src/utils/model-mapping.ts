import { KNOWN_PATTERNS, parseModelMappings } from "@better-ccflare/core";
import { Logger } from "@better-ccflare/logger";
import type { Account } from "@better-ccflare/types";

const log = new Logger("ModelMappingUtils");

// Enhanced TypeScript interfaces for type safety
export interface ProviderAccount extends Account {
	mode?: string;
}

export interface TransformRequestBody {
	model?: string;
	messages?: Array<{
		role: string;
		content: string | Array<{ type: string; text: string }>;
	}>;
	max_tokens?: number;
	temperature?: number;
	top_p?: number;
	top_k?: number;
	stop_sequences?: string[] | null;
	stream?: boolean;
	tools?: Array<{
		name: string;
		description: string;
		input_schema: Record<string, unknown>;
	}>;
	tool_choice?: {
		type: string;
		name?: string;
	} | null;
	system?: string;
	// Add other common fields as needed
}

/**
 * Standardized model mapping utility for all providers
 * Ensures consistent behavior across different provider implementations
 *
 * @param anthropicModel - The original Anthropic model name
 * @param account - The account containing model_mappings configuration
 * @returns The mapped model name or the original if no mapping exists
 *
 * @example
 * const mapped = getModelName("claude-sonnet-4-5", account);
 * // Returns "custom-sonnet" if account has mapping: {"claude-sonnet-4-5": "custom-sonnet"}
 */
export function getModelName(
	anthropicModel: string,
	account: Account | undefined,
): string {
	if (!anthropicModel || !account?.model_mappings) {
		return anthropicModel;
	}

	const accountMappings = parseModelMappings(account.model_mappings);
	if (!accountMappings) {
		return anthropicModel;
	}

	// First try exact match
	if (accountMappings[anthropicModel]) {
		const mappedModel = accountMappings[anthropicModel];
		log.debug(`Exact model mapping: ${anthropicModel} -> ${mappedModel}`);
		return mappedModel;
	}

	// Try pattern matching for known model families
	const normalizedModel = anthropicModel.toLowerCase();

	for (const pattern of KNOWN_PATTERNS) {
		if (normalizedModel.includes(pattern) && accountMappings[pattern]) {
			const mappedModel = accountMappings[pattern];
			log.debug(
				`Pattern model mapping: ${anthropicModel} (${pattern}) -> ${mappedModel}`,
			);
			return mappedModel;
		}
	}

	// No mapping found, return original
	return anthropicModel;
}

/**
 * Generic model transformation function that can be used by all providers
 * Handles the common pattern of transforming request body models
 *
 * @param request - The incoming request object to transform
 * @param account - The account containing model_mappings configuration
 * @param providerSpecificMapping - Optional provider-specific mapping function
 * @returns A new Request object with transformed body, or the original if no changes needed
 *
 * @example
 * const transformed = await transformRequestBodyModel(request, account);
 * // Transforms the request body model based on account mappings
 */
export async function transformRequestBodyModel<T extends TransformRequestBody>(
	request: Request,
	account?: Account | undefined,
	providerSpecificMapping?: (model: string, account?: Account) => string,
): Promise<Request> {
	try {
		const clonedRequest = request.clone();
		const body: T = await clonedRequest.json();

		// Only transform if model field exists
		if (body.model) {
			const originalModel = body.model;
			let mappedModel = originalModel;

			// Use provider-specific mapping if provided, otherwise use standard mapping
			if (providerSpecificMapping) {
				mappedModel = providerSpecificMapping(originalModel, account);
			} else {
				mappedModel = getModelName(originalModel, account);
			}

			// Only create new request if model actually changed
			if (mappedModel !== originalModel) {
				body.model = mappedModel;
				log.debug(
					`Mapped model in request: ${originalModel} -> ${mappedModel}`,
				);

				// Create new request with transformed body
				const transformedRequest = new Request(request.url, {
					method: request.method,
					headers: request.headers,
					body: JSON.stringify(body),
				});

				return transformedRequest;
			}
		}

		return request;
	} catch (error) {
		log.debug("Failed to transform request body model:", error);
		return request;
	}
}

/**
 * Optimized model transformation for providers that need to force all models to a specific one
 * Uses direct object mutation instead of creating new objects for better performance
 *
 * @param request - The incoming request object to transform
 * @param targetModel - The target model name to force all requests to
 * @returns A new Request object with the model forced to targetModel, or the original if no changes needed
 *
 * @example
 * const transformed = await transformRequestBodyModelForce(request, "MiniMax-M2");
 * // Forces all models in the request to "MiniMax-M2"
 */
export async function transformRequestBodyModelForce(
	request: Request,
	targetModel: string,
): Promise<Request> {
	try {
		const clonedRequest = request.clone();
		const body = await clonedRequest.json();

		// Direct mutation for performance - avoid creating new objects
		if (body && typeof body === "object" && body.model) {
			body.model = targetModel;
			log.debug(`Forced model mapping to: ${targetModel}`);

			// Create new request with mutated body
			const transformedRequest = new Request(request.url, {
				method: request.method,
				headers: request.headers,
				body: JSON.stringify(body),
			});

			return transformedRequest;
		}

		return request;
	} catch (error) {
		log.debug("Failed to force model mapping:", error);
		return request;
	}
}
