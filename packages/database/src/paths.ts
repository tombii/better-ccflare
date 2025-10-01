import { join } from "node:path";
import { getPlatformConfigDir } from "@better-ccflare/config";

export function resolveDbPath(): string {
	// Check for explicit DB path from environment (support both old and new env var names)
	const explicitPath =
		process.env.BETTER_CCFLARE_DB_PATH || process.env.ccflare_DB_PATH;
	if (explicitPath) {
		return explicitPath;
	}

	// Use common platform config directory
	const configDir = getPlatformConfigDir();
	return join(configDir, "better-ccflare.db");
}

export function getLegacyDbPath(): string {
	const { getLegacyConfigDir } = require("@better-ccflare/config");
	const legacyConfigDir = getLegacyConfigDir();
	return join(legacyConfigDir, "ccflare.db");
}
