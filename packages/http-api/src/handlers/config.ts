import type { Config } from "@claudeflare/config";
import { isValidStrategy, STRATEGIES } from "@claudeflare/core";
import type { ConfigResponse, StrategyUpdateRequest } from "../types";

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
				port: (settings.port as number) || 8080,
				sessionDurationMs: (settings.sessionDurationMs as number) || 3600000,
			};
			return new Response(JSON.stringify(response), {
				headers: { "Content-Type": "application/json" },
			});
		},

		/**
		 * Get current strategy
		 */
		getStrategy: (): Response => {
			const strategy = config.getStrategy();
			return new Response(JSON.stringify({ strategy }), {
				headers: { "Content-Type": "application/json" },
			});
		},

		/**
		 * Update strategy
		 */
		setStrategy: async (req: Request): Promise<Response> => {
			try {
				const body = (await req.json()) as StrategyUpdateRequest;
				const { strategy } = body;

				if (!strategy || !isValidStrategy(strategy)) {
					return new Response(JSON.stringify({ error: "Invalid strategy" }), {
						status: 400,
						headers: { "Content-Type": "application/json" },
					});
				}

				config.setStrategy(strategy);

				return new Response(JSON.stringify({ success: true, strategy }), {
					headers: { "Content-Type": "application/json" },
				});
			} catch (_error) {
				return new Response(
					JSON.stringify({ error: "Failed to update strategy" }),
					{
						status: 500,
						headers: { "Content-Type": "application/json" },
					},
				);
			}
		},

		/**
		 * Get available strategies
		 */
		getStrategies: (): Response => {
			return new Response(JSON.stringify(STRATEGIES), {
				headers: { "Content-Type": "application/json" },
			});
		},
	};
}
