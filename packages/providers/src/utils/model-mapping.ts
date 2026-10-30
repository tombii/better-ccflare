import {
	getModelFamily,
	isForceAccountModelEnabled,
	type ModelRouting,
	parseModelMappings,
	providerSupportsProviderRouting,
	splitModelRouting,
	stripModelRouting,
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
	/** OpenRouter/NanoGPT upstream routing (from the model string suffix). */
	provider?: ModelRouting | unknown;
	// Add other common fields as needed
}

/**
 * How a routing suffix reaches the upstream for the account being served.
 * - "routing-provider": the provider accepts a `provider` object — forward it.
 * - "forward": the provider is unknown (no account) or its adapter opted this
 *   transform into forwarding without a known capability — forward it.
 * - "optional": the provider neither declares nor rejects routing — forwarded,
 *   as today's bodies already are, because ccflare cannot know which
 *   openai-compatible upstream honours `provider`.
 * - "unsupported": the provider is known not to accept `provider` — strip the
 *   suffix and warn instead of sending it.
 */
export type ProviderRoutingMode =
	| "routing-provider"
	| "forward"
	| "optional"
	| "unsupported";

/** Options the calling provider passes about its own routing capability. */
export interface ProviderRoutingOptions {
	/**
	 * Static capability from the provider adapter's own config. When set it
	 * takes precedence over the account-provider lookup below, so a provider
	 * that knows its upstream can opt in or out per adapter. When unset, core's
	 * providerSupportsProviderRouting answers for the account's provider.
	 */
	providerRouting?: boolean;
	/**
	 * Adapter hook (e.g. BaseAnthropicCompatibleProvider.supportsProviderRoutingFor),
	 * consulted only when the flag above is unset. Its answer is final: an
	 * adapter that knows its target host decides, and `false` means strip.
	 */
	supportsProviderRouting?: () => boolean;
}

export function resolveProviderRoutingMode(
	account: Account | undefined,
	options: ProviderRoutingOptions | undefined,
): ProviderRoutingMode {
	if (options?.providerRouting === true) return "routing-provider";
	if (options?.providerRouting === false) return "unsupported";
	if (options?.supportsProviderRouting?.()) return "routing-provider";
	if (options?.supportsProviderRouting) return "unsupported";
	if (!account) return "forward";
	// Single capability list lives in core.
	if (providerSupportsProviderRouting(account.provider))
		return "routing-provider";
	// Anthropic-shaped APIs reject an unknown `provider` field outright.
	if (
		account.provider === "anthropic" ||
		account.provider === "claude-console-api"
	)
		return "unsupported";
	return "optional";
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
	if (isForceAccountModelEnabled()) return stripModelRouting(anthropicModel);

	if (!anthropicModel || !account?.model_mappings) {
		return stripModelRouting(anthropicModel);
	}

	const lookupModel = stripModelRouting(anthropicModel);

	const accountMappings = parseModelMappings(account.model_mappings);
	if (!accountMappings) {
		return lookupModel;
	}

	const toFirst = (v: string | string[]) => (Array.isArray(v) ? v[0] : v);

	// First try exact match
	if (accountMappings[lookupModel]) {
		const mappedModel = toFirst(accountMappings[lookupModel]);
		log.debug(`Exact model mapping: ${lookupModel} -> ${mappedModel}`);
		return mappedModel;
	}

	// Use shared pattern detection
	const family = getModelFamily(lookupModel);
	if (family && accountMappings[family]) {
		const mappedModel = toFirst(accountMappings[family]);
		log.debug(
			`Pattern model mapping: ${lookupModel} (${family}) -> ${mappedModel}`,
		);
		return mappedModel;
	}

	// No mapping found, return original (routing suffix stripped — the caller
	// that understands routing re-attaches it)
	return lookupModel;
}

/**
 * Put a routing object on the outgoing body as `provider`, or drop it.
 *
 * The explicit routing suffix always wins over a `provider` field the client
 * sent: the suffix is the operator's configuration in ccflare, the body field
 * is whatever the caller put in the request, and letting the caller override
 * configured routing would let it pin an upstream the operator excluded.
 *
 * On a provider that is known not to understand `provider` the routing is NOT
 * sent: silently sending it only earns an upstream 400. The model has already
 * been stripped, and one warning per request records that it was dropped. The
 * caller's own `provider` field is NOT kept either: the suffix took over
 * routing for this request, and a client pin must not override that decision
 * (see dropClientProvider in transformRequestBodyModel).
 *
 * @returns "applied" when body.provider was changed, "unchanged" when the body
 *   already carried exactly this object, "dropped" when the routing could not
 *   be sent.
 */
function applyProviderRouting(
	body: Record<string, unknown>,
	routing: ModelRouting,
	model: string,
	account: Account | undefined,
	options: ProviderRoutingOptions | undefined,
): "applied" | "unchanged" | "dropped" {
	const mode = resolveProviderRoutingMode(account, options);
	if (mode === "unsupported") {
		log.warn(
			`Model "${model}" has a provider routing suffix, but provider "${account?.provider}" does not support provider routing; the routing was ignored`,
		);
		return "dropped";
	}

	const existing = body.provider;
	if (JSON.stringify(existing) === JSON.stringify(routing)) return "unchanged";
	if (existing !== undefined) {
		log.debug(
			`Provider routing suffix overrides body.provider for model "${model}": ${JSON.stringify(existing)} -> ${JSON.stringify(routing)}`,
		);
	}
	body.provider = routing;
	return "applied";
}

/**
 * Remove a client-supplied `provider` field. Used once the routing suffix has
 * taken control of routing for this request (applied or deliberately dropped);
 * the caller's field must not survive that decision.
 * @returns true when a field was removed
 */
function dropClientProvider(body: Record<string, unknown>): boolean {
	if (body.provider === undefined) return false;
	log.debug("Dropping client-supplied provider field: request routing is set");
	delete body.provider;
	return true;
}

/**
 * Generic model transformation function that can be used by all providers
 * Handles the common pattern of transforming request body models
 *
 * A model string may carry a trailing routing suffix (`model {"only":[...]}`,
 * see core's model-routing). The suffix is split off first, because mapping
 * keys never contain it; the mapped name's own suffix (if the mapping value
 * has one) wins over the request's, since it names the upstream that actually
 * serves that model. The resulting routing is forwarded as `body.provider` for
 * providers that accept it.
 *
 * @param request - The incoming request object to transform
 * @param account - The account containing model_mappings configuration
 * @param providerSpecificMapping - Optional provider-specific mapping function
 * @param options - The calling provider's own routing capability (adapter
 *   config flag / hook). Precedence: adapter flag, then the account provider
 *   via core's providerSupportsProviderRouting, then a conservative fallback
 *   (forward when unknown or not known to reject it; drop for Anthropic-shaped
 *   providers that reject unknown body fields).
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
	options?: ProviderRoutingOptions,
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
			const { model: bareModel, routing: requestRouting } =
				splitModelRouting(originalModel);

			// Strip before mapping: mapping keys never carry the suffix.
			// Use provider-specific mapping if provided, otherwise use standard mapping
			const mapped = providerSpecificMapping
				? providerSpecificMapping(bareModel, account)
				: getModelName(bareModel, account);
			const mappedSplit = splitModelRouting(mapped || bareModel);
			// A suffix existed on the request or on the mapping value.
			const suffixSeen =
				requestRouting !== null || mappedSplit.model !== (mapped || bareModel);
			// The mapping value's own suffix (if any) names the upstream for the
			// mapped model and wins; otherwise the request's routing carries over.
			const routing = mappedSplit.routing ?? requestRouting;
			const mappedModel = mappedSplit.model;

			if (mappedModel !== originalModel) {
				log.debug(
					`Mapped model in request: ${originalModel} -> ${mappedModel}`,
				);
				bodyChanged = true;
			}
			// Always assign: the suffix, if any, must not survive in the model.
			body.model = mappedModel;
			if (routing) {
				const outcome = applyProviderRouting(
					body as Record<string, unknown>,
					routing,
					mappedModel,
					account,
					options,
				);
				if (outcome === "applied") {
					bodyChanged = true;
				} else if (outcome === "dropped") {
					// A suffix was configured but no routing was applied (the
					// mapping value's suffix sanitised to nothing, or the provider
					// cannot route). The model was still rewritten/annotated by this
					// feature, so the client's own `provider` must not ride along: it
					// is exactly what the operator configured routing to control.
					bodyChanged =
						dropClientProvider(body as Record<string, unknown>) || bodyChanged;
				}
			} else if (
				suffixSeen &&
				(body as Record<string, unknown>).provider !== undefined
			) {
				// A routing suffix was present (on the request or the mapped value)
				// but nothing usable came of it; same rule.
				bodyChanged =
					dropClientProvider(body as Record<string, unknown>) || bodyChanged;
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
