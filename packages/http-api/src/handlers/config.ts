import {
	type Config,
	filterEnabledProviderModelDefaultOverrides,
	PROVIDER_MODEL_DEFAULTS_ENV_VAR,
} from "@better-ccflare/config";
import {
	DEFAULT_AGENT_MODEL,
	KNOWN_PATTERNS,
	NETWORK,
	STRATEGIES,
	type StrategyName,
	TIME_CONSTANTS,
	validateNumber,
	validateString,
} from "@better-ccflare/core";
import {
	BadRequest,
	errorResponse,
	jsonResponse,
} from "@better-ccflare/http-common";
import {
	getProviderModelDefaultFactories,
	getProviderModelDefaultOverrides,
	setProviderModelDefaultOverrides,
} from "@better-ccflare/providers";
import type { APIContext } from "@better-ccflare/types";
import {
	allowedModelErrorMessage,
	isAllowedModel,
} from "../services/model-validation";
import type { ConfigResponse, RetentionSetRequest } from "../types";

/**
 * Create config handlers
 */
export function createConfigHandlers(
	config: Config,
	runtime?: { port: number; tlsEnabled: boolean },
	modelCatalog?: APIContext["modelCatalog"],
) {
	return {
		/**
		 * Get all configuration settings
		 */
		getConfig: (): Response => {
			const settings = config.getAllSettings();
			const response: ConfigResponse = {
				lb_strategy: (settings.lb_strategy as string) || "round_robin",
				// Use actual running port from runtime, fall back to config
				port:
					runtime?.port || (settings.port as number) || NETWORK.DEFAULT_PORT,
				// Use Anthropic fallback as default since it's the only provider that uses session duration tracking
				// Non-Anthropic providers don't use fixed-duration sessions but still need a default value
				sessionDurationMs:
					(settings.sessionDurationMs as number) ||
					TIME_CONSTANTS.ANTHROPIC_SESSION_DURATION_FALLBACK,
				default_agent_model:
					(settings.default_agent_model as string) || DEFAULT_AGENT_MODEL,
				// Include actual TLS status
				tls_enabled: runtime?.tlsEnabled || false,
				system_prompt_cache_ttl_1h: config.getSystemPromptCacheTtl1h(),
				usage_throttling_five_hour_enabled:
					config.getUsageThrottlingFiveHourEnabled(),
				usage_throttling_weekly_enabled:
					config.getUsageThrottlingWeeklyEnabled(),
			};
			return jsonResponse(response);
		},

		/**
		 * Get current strategy
		 */
		getStrategy: (): Response => {
			const strategy = config.getStrategy();
			// strategySource mirrors the model-capacity-routing source field so
			// the dashboard can lock the strategy control the same way when
			// LB_STRATEGY overrides the config file. Additive field: existing
			// consumers of `strategy` are unaffected.
			return jsonResponse({
				strategy,
				strategySource: config.getStrategySource(),
			});
		},

		/**
		 * Update strategy
		 */
		setStrategy: async (req: Request): Promise<Response> => {
			const body = await req.json();

			// Validate strategy input
			const strategyValidation = validateString(body.strategy, "strategy", {
				required: true,
				allowedValues: STRATEGIES,
			});

			if (!strategyValidation) {
				return errorResponse(BadRequest("Strategy is required"));
			}

			const strategy = strategyValidation as StrategyName;
			config.setStrategy(strategy);

			return jsonResponse({ success: true, strategy });
		},

		/**
		 * Get available strategies
		 */
		getStrategies: (): Response => {
			return jsonResponse(STRATEGIES);
		},

		/**
		 * Get default agent model
		 */
		getDefaultAgentModel: (): Response => {
			const model = config.getDefaultAgentModel();
			return jsonResponse({ model });
		},

		/**
		 * Set default agent model
		 */
		setDefaultAgentModel: async (req: Request): Promise<Response> => {
			const body = await req.json();

			// Validate model input
			const modelValidation = validateString(body.model, "model", {
				required: true,
			});

			if (!modelValidation) {
				return errorResponse(BadRequest("Model is required"));
			}

			// Validate model is in allowed list (parity with agent preference
			// validation in agents.ts).
			if (!(await isAllowedModel(modelValidation, modelCatalog))) {
				return errorResponse(
					BadRequest(`Invalid model. ${allowedModelErrorMessage()}`),
				);
			}

			config.setDefaultAgentModel(modelValidation);

			return jsonResponse({ success: true, model: modelValidation });
		},

		/**
		 * Get current data retention in days
		 */
		getRetention: (): Response => {
			return jsonResponse({
				payloadDays: config.getDataRetentionDays(),
				requestDays: config.getRequestRetentionDays(),
				storePayloads: config.getStorePayloads(),
			});
		},

		/**
		 * Set data retention in days
		 */
		setRetention: async (req: Request): Promise<Response> => {
			const body = (await req.json()) as RetentionSetRequest;
			let updated = false;
			if (body.payloadDays !== undefined) {
				const payloadDays = validateNumber(body.payloadDays, "payloadDays", {
					min: 1,
					max: 365,
					integer: true,
				});
				if (typeof payloadDays !== "number") {
					return errorResponse(BadRequest("Invalid 'payloadDays'"));
				}
				config.setDataRetentionDays(payloadDays);
				updated = true;
			}
			if (body.requestDays !== undefined) {
				const requestDays = validateNumber(body.requestDays, "requestDays", {
					min: 1,
					max: 3650,
					integer: true,
				});
				if (typeof requestDays !== "number") {
					return errorResponse(BadRequest("Invalid 'requestDays'"));
				}
				config.setRequestRetentionDays(requestDays);
				updated = true;
			}
			if (body.storePayloads !== undefined) {
				if (typeof body.storePayloads !== "boolean") {
					return errorResponse(
						BadRequest("Invalid 'storePayloads': must be boolean"),
					);
				}
				config.setStorePayloads(body.storePayloads);
				updated = true;
			}
			if (!updated) {
				return errorResponse(BadRequest("No retention fields provided"));
			}
			return new Response(null, { status: 204 });
		},

		getCacheKeepaliveTtl: (): Response => {
			return jsonResponse({ ttlMinutes: config.getCacheKeepaliveTtlMinutes() });
		},

		setCacheKeepaliveTtl: async (req: Request): Promise<Response> => {
			const body = await req.json();
			const ttlMinutes = validateNumber(body.ttlMinutes, "ttlMinutes", {
				min: 0,
				max: 60,
				integer: true,
			});
			if (typeof ttlMinutes !== "number") {
				return errorResponse(BadRequest("Invalid 'ttlMinutes': must be 0-60"));
			}
			config.setCacheKeepaliveTtlMinutes(ttlMinutes);
			return new Response(null, { status: 204 });
		},

		getCacheTtl: (): Response => {
			return jsonResponse({
				system_prompt_cache_ttl_1h: config.getSystemPromptCacheTtl1h(),
			});
		},

		setCacheTtl: async (req: Request): Promise<Response> => {
			const body = await req.json();
			if (typeof body.enabled !== "boolean") {
				return errorResponse(BadRequest("Invalid 'enabled': must be boolean"));
			}
			config.setSystemPromptCacheTtl1h(body.enabled);
			return new Response(null, { status: 204 });
		},

		getUsageThrottling: (): Response => {
			return jsonResponse({
				fiveHourEnabled: config.getUsageThrottlingFiveHourEnabled(),
				weeklyEnabled: config.getUsageThrottlingWeeklyEnabled(),
			});
		},

		setUsageThrottling: async (req: Request): Promise<Response> => {
			const body = await req.json();
			if (
				typeof body.fiveHourEnabled !== "boolean" ||
				typeof body.weeklyEnabled !== "boolean"
			) {
				return errorResponse(
					BadRequest(
						"Invalid usage throttling payload: expected boolean 'fiveHourEnabled' and 'weeklyEnabled'",
					),
				);
			}
			config.setUsageThrottlingFiveHourEnabled(body.fiveHourEnabled);
			config.setUsageThrottlingWeeklyEnabled(body.weeklyEnabled);
			return new Response(null, { status: 204 });
		},

		getProviderModelDefaults: (): Response => {
			const enabledProviders = new Set(
				config.getEnabledProviderModelDefaultProviders(),
			);
			const factories = getProviderModelDefaultFactories();
			const overrides = config.getProviderModelDefaultOverrides();
			return jsonResponse({
				providers: Object.entries(factories)
					.filter(([provider]) => enabledProviders.has(provider))
					.map(([provider, families]) => ({
						provider,
						fields: Object.entries(families).map(([family, factory]) => ({
							family,
							factory,
							override: overrides[provider]?.[family] ?? null,
							effective:
								getProviderModelDefaultOverrides()[provider]?.[family] ??
								factory,
						})),
					})),
			});
		},

		setProviderModelDefaults: async (req: Request): Promise<Response> => {
			let body: unknown;
			try {
				body = await req.json();
			} catch {
				return errorResponse(BadRequest("Body must be JSON"));
			}
			const entries = (body as { overrides?: unknown } | null)?.overrides;
			if (!Array.isArray(entries)) {
				return errorResponse(
					BadRequest(
						"Invalid provider model defaults payload: expected 'overrides' array",
					),
				);
			}
			const factories = getProviderModelDefaultFactories();
			const enabledProviders = new Set(
				config.getEnabledProviderModelDefaultProviders(),
			);
			// What may be configured is not a function of what has been
			// discovered. A provider whose defaults come from a live listing has
			// no compiled map, so validating against one would reject the manual
			// override exactly when it is needed: before the first successful
			// listing, or after one stops answering.
			const knownFamilies = new Set<string>(KNOWN_PATTERNS);
			const next = config.getProviderModelDefaultOverrides();
			for (const entry of entries) {
				const value = entry as {
					provider?: unknown;
					family?: unknown;
					model?: unknown;
				} | null;
				const provider =
					typeof value?.provider === "string" ? value.provider.trim() : "";
				const family =
					typeof value?.family === "string" ? value.family.trim() : "";
				if (!provider)
					return errorResponse(BadRequest("Unknown provider: (empty)"));
				if (!enabledProviders.has(provider))
					return errorResponse(
						BadRequest(
							`Provider "${provider}" is not editable; set ${PROVIDER_MODEL_DEFAULTS_ENV_VAR} to enable it`,
						),
					);
				// A family this provider already maps is obviously valid; one it does
				// not is still valid if ccflare knows the family at all, because the
				// map may simply not have been read yet.
				if (!factories[provider]?.[family] && !knownFamilies.has(family))
					return errorResponse(
						BadRequest(
							`Unknown family '${family || "(empty)"}' for provider '${provider}'`,
						),
					);
				if (typeof value?.model !== "string")
					return errorResponse(BadRequest("model must be a string"));
				const model = value.model.trim();
				if (model) {
					next[provider] = { ...next[provider], [family]: model };
				} else if (next[provider]) {
					delete next[provider][family];
					if (Object.keys(next[provider]).length === 0) delete next[provider];
				}
			}
			config.setProviderModelDefaultOverrides(next);
			setProviderModelDefaultOverrides(
				filterEnabledProviderModelDefaultOverrides(enabledProviders, next),
			);
			return jsonResponse({
				providers: Object.entries(factories)
					.filter(([provider]) => enabledProviders.has(provider))
					.map(([provider, families]) => ({
						provider,
						fields: Object.entries(families).map(([family, factory]) => ({
							family,
							factory,
							override: next[provider]?.[family] ?? null,
							effective:
								getProviderModelDefaultOverrides()[provider]?.[family] ??
								factory,
						})),
					})),
			});
		},

		getModelCapacityRouting: (): Response => {
			return jsonResponse({
				mode: config.getModelScopedCapacityRouting(),
				source: config.getModelScopedCapacityRoutingSource(),
			});
		},

		setModelCapacityRouting: async (req: Request): Promise<Response> => {
			const body = await req.json();
			if (body.mode !== "off" && body.mode !== "exhausted") {
				return errorResponse(
					BadRequest(
						"Invalid model capacity routing payload: expected 'mode' to be 'off' or 'exhausted'",
					),
				);
			}
			config.setModelScopedCapacityRouting(body.mode);
			// Report the post-set EFFECTIVE mode/source: a MODEL_SCOPED_CAPACITY_ROUTING
			// env var still overrides the file we just wrote, so `effective` may differ
			// from the requested `mode`. The dashboard uses this to warn that the write
			// was ineffective while env-locked.
			return jsonResponse({
				success: true,
				mode: body.mode,
				source: config.getModelScopedCapacityRoutingSource(),
				effective: config.getModelScopedCapacityRouting(),
			});
		},
	};
}
