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

	// Always use the same database path for consistency.
	// For development/testing, point at a different database with the
	// BETTER_CCFLARE_DB_PATH environment variable. Setting it also suppresses
	// the one-time import of a legacy ccflare.db (see migrate-from-ccflare.ts).
	return join(configDir, "better-ccflare.db");
}

export function getLegacyDbPath(): string {
	const { getLegacyConfigDir } = require("@better-ccflare/config");
	const legacyConfigDir = getLegacyConfigDir();
	return join(legacyConfigDir, "ccflare.db");
}
