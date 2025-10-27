import { copyFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { getPlatformConfigDir } from "@better-ccflare/config";

export function resolveDbPath(): string {
	// Check for explicit DB path from environment (support both old and new env var names)
	const explicitPath =
		process.env.BETTER_CCFLARE_DB_PATH || process.env.ccflare_DB_PATH;
	if (explicitPath) {
		return explicitPath;
	}

	const configDir = getPlatformConfigDir();

	// For development environment, use a separate database
	if (process.env.NODE_ENV === "development" || process.env.DEV === "true") {
		const devPath = join(configDir, "better-ccflare-dev.db");
		const prodPath = join(configDir, "better-ccflare.db");

		// If dev database doesn't exist but production does, copy it
		if (!existsSync(devPath) && existsSync(prodPath)) {
			try {
				copyFileSync(prodPath, devPath);
				console.log(`🔄 Copied production database to development: ${devPath}`);
			} catch (error) {
				console.warn(`⚠️  Failed to copy production database to dev:`, error);
			}
		}

		return devPath;
	}

	// Use common platform config directory for production
	return join(configDir, "better-ccflare.db");
}

export function getLegacyDbPath(): string {
	const { getLegacyConfigDir } = require("@better-ccflare/config");
	const legacyConfigDir = getLegacyConfigDir();
	return join(legacyConfigDir, "ccflare.db");
}
