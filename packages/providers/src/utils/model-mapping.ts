import {
	getModelFamily,
	isForceAccountModelEnabled,
	parseModelMappings,
} from "@better-ccflare/core";
import { Logger } from "@better-ccflare/logger";
import type { Account } from "@better-ccflare/types";
import { readRequestJson } from "./request-json";

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
 * Optimized for performance: O(1) exact match + O(k) pattern matching where k is the number of known patterns
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
	// Sibling of core's mapModelName, and it needs the same guard: with "force
	// account model" on, no mapping may rename the request. Missing it here
	// would leave exactly one provider (vertex-ai, the only caller) still
	// rewriting models while the setting promises nothing does.
	if (isForceAccountModelEnabled()) return anthropicModel;

	if (!anthropicModel || !account?.model_mappings) {
		return anthropicModel;
	}

	const accountMappings = parseModelMappings(account.model_mappings);
	if (!accountMappings) {
		return anthropicModel;
	}

	const toFirst = (v: string | string[]) => (Array.isArray(v) ? v[0] : v);

	// First try exact match
	if (accountMappings[anthropicModel]) {
		const mappedModel = toFirst(accountMappings[anthropicModel]);
		log.debug(`Exact model mapping: ${anthropicModel} -> ${mappedModel}`);
		return mappedModel;
	}

	// Use shared pattern detection
	const family = getModelFamily(anthropicModel);
	if (family && accountMappings[family]) {
		const mappedModel = toFirst(accountMappings[family]);
		log.debug(
			`Pattern model mapping: ${anthropicModel} (${family}) -> ${mappedModel}`,
		);
		return mappedModel;
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
		// Not `request.clone().json()` — that leaks the whole body on Bun 1.3.x
		// (#382); see readRequestJson.
		const body = await readRequestJson<T>(request);
		let bodyChanged = false;

		// Codex-only passthrough metadata; strip it in case failover ever
		// routes here so it doesn't reach a non-Codex upstream unrecognized.
		if (
			"__better_ccflare_codex_passthrough" in (body as Record<string, unknown>)
		) {
			delete (body as Record<string, unknown>)
				.__better_ccflare_codex_passthrough;
			bodyChanged = true;
		}

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

			if (mappedModel !== originalModel) {
				body.model = mappedModel;
				log.debug(
					`Mapped model in request: ${originalModel} -> ${mappedModel}`,
				);
				bodyChanged = true;
			}
		}

		if (bodyChanged) {
			// Create new request with transformed body.
			// Rebuilding from `request.url` (a string) does not inherit the
			// signal, so it is carried over explicitly — otherwise a client
			// disconnect can no longer abort the upstream fetch for every
			// account that has a model mapping.
			return new Request(request.url, {
				method: request.method,
				headers: request.headers,
				body: JSON.stringify(body),
				signal: request.signal,
			});
		}

		return request;
	} catch (error) {
		log.debug("Failed to transform request body model:", error);
		return request;
	}
}

/**
 * Optimized model transformation for providers that need to force all models to a specific one
 * Uses direct body object mutation for better performance while creating a new Request object
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
		// Not `request.clone().json()` — see readRequestJson (#382).
		const body = await readRequestJson<Record<string, unknown> | null>(request);

		// Direct body mutation for performance - avoids object spreading overhead
		if (body && typeof body === "object" && body.model) {
			body.model = targetModel;
			log.debug(`Forced model mapping to: ${targetModel}`);

			// Create new request with mutated body.
			// Carry the signal over: a URL-based rebuild drops it, which would
			// detach the client disconnect from the upstream fetch.
			const transformedRequest = new Request(request.url, {
				method: request.method,
				headers: request.headers,
				body: JSON.stringify(body),
				signal: request.signal,
			});

			return transformedRequest;
		}

		return request;
	} catch (error) {
		log.debug("Failed to force model mapping:", error);
		return request;
	}
}
