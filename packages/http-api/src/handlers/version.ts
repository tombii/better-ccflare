import { Logger } from "@better-ccflare/logger";
import {
	errorResponse,
	InternalServerError,
	jsonResponse,
} from "../utils/http-error";

const log = new Logger("VersionHandler");

// Cache the npm registry response to avoid excessive requests
interface VersionCacheEntry {
	version: string;
	timestamp: number;
}

let versionCache: VersionCacheEntry | null = null;
const CACHE_DURATION_MS = 60 * 60 * 1000; // 1 hour

export function createVersionCheckHandler() {
	return async (): Promise<Response> => {
		try {
			// Check cache first
			const now = Date.now();
			if (versionCache && now - versionCache.timestamp < CACHE_DURATION_MS) {
				return jsonResponse({
					version: versionCache.version,
					cached: true,
				});
			}

			// Fetch latest version from npm registry
			const response = await fetch(
				"https://registry.npmjs.org/better-ccflare/latest",
			);

			if (!response.ok) {
				throw new Error(`npm registry returned status ${response.status}`);
			}

			const data = (await response.json()) as { version?: string };

			if (!data.version) {
				throw new Error("Version not found in npm registry response");
			}

			// Update cache
			versionCache = {
				version: data.version,
				timestamp: now,
			};

			return jsonResponse({
				version: data.version,
				cached: false,
			});
		} catch (error) {
			log.error("Failed to check for updates from npm registry:", error);
			const message = error instanceof Error ? error.message : String(error);
			return errorResponse(
				InternalServerError(`Update check failed: ${message}`),
			);
		}
	};
}
