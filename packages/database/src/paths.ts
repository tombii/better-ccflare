import { join } from "node:path";
import { getPlatformConfigDir } from "@claudeflare/config";

export function resolveDbPath(): string {
	// Check for explicit DB path from environment
	const explicitPath = process.env.CLAUDEFLARE_DB_PATH;
	if (explicitPath) {
		return explicitPath;
	}

	// Use common platform config directory
	const configDir = getPlatformConfigDir();
	return join(configDir, "claudeflare.db");
}
