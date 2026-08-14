import type { Config } from "@better-ccflare/config";
import { jsonResponse } from "../utils/http-error";

/**
 * Handler for feature flags surfaced to the dashboard.
 *
 * `showCombos` now follows the combos setting rather than reading
 * BETTER_CCFLARE_SHOW_COMBOS directly. The env var still wins (see
 * Config#getCombosEnabled), so nothing changes for anyone who set it — but the
 * tab's visibility and combo routing can no longer disagree, which they did
 * before: the flag only ever hid the tab while the proxy kept routing on
 * whatever the database held.
 */
export function createFeaturesHandler(config: Config) {
	return async (): Promise<Response> => {
		const features = {
			showCombos: config.getCombosEnabled(),
		};

		return jsonResponse({
			success: true,
			data: features,
		});
	};
}
