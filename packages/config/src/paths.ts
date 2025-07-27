import { homedir } from "node:os";
import { join } from "node:path";
import { platform } from "node:process";

export function resolveConfigPath(): string {
	// Check for explicit config path from environment
	const explicitPath = process.env.CLAUDEFLARE_CONFIG_PATH;
	if (explicitPath) {
		return explicitPath;
	}

	// Determine config directory based on platform
	let configDir: string;

	if (platform === "win32") {
		// Windows: Use LOCALAPPDATA or APPDATA
		configDir =
			process.env.LOCALAPPDATA ??
			process.env.APPDATA ??
			join(homedir(), "AppData", "Local");
		return join(configDir, "claudeflare", "claudeflare.json");
	} else {
		// Linux/macOS: Follow XDG Base Directory specification
		const xdgConfig = process.env.XDG_CONFIG_HOME;
		configDir = xdgConfig ?? join(homedir(), ".config");
		return join(configDir, "claudeflare", "claudeflare.json");
	}
}
