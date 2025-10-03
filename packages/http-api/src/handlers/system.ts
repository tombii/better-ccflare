import { errorResponse, jsonResponse } from "../utils/http-error";

export function createSystemInfoHandler() {
	return async (): Promise<Response> => {
		try {
			// Try to detect package manager by checking environment
			let packageManager = "npm"; // default fallback

			// Check if running under bun
			if (process.versions.bun) {
				packageManager = "bun";
			} else if (process.env.npm_config_user_agent?.includes("bun")) {
				packageManager = "bun";
			}

			// Additional detection could be added here

			const systemInfo = {
				packageManager,
				nodeVersion: process.version,
				bunVersion: process.versions.bun || null,
				platform: process.platform,
				arch: process.arch,
				timestamp: new Date().toISOString(),
			};

			return jsonResponse(systemInfo);
		} catch (_error) {
			return errorResponse(
				"Failed to get system information",
				"INTERNAL_SERVER_ERROR",
			);
		}
	};
}
