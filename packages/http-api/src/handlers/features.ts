import { jsonResponse } from "../utils/http-error";

/**
 * Handler for feature flags controlled by environment variables
 */
export function createFeaturesHandler() {
	return async (): Promise<Response> => {
		const features = {
			showCombos: process.env.BETTER_CCFLARE_SHOW_COMBOS === "true",
		};

		return jsonResponse({
			success: true,
			data: features,
		});
	};
}
