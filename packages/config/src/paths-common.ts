import { homedir } from "node:os";
import { join } from "node:path";
import { platform } from "node:process";

/**
 * Get the platform-specific configuration directory for better-ccflare
 */
export function getPlatformConfigDir(): string {
	if (platform === "win32") {
		// Windows: Use LOCALAPPDATA or APPDATA
		const baseDir =
			process.env.LOCALAPPDATA ??
			process.env.APPDATA ??
			join(homedir(), "AppData", "Local");
		return join(baseDir, "better-ccflare");
	} else {
		// Linux/macOS: Follow XDG Base Directory specification
		const xdgConfig = process.env.XDG_CONFIG_HOME;
		const baseDir = xdgConfig ?? join(homedir(), ".config");
		return join(baseDir, "better-ccflare");
	}
}

/**
 * Get the legacy ccflare configuration directory for migration purposes
 */
export function getLegacyConfigDir(): string {
	if (platform === "win32") {
		const baseDir =
			process.env.LOCALAPPDATA ??
			process.env.APPDATA ??
			join(homedir(), "AppData", "Local");
		return join(baseDir, "ccflare");
	} else {
		const xdgConfig = process.env.XDG_CONFIG_HOME;
		const baseDir = xdgConfig ?? join(homedir(), ".config");
		return join(baseDir, "ccflare");
	}
}
