import { homedir } from "node:os";
import { join } from "node:path";
import { platform } from "node:process";

export function resolveDbPath(): string {
	// Check for explicit DB path from environment
	const explicitPath = process.env.CLAUDEFLARE_DB_PATH;
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
		return join(configDir, "claudeflare", "claude-accounts.db");
	} else {
		// Linux/macOS: Follow XDG Base Directory specification
		const xdgConfig = process.env.XDG_CONFIG_HOME;
		configDir = xdgConfig ?? join(homedir(), ".config");
		return join(configDir, "claudeflare", "claude-accounts.db");
	}
}
