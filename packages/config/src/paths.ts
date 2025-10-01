import { join } from "node:path";
import { getPlatformConfigDir } from "./paths-common";

export function resolveConfigPath(): string {
	// Check for explicit config path from environment (support both old and new env var names)
	const explicitPath =
		process.env.BETTER_CCFLARE_CONFIG_PATH || process.env.ccflare_CONFIG_PATH;
	if (explicitPath) {
		return explicitPath;
	}

	// Use common platform config directory
	const configDir = getPlatformConfigDir();
	return join(configDir, "better-ccflare.json");
}
