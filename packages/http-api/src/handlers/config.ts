import type { Config } from "@better-ccflare/config";
import {
	DEFAULT_AGENT_MODEL,
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
import type { ConfigResponse, RetentionSetRequest } from "../types";

/**
 * Create config handlers
 */
export function createConfigHandlers(
	config: Config,
	runtime?: { port: number; tlsEnabled: boolean },
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
				sessionDurationMs:
					(settings.sessionDurationMs as number) ||
					TIME_CONSTANTS.SESSION_DURATION_FALLBACK,
				default_agent_model:
					(settings.default_agent_model as string) || DEFAULT_AGENT_MODEL,
				// Include actual TLS status
				tls_enabled: runtime?.tlsEnabled || false,
			};
			return jsonResponse(response);
		},

		/**
		 * Get current strategy
		 */
		getStrategy: (): Response => {
			const strategy = config.getStrategy();
			return jsonResponse({ strategy });
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
			if (!updated) {
				return errorResponse(BadRequest("No retention fields provided"));
			}
			return new Response(null, { status: 204 });
		},
	};
}
