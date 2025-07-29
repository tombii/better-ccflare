import type { Config } from "@claudeflare/config";
import {
	NETWORK,
	STRATEGIES,
	type StrategyName,
	TIME_CONSTANTS,
	validateString,
} from "@claudeflare/core";
import { jsonResponse } from "@claudeflare/http-common";
import type { ConfigResponse } from "../types";

/**
 * Create config handlers
 */
export function createConfigHandlers(config: Config) {
	return {
		/**
		 * Get all configuration settings
		 */
		getConfig: (): Response => {
			const settings = config.getAllSettings();
			const response: ConfigResponse = {
				lb_strategy: (settings.lb_strategy as string) || "round_robin",
				port: (settings.port as number) || NETWORK.DEFAULT_PORT,
				sessionDurationMs:
					(settings.sessionDurationMs as number) ||
					TIME_CONSTANTS.SESSION_DURATION_FALLBACK,
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
			const strategy = validateString(body.strategy, "strategy", {
				required: true,
				allowedValues: STRATEGIES,
			})! as StrategyName;

			config.setStrategy(strategy);

			return jsonResponse({ success: true, strategy });
		},

		/**
		 * Get available strategies
		 */
		getStrategies: (): Response => {
			return jsonResponse(STRATEGIES);
		},
	};
}
